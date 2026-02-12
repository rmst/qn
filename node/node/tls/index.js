/**
 * node:tls - Async TLS I/O module
 *
 * Drives BearSSL's non-blocking engine using the QuickJS event loop.
 * The C side (qn_tls) exposes thin wrappers around the BearSSL engine
 * state machine; this module provides the async I/O loop on top.
 *
 * All I/O goes through a transport object { read, write }. When a raw
 * socket fd is passed, it is automatically wrapped in an fd transport.
 */

import {
	tlsConnect as _tlsConnect, tlsAccept as _tlsAccept,
	tlsLoadCACerts, tlsCaCertCount, tlsLoadServerCert,
	tlsState, tlsError,
	tlsSendApp, tlsRecvApp, tlsFlush as _tlsFlush, tlsClose as _tlsClose,
	tlsGetSendRec, tlsSendRecAck, tlsRecvRecPush,
	TLS_CLOSED, TLS_SENDREC, TLS_RECVREC, TLS_SENDAPP, TLS_RECVAPP,
	EAGAIN as _EAGAIN,
} from 'qn_tls'
import * as os from 'os'

export {
	tlsLoadCACerts as loadCACerts,
	tlsCaCertCount as caCertCount,
	tlsLoadServerCert as loadServerCert,
}
export { TLS_CLOSED, TLS_SENDREC, TLS_RECVREC, TLS_SENDAPP, TLS_RECVAPP }
export const connect = _tlsConnect
export const accept = _tlsAccept

/** Create a TLS client context without a socket fd (for transport-based I/O) */
export function connectBuf(hostname) {
	return _tlsConnect(-1, hostname)
}

/** Create a TLS server context without a socket fd (for transport-based I/O) */
export function acceptBuf(cred) {
	return _tlsAccept(-1, cred)
}

function waitReadable(fd, signal) {
	if (signal?.aborted) return Promise.reject(signal.reason)
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			os.setReadHandler(fd, null)
			reject(signal.reason)
		}
		if (signal) signal.addEventListener('abort', onAbort, { once: true })
		os.setReadHandler(fd, () => {
			os.setReadHandler(fd, null)
			if (signal) signal.removeEventListener('abort', onAbort)
			resolve()
		})
	})
}

function waitWritable(fd, signal) {
	if (signal?.aborted) return Promise.reject(signal.reason)
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			os.setWriteHandler(fd, null)
			reject(signal.reason)
		}
		if (signal) signal.addEventListener('abort', onAbort, { once: true })
		os.setWriteHandler(fd, () => {
			os.setWriteHandler(fd, null)
			if (signal) signal.removeEventListener('abort', onAbort)
			resolve()
		})
	})
}

/** Wrap a socket fd as a transport { read, write } */
function fdTransport(fd) {
	return {
		async read({ signal } = {}) {
			const buf = new ArrayBuffer(16384)
			for (;;) {
				const n = os.read(fd, buf, 0, buf.byteLength)
				if (n === 0) return null
				if (n > 0) return new Uint8Array(buf, 0, n)
				if (n === -_EAGAIN) { await waitReadable(fd, signal); continue }
				throw new Error('TLS: socket read error')
			}
		},
		async write(data, { signal } = {}) {
			let off = data.byteOffset
			let rem = data.byteLength
			while (rem > 0) {
				const n = os.write(fd, data.buffer, off, rem)
				if (n > 0) { off += n; rem -= n; continue }
				if (n === -_EAGAIN) { await waitWritable(fd, signal); continue }
				throw new Error('TLS: socket write error')
			}
		},
	}
}

/** Leftover state for connections */
const _recvState = new WeakMap()

/**
 * Core engine driver: pumps record I/O through transport until condition
 * is met or engine closes. Wraps raw fds into a transport automatically.
 */
async function drive(conn, fdOrTransport, condition, signal) {
	const transport = typeof fdOrTransport === 'number' ? fdTransport(fdOrTransport) : fdOrTransport
	let rs = _recvState.get(conn)
	if (!rs) { rs = { leftover: null }; _recvState.set(conn, rs) }
	for (;;) {
		if (signal?.aborted) throw signal.reason
		const state = tlsState(conn)
		if (condition(state)) return state
		if (state & TLS_CLOSED) return state
		if (state & TLS_SENDREC) {
			const data = tlsGetSendRec(conn)
			if (data && data.byteLength > 0) {
				await transport.write(new Uint8Array(data), { signal })
				tlsSendRecAck(conn, data.byteLength)
			}
			continue
		}
		if (state & TLS_RECVREC) {
			if (rs.leftover) {
				const lo = rs.leftover
				const n = tlsRecvRecPush(conn, lo.buffer, lo.byteOffset, lo.byteLength)
				rs.leftover = n >= lo.byteLength ? null : lo.subarray(n)
			} else {
				const chunk = await transport.read({ signal })
				if (!chunk) { _tlsClose(conn); continue }
				const n = tlsRecvRecPush(conn, chunk.buffer, chunk.byteOffset, chunk.byteLength)
				if (n < chunk.byteLength) rs.leftover = chunk.subarray(n)
			}
			continue
		}
	}
}

/**
 * Perform TLS handshake asynchronously.
 * Drives the engine until SENDAPP is available (handshake complete).
 */
export async function handshake(conn, fdOrTransport, signal) {
	const state = await drive(conn, fdOrTransport, s => s & TLS_SENDAPP, signal)
	if (!(state & TLS_SENDAPP)) {
		const err = tlsError(conn)
		throw new Error('TLS handshake failed' + (err ? ': error ' + err : ''))
	}
}

/**
 * Write all data over TLS asynchronously.
 * Handles partial sends and flushes automatically.
 */
export async function writeAll(conn, fdOrTransport, data, signal) {
	const ab = data.buffer
	let off = data.byteOffset
	let rem = data.byteLength
	while (rem > 0) {
		const state = await drive(conn, fdOrTransport, s => (s & TLS_SENDAPP) || (s & TLS_CLOSED), signal)
		if (state & TLS_CLOSED) throw new Error('TLS: connection closed during write')
		const n = tlsSendApp(conn, ab, off, rem)
		off += n
		rem -= n
		if (rem > 0) _tlsFlush(conn, 0)
	}
	_tlsFlush(conn, 0)
	await drive(conn, fdOrTransport, s => !(s & TLS_SENDREC), signal)
}

/**
 * Read decrypted data from TLS connection asynchronously.
 * Returns number of bytes read, or 0 for EOF.
 */
export async function read(conn, fdOrTransport, buf, off, len, signal) {
	const state = await drive(conn, fdOrTransport, s => (s & TLS_RECVAPP) || (s & TLS_CLOSED), signal)
	if (state & TLS_RECVAPP) return tlsRecvApp(conn, buf, off, len)
	return 0
}

/**
 * Flush buffered TLS data and pump it to the network.
 */
export async function flush(conn, fdOrTransport, signal) {
	_tlsFlush(conn, 0)
	await drive(conn, fdOrTransport, s => !(s & TLS_SENDREC), signal)
}

/**
 * Close TLS connection gracefully (sends close_notify).
 */
export async function close(conn, fdOrTransport) {
	const transport = typeof fdOrTransport === 'number' ? fdTransport(fdOrTransport) : fdOrTransport
	_tlsClose(conn)
	try {
		for (;;) {
			const state = tlsState(conn)
			if (!(state & TLS_SENDREC)) break
			const data = tlsGetSendRec(conn)
			if (!data || data.byteLength === 0) break
			await transport.write(new Uint8Array(data))
			tlsSendRecAck(conn, data.byteLength)
		}
	} catch {
		// Ignore errors during close - peer may have disconnected
	}
}

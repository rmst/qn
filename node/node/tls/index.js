/**
 * node:tls - Async TLS I/O module
 *
 * Drives BearSSL's non-blocking engine using the QuickJS event loop.
 * The C side (qn_tls) exposes thin wrappers around the BearSSL engine
 * state machine; this module provides the async I/O loop on top.
 *
 * All I/O goes through a transport object { read, write } created from
 * libuv stream handles via streamTransport().
 */

import {
	tlsConnect as _tlsConnect, tlsAccept as _tlsAccept,
	tlsLoadCACerts, tlsCaCertCount, tlsLoadServerCert,
	tlsState, tlsError,
	tlsSendApp, tlsRecvApp, tlsFlush as _tlsFlush, tlsClose as _tlsClose,
	tlsGetSendRec, tlsSendRecAck, tlsRecvRecPush,
	TLS_CLOSED, TLS_SENDREC, TLS_RECVREC, TLS_SENDAPP, TLS_RECVAPP,
} from 'qn_tls'
import {
	readStart, readStop, write as _streamWrite,
	close as _streamClose, setOnRead,
} from 'qn/uv-stream'

export {
	tlsLoadCACerts as loadCACerts,
	tlsCaCertCount as caCertCount,
	tlsLoadServerCert as loadServerCert,
}
export { TLS_CLOSED, TLS_SENDREC, TLS_RECVREC, TLS_SENDAPP, TLS_RECVAPP }

/** Create a TLS client context (transport-based, no fd). */
export function connect(hostname) {
	return _tlsConnect(-1, hostname)
}

/** Create a TLS server context (transport-based, no fd). */
export function accept(cred) {
	return _tlsAccept(-1, cred)
}

/* ---- libuv stream-based transport ---- */

/**
 * Create a transport { read, write } from a libuv stream handle.
 * The read side uses one-shot reads: start reading, resolve on first chunk, stop.
 */
export function streamTransport(handle) {
	let pendingResolve = null
	let pendingReject = null
	let buffered = null
	let eof = false

	setOnRead(handle, (buf, err) => {
		if (err) {
			readStop(handle)
			if (pendingReject) {
				const rej = pendingReject
				pendingResolve = pendingReject = null
				rej(new Error('TLS: stream read error'))
			}
			return
		}
		if (buf === null) {
			eof = true
			readStop(handle)
			if (pendingResolve) {
				const res = pendingResolve
				pendingResolve = pendingReject = null
				res(null)
			}
			return
		}
		/* Got data — stop reading and deliver */
		readStop(handle)
		const chunk = new Uint8Array(buf)
		if (pendingResolve) {
			const res = pendingResolve
			pendingResolve = pendingReject = null
			res(chunk)
		} else {
			buffered = chunk
		}
	})

	return {
		read({ signal } = {}) {
			if (buffered) {
				const b = buffered
				buffered = null
				return Promise.resolve(b)
			}
			if (eof) return Promise.resolve(null)
			if (signal?.aborted) return Promise.reject(signal.reason)
			return new Promise((resolve, reject) => {
				pendingResolve = resolve
				pendingReject = reject
				if (signal) {
					signal.addEventListener('abort', () => {
						readStop(handle)
						pendingResolve = pendingReject = null
						reject(signal.reason)
					}, { once: true })
				}
				readStart(handle)
			})
		},
		write(data, { signal } = {}) {
			if (signal?.aborted) return Promise.reject(signal.reason)
			return _streamWrite(handle, data)
		},
	}
}

/** Leftover state for connections */
const _recvState = new WeakMap()

/**
 * Core engine driver: pumps record I/O through transport until condition
 * is met or engine closes.
 */
async function drive(conn, transport, condition, signal) {
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
export async function handshake(conn, transport, signal) {
	const state = await drive(conn, transport, s => s & TLS_SENDAPP, signal)
	if (!(state & TLS_SENDAPP)) {
		const err = tlsError(conn)
		throw new Error('TLS handshake failed' + (err ? ': error ' + err : ''))
	}
}

/**
 * Write all data over TLS asynchronously.
 * Handles partial sends and flushes automatically.
 */
export async function writeAll(conn, transport, data, signal) {
	const ab = data.buffer
	let off = data.byteOffset
	let rem = data.byteLength
	while (rem > 0) {
		const state = await drive(conn, transport, s => (s & TLS_SENDAPP) || (s & TLS_CLOSED), signal)
		if (state & TLS_CLOSED) throw new Error('TLS: connection closed during write')
		const n = tlsSendApp(conn, ab, off, rem)
		off += n
		rem -= n
		if (rem > 0) _tlsFlush(conn, 0)
	}
	_tlsFlush(conn, 0)
	await drive(conn, transport, s => !(s & TLS_SENDREC), signal)
}

/**
 * Read decrypted data from TLS connection asynchronously.
 * Returns number of bytes read, or 0 for EOF.
 */
export async function read(conn, transport, buf, off, len, signal) {
	const state = await drive(conn, transport, s => (s & TLS_RECVAPP) || (s & TLS_CLOSED), signal)
	if (state & TLS_RECVAPP) return tlsRecvApp(conn, buf, off, len)
	return 0
}

/**
 * Flush buffered TLS data and pump it to the network.
 */
export async function flush(conn, transport, signal) {
	_tlsFlush(conn, 0)
	await drive(conn, transport, s => !(s & TLS_SENDREC), signal)
}

/**
 * Close TLS connection gracefully (sends close_notify).
 */
export async function close(conn, transport) {
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

/**
 * node:tls - Async TLS I/O module
 *
 * Drives BearSSL's non-blocking engine using the QuickJS event loop.
 * The C side (qn_tls) exposes thin wrappers around the BearSSL engine
 * state machine; this module provides the async I/O loop on top.
 */

import {
	tlsConnect as _tlsConnect, tlsAccept as _tlsAccept,
	tlsLoadCACerts, tlsCaCertCount, tlsLoadServerCert,
	tlsState, tlsError, tlsPumpRead, tlsPumpWrite,
	tlsSendApp, tlsRecvApp, tlsFlush as _tlsFlush, tlsClose as _tlsClose,
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

function waitReadable(fd) {
	return new Promise(resolve => {
		os.setReadHandler(fd, () => {
			os.setReadHandler(fd, null)
			resolve()
		})
	})
}

function waitWritable(fd) {
	return new Promise(resolve => {
		os.setWriteHandler(fd, () => {
			os.setWriteHandler(fd, null)
			resolve()
		})
	})
}

/**
 * Core engine driver: pumps record I/O until condition is met or engine closes.
 * Returns the engine state that satisfied the condition (or TLS_CLOSED).
 */
async function drive(conn, fd, condition) {
	for (;;) {
		const state = tlsState(conn)
		if (condition(state)) return state
		if (state & TLS_CLOSED) return state
		if (state & TLS_SENDREC) {
			const n = tlsPumpWrite(conn)
			if (n === -_EAGAIN) await waitWritable(fd)
			else if (n < 0) throw new Error('TLS: socket write error')
			continue
		}
		if (state & TLS_RECVREC) {
			const n = tlsPumpRead(conn)
			if (n === -_EAGAIN) await waitReadable(fd)
			else if (n === 0) _tlsClose(conn)
			else if (n < 0) throw new Error('TLS: socket read error')
			continue
		}
	}
}

/**
 * Perform TLS handshake asynchronously.
 * Drives the engine until SENDAPP is available (handshake complete).
 */
export async function handshake(conn, fd) {
	const state = await drive(conn, fd, s => s & TLS_SENDAPP)
	if (!(state & TLS_SENDAPP)) {
		const err = tlsError(conn)
		throw new Error('TLS handshake failed' + (err ? ': error ' + err : ''))
	}
}

/**
 * Write all data over TLS asynchronously.
 * Handles partial sends and flushes automatically.
 */
export async function writeAll(conn, fd, data) {
	const ab = data.buffer
	let off = data.byteOffset
	let rem = data.byteLength
	while (rem > 0) {
		const state = await drive(conn, fd, s => (s & TLS_SENDAPP) || (s & TLS_CLOSED))
		if (state & TLS_CLOSED) throw new Error('TLS: connection closed during write')
		const n = tlsSendApp(conn, ab, off, rem)
		off += n
		rem -= n
		if (rem > 0) _tlsFlush(conn, 0)
	}
	_tlsFlush(conn, 0)
	await drive(conn, fd, s => !(s & TLS_SENDREC))
}

/**
 * Read decrypted data from TLS connection asynchronously.
 * Returns number of bytes read, or 0 for EOF.
 */
export async function read(conn, fd, buf, off, len) {
	const state = await drive(conn, fd, s => (s & TLS_RECVAPP) || (s & TLS_CLOSED))
	if (state & TLS_RECVAPP) return tlsRecvApp(conn, buf, off, len)
	return 0
}

/**
 * Flush buffered TLS data and pump it to the network.
 */
export async function flush(conn, fd) {
	_tlsFlush(conn, 0)
	await drive(conn, fd, s => !(s & TLS_SENDREC))
}

/**
 * Close TLS connection gracefully (sends close_notify).
 */
export async function close(conn, fd) {
	_tlsClose(conn)
	try {
		for (;;) {
			const state = tlsState(conn)
			if (!(state & TLS_SENDREC)) break
			const n = tlsPumpWrite(conn)
			if (n === -_EAGAIN) await waitWritable(fd)
			else if (n < 0) break
		}
	} catch {
		// Ignore errors during close - peer may have disconnected
	}
}

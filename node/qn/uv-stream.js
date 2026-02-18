/*
 * qn:uv-stream - Typed JS wrappers over the single-dispatch C _op function.
 *
 * This module is the JS-side API for qn_uv_stream. It provides named functions
 * that call _op(opcode, ...args).
 */

import {
	_op,
	TCP_NEW, TCP_BIND, LISTEN, TCP_CONNECT,
	READ_START, READ_STOP, WRITE, SHUTDOWN, CLOSE, FILENO,
	TCP_NODELAY, TCP_KEEPALIVE, TCP_GETSOCKNAME, TCP_GETPEERNAME,
	SET_ON_READ, SET_ON_CONNECTION, SET_ON_CONNECT, SET_ON_SHUTDOWN,
	AF_INET, AF_INET6,
} from 'qn_uv_stream'

export { AF_INET, AF_INET6 }

/* TCP handle creation */
export const tcpNew         = (family) => _op(TCP_NEW, family)
export const tcpBind        = (handle, host, port) => _op(TCP_BIND, handle, host, port)
export const listen         = (handle, backlog) => _op(LISTEN, handle, backlog)
export const tcpConnect     = (handle, host, port) => _op(TCP_CONNECT, handle, host, port)

/* Stream I/O */
export const readStart      = (handle) => _op(READ_START, handle)
export const readStop       = (handle) => _op(READ_STOP, handle)
export const write          = (handle, buf) => _op(WRITE, handle, buf)
export const shutdown       = (handle) => _op(SHUTDOWN, handle)
export const close          = (handle) => _op(CLOSE, handle)

/* Handle properties */
export const fileno         = (handle) => _op(FILENO, handle)
export const tcpNodelay     = (handle, enable) => _op(TCP_NODELAY, handle, enable)
export const tcpKeepalive   = (handle, enable) => _op(TCP_KEEPALIVE, handle, enable)
export const tcpGetsockname = (handle) => _op(TCP_GETSOCKNAME, handle)
export const tcpGetpeername = (handle) => _op(TCP_GETPEERNAME, handle)

/* Callback setters */
export const setOnRead       = (handle, fn) => _op(SET_ON_READ, handle, fn)
export const setOnConnection = (handle, fn) => _op(SET_ON_CONNECTION, handle, fn)
export const setOnConnect    = (handle, fn) => _op(SET_ON_CONNECT, handle, fn)
export const setOnShutdown   = (handle, fn) => _op(SET_ON_SHUTDOWN, handle, fn)

/*
 * qn:uv-dgram - Typed JS wrappers over the single-dispatch C _op function.
 *
 * This module is the JS-side API for qn_uv_dgram. It provides named functions
 * that call _op(opcode, ...args).
 */

import {
	_op,
	NEW, BIND, SEND, RECV_START, RECV_STOP, CLOSE, GETSOCKNAME,
	SET_BROADCAST, SET_TTL, SET_MULTICAST_TTL, SET_MULTICAST_LOOPBACK,
	SET_ON_MESSAGE,
	AF_INET, AF_INET6, UV_UDP_REUSEADDR,
} from 'qn_uv_dgram'

export { AF_INET, AF_INET6, UV_UDP_REUSEADDR }

/* Handle creation */
export const udpNew           = (family) => _op(NEW, family)
export const udpBind          = (handle, host, port, flags) => _op(BIND, handle, host, port, flags)

/* Send data (returns Promise) */
export const udpSend          = (handle, buf, host, port, offset, length) => _op(SEND, handle, buf, host, port, offset, length)

/* Receive */
export const recvStart        = (handle) => _op(RECV_START, handle)
export const recvStop         = (handle) => _op(RECV_STOP, handle)

/* Lifecycle */
export const close            = (handle) => _op(CLOSE, handle)

/* Handle properties */
export const getsockname      = (handle) => _op(GETSOCKNAME, handle)
export const setBroadcast     = (handle, enable) => _op(SET_BROADCAST, handle, enable)
export const setTTL           = (handle, ttl) => _op(SET_TTL, handle, ttl)
export const setMulticastTTL  = (handle, ttl) => _op(SET_MULTICAST_TTL, handle, ttl)
export const setMulticastLoopback = (handle, enable) => _op(SET_MULTICAST_LOOPBACK, handle, enable)

/* Callback setter */
export const setOnMessage     = (handle, fn) => _op(SET_ON_MESSAGE, handle, fn)

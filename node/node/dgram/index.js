/**
 * node:dgram - UDP datagram sockets
 * @see https://nodejs.org/api/dgram.html
 *
 * Built on top of libuv UDP (qn:uv-dgram) for event-loop-integrated async I/O.
 */

import { EventEmitter } from 'node:events'
import {
	udpNew, udpBind, udpSend, recvStart, recvStop,
	close as _close, getsockname,
	setBroadcast as _setBroadcast, setTTL as _setTTL,
	setMulticastTTL as _setMulticastTTL, setMulticastLoopback as _setMulticastLoopback,
	setOnMessage, AF_INET, AF_INET6, UV_UDP_REUSEADDR,
} from 'qn/uv-dgram'

/* Address format conversion: C module returns { family: 4|6, ip, port }
 * Node.js dgram expects { address, port, family: "IPv4"|"IPv6" } */
function formatAddr(raw) {
	if (!raw) return null
	return {
		address: raw.ip,
		port: raw.port,
		family: raw.family === 6 ? 'IPv6' : 'IPv4',
	}
}

/**
 * UDP Socket
 *
 * Events: 'message', 'listening', 'close', 'error'
 */
export class Socket extends EventEmitter {
	#handle = null
	#bound = false
	#receiving = false
	#closed = false
	#type

	constructor(options) {
		super()
		if (typeof options === 'string') {
			options = { type: options }
		}
		this.#type = options.type || 'udp4'
		const family = this.#type === 'udp6' ? AF_INET6 : AF_INET
		this.#handle = udpNew(family)

		setOnMessage(this.#handle, (buf, rinfo, err) => {
			if (this.#closed) return
			if (err) {
				this.emit('error', err)
				return
			}
			this.emit('message', buf, formatAddr(rinfo))
		})

		if (options.reuseAddr || options.reusePort) {
			// Will be applied during bind
			this._reuseAddr = true
		}
	}

	bind(port, address, callback) {
		if (typeof port === 'object' && port !== null) {
			const options = port
			callback = address
			port = options.port
			address = options.address
		}
		if (typeof port === 'function') {
			callback = port
			port = 0
			address = undefined
		}
		if (typeof address === 'function') {
			callback = address
			address = undefined
		}

		port = port || 0
		address = address || (this.#type === 'udp6' ? '::' : '0.0.0.0')

		if (callback) this.once('listening', callback)

		try {
			const flags = this._reuseAddr ? UV_UDP_REUSEADDR : 0
			udpBind(this.#handle, address, port, flags)
			this.#bound = true
			this.#startReceiving()
			queueMicrotask(() => this.emit('listening'))
		} catch (e) {
			queueMicrotask(() => this.emit('error', e))
		}

		return this
	}

	#startReceiving() {
		if (this.#receiving || this.#closed) return
		this.#receiving = true
		recvStart(this.#handle)
	}

	send(msg, offset, length, port, address, callback) {
		/* Handle overloaded signatures:
		 * send(msg, port, address, callback)
		 * send(msg, offset, length, port, address, callback) */
		if (typeof offset === 'number' && typeof length === 'number') {
			// Full signature: send(msg, offset, length, port, address, callback)
		} else {
			// Short signature: send(msg, port, address, callback)
			// In function params: offset=port, length=address, port=callback
			callback = port
			address = length
			port = offset
			offset = undefined
			length = undefined
		}

		if (typeof address === 'function') {
			callback = address
			address = undefined
		}

		if (typeof msg === 'string') {
			msg = new TextEncoder().encode(msg)
		} else if (msg instanceof ArrayBuffer) {
			msg = new Uint8Array(msg)
		} else if (!(msg instanceof Uint8Array)) {
			msg = new Uint8Array(msg)
		}

		/* If not bound yet, auto-bind to ephemeral port */
		if (!this.#bound) {
			try {
				const bindAddr = this.#type === 'udp6' ? '::' : '0.0.0.0'
				udpBind(this.#handle, bindAddr, 0, 0)
				this.#bound = true
				this.#startReceiving()
			} catch (e) {
				if (callback) callback(e)
				else this.emit('error', e)
				return
			}
		}

		const host = address || (this.#type === 'udp6' ? '::1' : '127.0.0.1')
		udpSend(this.#handle, msg, host, port, offset, length)
			.then(() => { if (callback) callback(null) })
			.catch(err => {
				if (callback) callback(err)
				else this.emit('error', err)
			})
	}

	close(callback) {
		if (this.#closed) return this
		this.#closed = true

		if (callback) this.once('close', callback)

		if (this.#receiving) {
			this.#receiving = false
			recvStop(this.#handle)
		}

		if (this.#handle) {
			_close(this.#handle)
			this.#handle = null
		}

		queueMicrotask(() => this.emit('close'))
		return this
	}

	address() {
		if (!this.#handle) return null
		try {
			return formatAddr(getsockname(this.#handle))
		} catch (e) {
			return null
		}
	}

	setBroadcast(flag) {
		if (this.#handle) _setBroadcast(this.#handle, flag)
		return this
	}

	setTTL(ttl) {
		if (this.#handle) _setTTL(this.#handle, ttl)
		return this
	}

	setMulticastTTL(ttl) {
		if (this.#handle) _setMulticastTTL(this.#handle, ttl)
		return this
	}

	setMulticastLoopback(flag) {
		if (this.#handle) _setMulticastLoopback(this.#handle, flag)
		return this
	}

	ref() { return this }
	unref() { return this }
}

/**
 * Create a UDP socket.
 * @param {string|object} type - 'udp4', 'udp6', or options object
 * @param {function} [callback] - Attached as 'message' listener
 */
export function createSocket(type, callback) {
	const options = typeof type === 'string' ? { type } : type
	const socket = new Socket(options)
	if (callback) socket.on('message', callback)
	return socket
}

export default {
	Socket,
	createSocket,
}

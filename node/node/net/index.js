/**
 * node:net - TCP networking module
 * @see https://nodejs.org/api/net.html
 *
 * Built on top of libuv streams (qn:uv-stream) for event-loop-integrated
 * async I/O, and libuv DNS (qn_uv_dns) for name resolution.
 */

import { EventEmitter } from 'node:events'
import {
	tcpNew, tcpBind, listen as _listen, tcpConnect,
	readStart, readStop, write as _write, shutdown as _shutdown, close as _close,
	fileno, tcpNodelay, tcpKeepalive,
	tcpGetsockname, tcpGetpeername,
	setOnRead, setOnConnection, setOnConnect, setOnShutdown,
	AF_INET, AF_INET6,
} from 'qn/uv-stream'
import { getaddrinfo as _getaddrinfo } from 'qn_uv_dns'

export { AF_INET, AF_INET6 }

/* Address format conversion: C module returns { family: 4|6, ip, port }
 * Node.js net expects { address, port, family: "IPv4"|"IPv6" } */
function formatAddr(raw) {
	if (!raw) return null
	return {
		address: raw.ip,
		port: raw.port,
		family: raw.family === 6 ? 'IPv6' : 'IPv4',
	}
}

/**
 * TCP Socket - represents a single TCP connection.
 *
 * Events: 'connect', 'data', 'end', 'close', 'error', 'drain'
 */
export class Socket extends EventEmitter {
	#handle = null
	#writeBuf = []
	#writing = false
	#connecting = false
	#connected = false
	#destroyed = false
	#ended = false
	#allowHalfOpen = false
	remoteAddress = null
	remotePort = null
	remoteFamily = null
	localAddress = null
	localPort = null

	constructor(options = {}) {
		super()
		this.#allowHalfOpen = options.allowHalfOpen || false
		if (options._handle !== undefined) {
			this.#handle = options._handle
			this.#connected = true
			this.#setupRemoteInfo()
			this.#startReading()
		}
	}

	get readyState() {
		if (this.#connecting) return 'opening'
		if (this.#connected) return 'open'
		return 'closed'
	}

	#setupRemoteInfo() {
		try {
			const peer = formatAddr(tcpGetpeername(this.#handle))
			if (peer) {
				this.remoteAddress = peer.address
				this.remotePort = peer.port
				this.remoteFamily = peer.family
			}
		} catch (e) {
			// ignore - may not be connected yet
		}
		try {
			const local = formatAddr(tcpGetsockname(this.#handle))
			if (local) {
				this.localAddress = local.address
				this.localPort = local.port
			}
		} catch (e) {
			// ignore
		}
	}

	#startReading() {
		setOnRead(this.#handle, (buf, err) => {
			if (this.#destroyed) return
			if (err) {
				this.#emitError(err)
				return
			}
			if (buf === null) {
				// EOF
				readStop(this.#handle)
				this.#ended = true
				this.emit('end')
				if (!this.#allowHalfOpen) {
					this.end()
				}
				return
			}
			this.emit('data', buf)
		})
		readStart(this.#handle)
	}

	connect(options, callback) {
		if (typeof options === 'number') {
			options = { port: options, host: arguments[1] }
			callback = arguments[2]
		}
		if (typeof options === 'string') {
			options = { path: options }
			callback = arguments[1]
		}

		const port = options.port
		const host = options.host || '127.0.0.1'

		if (callback) this.once('connect', callback)

		this.#connecting = true
		this.#doConnect(host, port)

		return this
	}

	async #doConnect(host, port) {
		let addresses
		try {
			addresses = await _getaddrinfo(host, port, { family: AF_INET })
			if (this.#destroyed) return
			if (addresses.length === 0) {
				addresses = await _getaddrinfo(host, port)
			}
		} catch (e) {
			if (this.#destroyed) return
			this.#emitError(e)
			return
		}

		if (this.#destroyed) return

		const addr = addresses[0]
		try {
			this.#handle = tcpNew(addr.family)
		} catch (e) {
			this.#emitError(e)
			return
		}

		try {
			setOnConnect(this.#handle, (err) => {
				if (this.#destroyed) return
				if (err) {
					this.#connecting = false
					this.#emitError(err)
					return
				}
				this.#connecting = false
				this.#connected = true
				this.#setupRemoteInfo()
				this.#startReading()
				this.emit('connect')
			})
			tcpConnect(this.#handle, addr.address, port)
		} catch (e) {
			this.#emitError(e)
		}
	}

	write(data, encoding, callback) {
		if (typeof encoding === 'function') {
			callback = encoding
			encoding = undefined
		}
		if (this.#destroyed || this.#ended) {
			const err = new Error('write after end')
			if (callback) callback(err)
			return false
		}

		const chunk = typeof data === 'string'
			? new TextEncoder().encode(data)
			: data instanceof Uint8Array
				? data
				: new Uint8Array(data)

		this.#writeBuf.push({ chunk, callback })
		this.#flush()
		return this.#writeBuf.length === 0
	}

	async #flush() {
		if (this.#writing || this.#writeBuf.length === 0 || !this.#handle) return

		this.#writing = true
		while (this.#writeBuf.length > 0 && !this.#destroyed) {
			const cur = this.#writeBuf[0]
			try {
				await _write(this.#handle, cur.chunk)
				this.#writeBuf.shift()
				if (cur.callback) cur.callback(null)
			} catch (e) {
				this.#writing = false
				this.#emitError(e)
				return
			}
		}
		this.#writing = false
		if (!this.#destroyed) this.emit('drain')
	}

	end(data, encoding, callback) {
		if (typeof data === 'function') {
			callback = data
			data = undefined
		}
		if (typeof encoding === 'function') {
			callback = encoding
			encoding = undefined
		}

		if (data !== undefined && data !== null) {
			this.write(data, encoding)
		}

		if (callback) this.once('finish', callback)

		const doEnd = () => {
			if (this.#writeBuf.length > 0) {
				this.once('drain', doEnd)
				return
			}
			if (this.#handle && this.#connected) {
				setOnShutdown(this.#handle, (err) => {
					this.emit('finish')
					if (this.#ended || !this.#allowHalfOpen) {
						this.destroy()
					}
				})
				try {
					_shutdown(this.#handle)
				} catch (e) {
					// ignore errors during shutdown
					this.emit('finish')
					if (this.#ended || !this.#allowHalfOpen) {
						this.destroy()
					}
				}
			} else {
				this.emit('finish')
				if (this.#ended || !this.#allowHalfOpen) {
					this.destroy()
				}
			}
		}

		doEnd()
		return this
	}

	destroy(err) {
		if (this.#destroyed) return this
		this.#destroyed = true

		if (this.#handle) {
			_close(this.#handle)
			this.#handle = null
		}

		this.#connected = false
		this.#connecting = false
		this.#writeBuf = []

		if (err) this.emit('error', err)
		this.emit('close', !!err)
		return this
	}

	setNoDelay(noDelay = true) {
		if (this.#handle) {
			tcpNodelay(this.#handle, noDelay)
		}
		return this
	}

	setKeepAlive(enable = false) {
		if (this.#handle) {
			tcpKeepalive(this.#handle, enable)
		}
		return this
	}

	address() {
		if (!this.#handle) return null
		try {
			return formatAddr(tcpGetsockname(this.#handle))
		} catch (e) {
			return null
		}
	}

	ref() { return this }
	unref() { return this }

	#emitError(err) {
		if (this.listenerCount('error') > 0) {
			this.emit('error', err)
		}
		this.destroy()
	}
}

/**
 * TCP Server
 *
 * Events: 'listening', 'connection', 'close', 'error'
 */
export class Server extends EventEmitter {
	#handle = null
	#listening = false
	#closed = false
	#connections = new Set()

	constructor(options, connectionListener) {
		super()
		if (typeof options === 'function') {
			connectionListener = options
			options = {}
		}
		if (connectionListener) {
			this.on('connection', connectionListener)
		}
	}

	listen(port, host, backlog, callback) {
		if (typeof port === 'object') {
			const options = port
			callback = host
			port = options.port
			host = options.host
			backlog = options.backlog
		}
		if (typeof host === 'function') {
			callback = host
			host = undefined
			backlog = undefined
		}
		if (typeof backlog === 'function') {
			callback = backlog
			backlog = undefined
		}

		host = host || '0.0.0.0'
		backlog = backlog || 128

		if (callback) this.once('listening', callback)

		try {
			const family = host.includes(':') ? AF_INET6 : AF_INET
			this.#handle = tcpNew(family)
			tcpBind(this.#handle, host, port)

			setOnConnection(this.#handle, (clientHandle) => {
				if (clientHandle instanceof Error) {
					if (this.listenerCount('error') > 0) {
						this.emit('error', clientHandle)
					}
					return
				}
				const sock = new Socket({ _handle: clientHandle })
				this.#connections.add(sock)
				sock.on('close', () => this.#connections.delete(sock))
				this.emit('connection', sock)
			})

			_listen(this.#handle, backlog)
			this.#listening = true

			queueMicrotask(() => this.emit('listening'))
		} catch (e) {
			queueMicrotask(() => {
				if (this.listenerCount('error') > 0) {
					this.emit('error', e)
				} else {
					throw e
				}
			})
		}

		return this
	}

	address() {
		if (!this.#handle) return null
		try {
			return formatAddr(tcpGetsockname(this.#handle))
		} catch (e) {
			return null
		}
	}

	close(callback) {
		if (this.#closed) return this
		this.#closed = true

		if (callback) this.once('close', callback)

		if (this.#handle) {
			_close(this.#handle)
			this.#handle = null
		}
		this.#listening = false

		// Destroy all active connections
		for (const conn of this.#connections) {
			conn.destroy()
		}
		this.#connections.clear()

		queueMicrotask(() => this.emit('close'))
		return this
	}

	ref() { return this }
	unref() { return this }

	get listening() { return this.#listening }
}

/**
 * Create a TCP server.
 */
export function createServer(options, connectionListener) {
	return new Server(options, connectionListener)
}

/**
 * Create a TCP connection.
 */
export function createConnection(options, callback) {
	if (typeof options === 'number') {
		options = { port: options, host: arguments[1] }
		callback = arguments[2]
	}
	const sock = new Socket()
	return sock.connect(options, callback)
}

export const connect = createConnection

export default {
	Socket,
	Server,
	createServer,
	createConnection,
	connect,
}

/**
 * node:net - TCP networking module
 * @see https://nodejs.org/api/net.html
 *
 * Built on top of the qn_socket native module for POSIX socket syscalls
 * and the QuickJS os module for event loop integration (setReadHandler/setWriteHandler).
 */

import { EventEmitter } from 'node:events'
import * as os from 'os'
import {
	socket as _socket, bind as _bind, listen as _listen,
	accept as _accept, connect as _connect, connectFinish as _connectFinish,
	setsockopt as _setsockopt, getsockname as _getsockname,
	getpeername as _getpeername, shutdown as _shutdown,
	getaddrinfo as _getaddrinfo, send as _send, recv as _recv,
	AF_INET, AF_INET6, SOCK_STREAM, SOL_SOCKET, IPPROTO_TCP,
	SO_REUSEADDR, TCP_NODELAY, SHUT_WR, SHUT_RDWR, EAGAIN, EINPROGRESS,
} from 'qn_socket'

export { AF_INET, AF_INET6, SOCK_STREAM }

const BUFFER_SIZE = 65536

/**
 * TCP Socket - represents a single TCP connection.
 *
 * Events: 'connect', 'data', 'end', 'close', 'error', 'drain'
 */
export class Socket extends EventEmitter {
	#fd = -1
	#readBuf = new ArrayBuffer(BUFFER_SIZE)
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
		if (options._fd !== undefined) {
			this.#fd = options._fd
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
			const peer = _getpeername(this.#fd)
			this.remoteAddress = peer.address
			this.remotePort = peer.port
			this.remoteFamily = peer.family === AF_INET6 ? 'IPv6' : 'IPv4'
		} catch (e) {
			// ignore - may not be connected yet
		}
		try {
			const local = _getsockname(this.#fd)
			this.localAddress = local.address
			this.localPort = local.port
		} catch (e) {
			// ignore
		}
	}

	#startReading() {
		os.setReadHandler(this.#fd, () => {
			if (this.#destroyed) return
			const n = _recv(this.#fd, this.#readBuf, 0, BUFFER_SIZE)
			if (n === -EAGAIN) return
			if (n <= 0) {
				// EOF or error
				os.setReadHandler(this.#fd, null)
				this.#ended = true
				this.emit('end')
				if (!this.#allowHalfOpen) {
					this.end()
				}
				return
			}
			const chunk = new Uint8Array(this.#readBuf.slice(0, n))
			this.emit('data', chunk)
		})
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

		// Resolve hostname, then connect
		let addresses
		try {
			addresses = _getaddrinfo(host, port, { family: AF_INET })
			if (addresses.length === 0) {
				addresses = _getaddrinfo(host, port)
			}
		} catch (e) {
			queueMicrotask(() => this.#emitError(e))
			return this
		}

		const addr = addresses[0]
		try {
			this.#fd = _socket(addr.family, SOCK_STREAM)
		} catch (e) {
			queueMicrotask(() => this.#emitError(e))
			return this
		}

		try {
			const ret = _connect(this.#fd, addr.address, port)
			if (ret === -EINPROGRESS) {
				os.setWriteHandler(this.#fd, () => {
					os.setWriteHandler(this.#fd, null)
					try {
						_connectFinish(this.#fd)
					} catch (e) {
						this.#connecting = false
						this.#emitError(e)
						return
					}
					this.#connecting = false
					this.#connected = true
					this.#setupRemoteInfo()
					this.#startReading()
					this.emit('connect')
				})
			} else {
				this.#connecting = false
				this.#connected = true
				this.#setupRemoteInfo()
				queueMicrotask(() => {
					this.#startReading()
					this.emit('connect')
				})
			}
		} catch (e) {
			queueMicrotask(() => this.#emitError(e))
		}

		return this
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

	#flush() {
		if (this.#writing || this.#writeBuf.length === 0 || this.#fd < 0) return

		this.#writing = true
		const entry = this.#writeBuf[0]

		const doWrite = () => {
			if (this.#destroyed) return

			while (this.#writeBuf.length > 0) {
				const cur = this.#writeBuf[0]
				const buf = cur.chunk.buffer instanceof ArrayBuffer
					? cur.chunk.buffer
					: new ArrayBuffer(cur.chunk.byteLength)
				if (buf !== cur.chunk.buffer) {
					new Uint8Array(buf).set(cur.chunk)
				}
				const offset = cur.chunk.byteOffset || 0
				const n = _send(this.#fd, buf, offset, cur.chunk.byteLength)

				if (n === -EAGAIN) {
					os.setWriteHandler(this.#fd, () => {
						os.setWriteHandler(this.#fd, null)
						doWrite()
					})
					return
				}

				if (n < 0) {
					this.#writing = false
					this.#emitError(new Error('write error'))
					return
				}

				if (n < cur.chunk.byteLength) {
					cur.chunk = cur.chunk.subarray(n)
					os.setWriteHandler(this.#fd, () => {
						os.setWriteHandler(this.#fd, null)
						doWrite()
					})
					return
				}

				// Fully written
				this.#writeBuf.shift()
				if (cur.callback) cur.callback(null)
			}

			this.#writing = false
			this.emit('drain')
		}

		doWrite()
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

		// Wait for writes to finish, then shutdown
		const doEnd = () => {
			if (this.#writeBuf.length > 0) {
				this.once('drain', doEnd)
				return
			}
			if (this.#fd >= 0 && this.#connected) {
				try {
					_shutdown(this.#fd, SHUT_WR)
				} catch (e) {
					// ignore errors during shutdown
				}
			}
			this.emit('finish')
			if (this.#ended || !this.#allowHalfOpen) {
				this.destroy()
			}
		}

		doEnd()
		return this
	}

	destroy(err) {
		if (this.#destroyed) return this
		this.#destroyed = true

		if (this.#fd >= 0) {
			os.setReadHandler(this.#fd, null)
			os.setWriteHandler(this.#fd, null)
			os.close(this.#fd)
			this.#fd = -1
		}

		this.#connected = false
		this.#connecting = false
		this.#writeBuf = []

		if (err) this.emit('error', err)
		this.emit('close', !!err)
		return this
	}

	setNoDelay(noDelay = true) {
		if (this.#fd >= 0) {
			_setsockopt(this.#fd, IPPROTO_TCP, TCP_NODELAY, noDelay ? 1 : 0)
		}
		return this
	}

	setKeepAlive(enable = false) {
		if (this.#fd >= 0) {
			const { SO_KEEPALIVE } = { SO_KEEPALIVE: 9 } // from socket constants
			_setsockopt(this.#fd, SOL_SOCKET, SO_KEEPALIVE, enable ? 1 : 0)
		}
		return this
	}

	address() {
		if (this.#fd < 0) return null
		try {
			const addr = _getsockname(this.#fd)
			return {
				address: addr.address,
				port: addr.port,
				family: addr.family === AF_INET6 ? 'IPv6' : 'IPv4',
			}
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
	#fd = -1
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
			this.#fd = _socket(family, SOCK_STREAM)
			_setsockopt(this.#fd, SOL_SOCKET, SO_REUSEADDR, 1)
			_bind(this.#fd, host, port)
			_listen(this.#fd, backlog)
			this.#listening = true

			os.setReadHandler(this.#fd, () => {
				while (true) {
					const result = _accept(this.#fd)
					if (result === null) break
					const sock = new Socket({ _fd: result.fd })
					this.#connections.add(sock)
					sock.on('close', () => this.#connections.delete(sock))
					this.emit('connection', sock)
				}
			})

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
		if (this.#fd < 0) return null
		try {
			const addr = _getsockname(this.#fd)
			return {
				address: addr.address,
				port: addr.port,
				family: addr.family === AF_INET6 ? 'IPv6' : 'IPv4',
			}
		} catch (e) {
			return null
		}
	}

	close(callback) {
		if (this.#closed) return this
		this.#closed = true

		if (callback) this.once('close', callback)

		if (this.#fd >= 0) {
			os.setReadHandler(this.#fd, null)
			os.close(this.#fd)
			this.#fd = -1
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

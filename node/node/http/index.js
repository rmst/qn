/**
 * node:http - HTTP server and client
 * @see https://nodejs.org/api/http.html
 */

import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import { createServer as createTcpServer, Socket } from 'node:net'
import { socketReader, readRequestHead, requestBodyStream, chunkedRequestBodyStream } from 'node:http/parse'

const CRLF = '\r\n'

const DEFAULT_HEADER_TIMEOUT = 60_000  // 60 seconds
const DEFAULT_KEEP_ALIVE_TIMEOUT = 5_000  // 5 seconds

/**
 * Incoming HTTP message (request on server, response on client)
 *
 * Body is read lazily: the body iterator is only consumed when the handler
 * attaches a 'data' listener (flowing mode, matching Node.js behavior).
 */
export class IncomingMessage extends EventEmitter {
	#bodyIter = null
	#pumping = false

	constructor(socket) {
		super()
		this.socket = socket
		this.headers = {}
		this.rawHeaders = []
		this.method = null
		this.url = null
		this.httpVersion = null
		this.statusCode = null
		this.statusMessage = null
		this.complete = false
	}

	/** @internal called by HTTPServer to provide the body iterator */
	_setBody(bodyIter) {
		this.#bodyIter = bodyIter
	}

	on(event, fn) {
		super.on(event, fn)
		if (event === 'data' && this.#bodyIter && !this.#pumping) {
			this.#pumping = true
			this.#pump()
		}
		return this
	}

	async #pump() {
		try {
			for await (const chunk of this.#bodyIter) {
				this.emit('data', chunk)
			}
		} catch {}
		this.complete = true
		this.emit('end')
	}

	/**
	 * @internal Drain any unconsumed body data so the connection can be
	 * reused for the next request (keep-alive).
	 */
	async _drain() {
		if (this.complete) return
		if (!this.#pumping && this.#bodyIter) {
			try { for await (const _ of this.#bodyIter) {} } catch {}
			this.complete = true
		} else if (this.#pumping) {
			await new Promise(r => this.once('end', r))
		}
	}
}

/**
 * Server response object
 */
export class ServerResponse extends EventEmitter {
	#socket
	#headersSent = false
	#headers = {}
	#statusCode = 200
	#statusMessage = 'OK'
	#finished = false
	#keepAlive = false
	#onFinished = null

	constructor(socket, keepAlive) {
		super()
		this.#socket = socket
		this.#keepAlive = keepAlive
	}

	get headersSent() { return this.#headersSent }
	get statusCode() { return this.#statusCode }
	set statusCode(code) { this.#statusCode = code }
	get statusMessage() { return this.#statusMessage }
	set statusMessage(msg) {
		if (/[\r\n]/.test(msg))
			throw new TypeError('Invalid status message: contains CR or LF')
		this.#statusMessage = msg
	}

	/** @internal resolve when response is fully written */
	_awaitFinish() {
		if (this.#finished) return Promise.resolve()
		return new Promise(r => { this.#onFinished = r })
	}

	setHeader(name, value) {
		if (/[\r\n]/.test(name) || /[\r\n]/.test(String(value))) {
			throw new TypeError(`Invalid header: ${name}`)
		}
		this.#headers[name.toLowerCase()] = value
	}

	getHeader(name) {
		return this.#headers[name.toLowerCase()]
	}

	removeHeader(name) {
		delete this.#headers[name.toLowerCase()]
	}

	getHeaderNames() {
		return Object.keys(this.#headers)
	}

	hasHeader(name) {
		return name.toLowerCase() in this.#headers
	}

	writeHead(statusCode, statusMessage, headers) {
		if (typeof statusMessage === 'object') {
			headers = statusMessage
			statusMessage = undefined
		}
		this.#statusCode = statusCode
		const msg = statusMessage || STATUS_CODES[statusCode] || 'Unknown'
		if (/[\r\n]/.test(msg))
			throw new TypeError('Invalid status message: contains CR or LF')
		this.#statusMessage = msg
		if (headers) {
			for (const [k, v] of Object.entries(headers)) {
				if (/[\r\n]/.test(k) || /[\r\n]/.test(String(v))) {
					throw new TypeError(`Invalid header: ${k}`)
				}
				this.#headers[k.toLowerCase()] = v
			}
		}
		return this
	}

	#sendHeaders() {
		if (this.#headersSent) return
		this.#headersSent = true

		let head = `HTTP/1.1 ${this.#statusCode} ${this.#statusMessage}${CRLF}`
		for (const [k, v] of Object.entries(this.#headers)) {
			if (Array.isArray(v)) {
				for (const item of v) {
					head += `${k}: ${item}${CRLF}`
				}
			} else {
				head += `${k}: ${v}${CRLF}`
			}
		}
		head += CRLF
		this.#socket.write(head)
	}

	write(chunk, encoding, callback) {
		if (typeof encoding === 'function') {
			callback = encoding
			encoding = undefined
		}
		if (!this.#headersSent) {
			if (!this.#headers['content-length'] && !this.#headers['transfer-encoding']) {
				this.#headers['transfer-encoding'] = 'chunked'
			}
			this.#sendHeaders()
		}

		if (typeof chunk === 'string') {
			chunk = new TextEncoder().encode(chunk)
		}

		if (this.#headers['transfer-encoding'] === 'chunked') {
			const hex = chunk.byteLength.toString(16)
			this.#socket.write(`${hex}${CRLF}`)
			this.#socket.write(chunk)
			this.#socket.write(CRLF, undefined, callback)
		} else {
			this.#socket.write(chunk, undefined, callback)
		}

		return true
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

		if (this.#finished) return this

		if (data !== undefined && data !== null) {
			if (!this.#headersSent) {
				const body = typeof data === 'string' ? new TextEncoder().encode(data) : data
				if (!this.#headers['content-length'] && !this.#headers['transfer-encoding']) {
					this.#headers['content-length'] = body.byteLength
				}
				this.#sendHeaders()
				this.#socket.write(body)
			} else {
				this.write(data)
			}
		} else if (!this.#headersSent) {
			if (!this.#headers['content-length']) {
				this.#headers['content-length'] = 0
			}
			this.#sendHeaders()
		}

		if (this.#headers['transfer-encoding'] === 'chunked') {
			this.#socket.write(`0${CRLF}${CRLF}`)
		}

		this.#finished = true
		if (!this.#keepAlive) {
			this.#socket.end()
		}
		if (callback) queueMicrotask(callback)
		this.emit('finish')
		if (this.#onFinished) this.#onFinished()
		return this
	}
}

/**
 * HTTP Server
 *
 * Events: 'request', 'upgrade', 'listening', 'close', 'error'
 */
const DEFAULT_MAX_HEADER_SIZE = 64 * 1024  // 64 KB
const DEFAULT_MAX_HEADER_COUNT = 128

export class HTTPServer extends EventEmitter {
	#server
	#maxHeaderSize
	#maxHeaderCount
	#headerTimeout
	#keepAliveTimeout

	constructor(options, requestListener) {
		super()
		if (typeof options === 'function') {
			requestListener = options
			options = {}
		}
		this.#maxHeaderSize = options?.maxHeaderSize ?? DEFAULT_MAX_HEADER_SIZE
		this.#maxHeaderCount = options?.maxHeaderCount ?? DEFAULT_MAX_HEADER_COUNT
		this.#headerTimeout = options?.headerTimeout ?? DEFAULT_HEADER_TIMEOUT
		this.#keepAliveTimeout = options?.keepAliveTimeout ?? DEFAULT_KEEP_ALIVE_TIMEOUT
		if (requestListener) {
			this.on('request', requestListener)
		}
		this.#server = createTcpServer()
		this.#server.on('error', (err) => this.emit('error', err))
		this.#server.on('close', () => this.emit('close'))

		this.#server.on('connection', (socket) => {
			socket.on('error', () => {})
			this.#handleConnection(socket)
		})
	}

	get headerTimeout() { return this.#headerTimeout }
	set headerTimeout(ms) { this.#headerTimeout = ms }
	get keepAliveTimeout() { return this.#keepAliveTimeout }
	set keepAliveTimeout(ms) { this.#keepAliveTimeout = ms }

	async #handleConnection(socket) {
		const reader = socketReader(socket)
		let firstRequest = true

		while (!socket.destroyed) {
			const timeout = firstRequest ? this.#headerTimeout : this.#keepAliveTimeout
			const timer = setTimeout(() => socket.destroy(), timeout)

			let head
			try {
				head = await readRequestHead(reader, this.#maxHeaderSize)
			} catch (err) {
				clearTimeout(timer)
				if (err.code === 'ERR_HTTP_HEADER_TOO_LARGE') {
					const res = new ServerResponse(socket, false)
					res.writeHead(431, { 'Connection': 'close' })
					res.end('Request Header Fields Too Large')
				}
				socket.destroy()
				return
			}
			clearTimeout(timer)

			if (!head) { socket.destroy(); return }
			firstRequest = false

			if (head.rawHeaders.length > this.#maxHeaderCount * 2) {
				const res = new ServerResponse(socket, false)
				res.writeHead(431, { 'Connection': 'close' })
				res.end('Too Many Headers')
				socket.destroy()
				return
			}

			const connectionHeader = (head.headers['connection'] || '').toLowerCase()
			const isHttp11 = head.httpVersion === '1.1'

			// HTTP Upgrade (WebSocket, etc.)
			const connectionParts = connectionHeader.split(/\s*,\s*/)
			if (connectionParts.includes('upgrade') && head.headers['upgrade']) {
				const req = new IncomingMessage(socket)
				req.method = head.method
				req.url = head.url
				req.httpVersion = head.httpVersion
				req.headers = head.headers
				req.rawHeaders = head.rawHeaders
				req.complete = true

				// leftover bytes from the header read become the "head" buffer
				const headBuf = head.leftover && head.leftover.length > 0
					? Buffer.from(head.leftover)
					: Buffer.alloc(0)

				if (this.listenerCount('upgrade') > 0) {
					this.emit('upgrade', req, socket, headBuf)
				} else {
					// No upgrade handler — destroy socket
					socket.destroy()
				}
				return
			}

			const keepAlive = connectionHeader === 'close' ? false :
				connectionHeader === 'keep-alive' ? true : isHttp11

			const req = new IncomingMessage(socket)
			req.method = head.method
			req.url = head.url
			req.httpVersion = head.httpVersion
			req.headers = head.headers
			req.rawHeaders = head.rawHeaders

			const res = new ServerResponse(socket, keepAlive)
			if (!keepAlive) {
				res.setHeader('connection', 'close')
			}

			const hasContentLength = 'content-length' in head.headers
			const hasTransferEncoding = 'transfer-encoding' in head.headers
			const isChunked = hasTransferEncoding &&
				head.headers['transfer-encoding'].toLowerCase().includes('chunked')

			if (hasContentLength && hasTransferEncoding) {
				res.writeHead(400, { 'Connection': 'close' })
				res.end('Bad Request')
				socket.destroy()
				return
			}

			let contentLength = 0
			if (hasContentLength) {
				const clValue = head.headers['content-length'].trim()
				if (!/^\d+$/.test(clValue)) {
					res.writeHead(400, { 'Connection': 'close' })
					res.end('Bad Request')
					socket.destroy()
					return
				}
				contentLength = parseInt(clValue, 10)
			}

			const hasBody = isChunked || contentLength > 0

			if (hasBody) {
				const bodyIter = isChunked
					? chunkedRequestBodyStream(reader, head.leftover)
					: requestBodyStream(reader, head.leftover, contentLength)
				req._setBody(bodyIter)
			} else {
				req.complete = true
				queueMicrotask(() => req.emit('end'))
			}

			this.emit('request', req, res)

			await res._awaitFinish()

			// Drain unconsumed body so the socket is clean for the next request
			if (hasBody) await req._drain()

			if (!keepAlive) return
		}
	}

	listen(port, host, backlog, callback) {
		this.#server.listen(port, host, backlog, () => {
			this.emit('listening')
			if (typeof callback === 'function') callback()
		})
		return this
	}

	address() {
		return this.#server.address()
	}

	close(callback) {
		this.#server.close(callback)
		return this
	}

	ref() { return this }
	unref() { return this }

	get listening() { return this.#server.listening }
}

export function createServer(options, requestListener) {
	return new HTTPServer(options, requestListener)
}

const STATUS_CODES = {
	100: 'Continue', 101: 'Switching Protocols',
	200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
	301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
	307: 'Temporary Redirect', 308: 'Permanent Redirect',
	400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
	404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout',
	409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large',
	415: 'Unsupported Media Type', 426: 'Upgrade Required', 429: 'Too Many Requests',
	500: 'Internal Server Error', 502: 'Bad Gateway',
	503: 'Service Unavailable', 504: 'Gateway Timeout',
}

export { STATUS_CODES }

export default {
	createServer,
	Server: HTTPServer,
	IncomingMessage,
	ServerResponse,
	STATUS_CODES,
}

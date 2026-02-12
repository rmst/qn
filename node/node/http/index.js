/**
 * node:http - HTTP server and client
 * @see https://nodejs.org/api/http.html
 */

import { EventEmitter } from 'node:events'
import { createServer as createTcpServer, Socket } from 'node:net'
import { readRequestHead, requestBodyStream, chunkedRequestBodyStream } from 'node:http/parse'

const CRLF = '\r\n'

/**
 * Wrap a node:net Socket into the async reader interface used by HTTP parsing.
 * Does NOT own the socket — caller manages lifecycle.
 */
function socketReader(socket) {
	const pending = []
	let waiter = null
	let ended = false

	socket.on('data', (chunk) => {
		if (waiter) {
			const resolve = waiter
			waiter = null
			resolve(chunk)
		} else {
			pending.push(chunk)
		}
	})
	socket.on('end', () => {
		ended = true
		if (waiter) { const r = waiter; waiter = null; r(null) }
	})
	socket.on('error', () => {
		ended = true
		if (waiter) { const r = waiter; waiter = null; r(null) }
	})

	return {
		async read(buf, off, len) {
			let chunk
			if (pending.length > 0) {
				chunk = pending.shift()
			} else if (ended) {
				return 0
			} else {
				chunk = await new Promise(r => { waiter = r })
				if (!chunk) return 0
			}
			const n = Math.min(chunk.length, len)
			new Uint8Array(buf, off, n).set(chunk.subarray(0, n))
			if (chunk.length > n) pending.unshift(chunk.subarray(n))
			return n
		},
	}
}

/**
 * Incoming HTTP message (request on server, response on client)
 */
export class IncomingMessage extends EventEmitter {
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
	#chunks = []

	constructor(socket) {
		super()
		this.#socket = socket
	}

	get headersSent() { return this.#headersSent }
	get statusCode() { return this.#statusCode }
	set statusCode(code) { this.#statusCode = code }
	get statusMessage() { return this.#statusMessage }
	set statusMessage(msg) { this.#statusMessage = msg }

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
		this.#statusMessage = statusMessage || STATUS_CODES[statusCode] || 'Unknown'
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
			// If no content-length and no transfer-encoding, use chunked
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
		this.#socket.end()
		if (callback) queueMicrotask(callback)
		this.emit('finish')
		return this
	}
}

/**
 * HTTP Server
 *
 * Events: 'request', 'listening', 'close', 'error'
 */
const DEFAULT_MAX_HEADER_SIZE = 64 * 1024  // 64 KB
const DEFAULT_MAX_BODY_SIZE = 1024 * 1024  // 1 MB
const DEFAULT_MAX_HEADER_COUNT = 128

export class HTTPServer extends EventEmitter {
	#server
	#maxHeaderSize
	#maxBodySize
	#maxHeaderCount

	constructor(options, requestListener) {
		super()
		if (typeof options === 'function') {
			requestListener = options
			options = {}
		}
		this.#maxHeaderSize = options?.maxHeaderSize ?? DEFAULT_MAX_HEADER_SIZE
		this.#maxBodySize = options?.maxBodySize ?? DEFAULT_MAX_BODY_SIZE
		this.#maxHeaderCount = options?.maxHeaderCount ?? DEFAULT_MAX_HEADER_COUNT
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

	async #handleConnection(socket) {
		const reader = socketReader(socket)

		let head
		try {
			head = await readRequestHead(reader, this.#maxHeaderSize)
		} catch (err) {
			if (err.code === 'ERR_HTTP_HEADER_TOO_LARGE') {
				const res = new ServerResponse(socket)
				res.writeHead(431, { 'Connection': 'close' })
				res.end('Request Header Fields Too Large')
			}
			socket.destroy()
			return
		}
		if (!head) { socket.destroy(); return }

		// Header count limit
		if (head.rawHeaders.length > this.#maxHeaderCount * 2) {
			const res = new ServerResponse(socket)
			res.writeHead(431, { 'Connection': 'close' })
			res.end('Too Many Headers')
			socket.destroy()
			return
		}

		const req = new IncomingMessage(socket)
		req.method = head.method
		req.url = head.url
		req.httpVersion = head.httpVersion
		req.headers = head.headers
		req.rawHeaders = head.rawHeaders

		const res = new ServerResponse(socket)

		const hasContentLength = 'content-length' in head.headers
		const hasTransferEncoding = 'transfer-encoding' in head.headers
		const isChunked = hasTransferEncoding &&
			head.headers['transfer-encoding'].toLowerCase().includes('chunked')

		// Reject conflicting framing headers (request smuggling prevention)
		if (hasContentLength && hasTransferEncoding) {
			res.writeHead(400, { 'Connection': 'close' })
			res.end('Bad Request')
			socket.destroy()
			return
		}

		// Validate and parse Content-Length
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

		if (!isChunked && contentLength > this.#maxBodySize) {
			res.writeHead(413, { 'Connection': 'close' })
			res.end('Payload Too Large')
			socket.destroy()
			return
		}

		const hasBody = isChunked ||
			(contentLength > 0 && head.method !== 'GET' && head.method !== 'HEAD')

		this.emit('request', req, res)

		if (hasBody) {
			const bodyIter = isChunked
				? chunkedRequestBodyStream(reader, head.leftover)
				: requestBodyStream(reader, head.leftover, contentLength)

			// Pump body stream into EventEmitter data/end events
			try {
				let total = 0
				for await (const chunk of bodyIter) {
					total += chunk.length
					if (total > this.#maxBodySize) {
						socket.destroy()
						return
					}
					req.emit('data', chunk)
				}
			} catch {}
			req.complete = true
			req.emit('end')
		} else {
			req.complete = true
			queueMicrotask(() => req.emit('end'))
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
	415: 'Unsupported Media Type', 429: 'Too Many Requests',
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

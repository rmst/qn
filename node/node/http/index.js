/**
 * node:http - HTTP server and client
 * @see https://nodejs.org/api/http.html
 */

import { EventEmitter } from 'node:events'
import { createServer as createTcpServer, Socket } from 'node:net'

const CRLF = '\r\n'

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
 * Parse an HTTP request from raw data.
 * Returns { method, url, httpVersion, headers, rawHeaders, headerEnd }
 * or null if headers aren't complete yet.
 */
function parseRequestHead(data) {
	// Find \r\n\r\n
	let headerEnd = -1
	for (let i = 0; i < data.length - 3; i++) {
		if (data[i] === 0x0d && data[i + 1] === 0x0a &&
			data[i + 2] === 0x0d && data[i + 3] === 0x0a) {
			headerEnd = i + 4
			break
		}
	}
	if (headerEnd === -1) return null

	const headerText = new TextDecoder().decode(data.subarray(0, headerEnd))
	const lines = headerText.split('\r\n')

	const requestLine = lines[0]
	const parts = requestLine.split(' ')
	if (parts.length < 3) return null

	const method = parts[0]
	const url = parts[1]
	const httpVersion = parts[2].replace('HTTP/', '')

	const headers = {}
	const rawHeaders = []
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]
		if (!line) break
		const colonIdx = line.indexOf(':')
		if (colonIdx <= 0) continue
		const key = line.slice(0, colonIdx)
		const value = line.slice(colonIdx + 1).trim()
		rawHeaders.push(key, value)
		const lowerKey = key.toLowerCase()
		if (headers[lowerKey] !== undefined) {
			headers[lowerKey] += ', ' + value
		} else {
			headers[lowerKey] = value
		}
	}

	return { method, url, httpVersion, headers, rawHeaders, headerEnd }
}

/**
 * HTTP Server
 *
 * Events: 'request', 'listening', 'close', 'error'
 */
export class HTTPServer extends EventEmitter {
	#server

	constructor(options, requestListener) {
		super()
		if (typeof options === 'function') {
			requestListener = options
			options = {}
		}
		if (requestListener) {
			this.on('request', requestListener)
		}
		this.#server = createTcpServer()
		this.#server.on('error', (err) => this.emit('error', err))
		this.#server.on('close', () => this.emit('close'))

		this.#server.on('connection', (socket) => {
			let buffer = new Uint8Array(0)

			socket.on('data', (chunk) => {
				// Accumulate data
				const newBuf = new Uint8Array(buffer.length + chunk.length)
				newBuf.set(buffer, 0)
				newBuf.set(chunk, buffer.length)
				buffer = newBuf

				const parsed = parseRequestHead(buffer)
				if (!parsed) return

				const req = new IncomingMessage(socket)
				req.method = parsed.method
				req.url = parsed.url
				req.httpVersion = parsed.httpVersion
				req.headers = parsed.headers
				req.rawHeaders = parsed.rawHeaders

				const res = new ServerResponse(socket)

				const contentLength = parseInt(parsed.headers['content-length'], 10) || 0
				const bodyStart = parsed.headerEnd
				const bodyData = buffer.subarray(bodyStart)

				if (contentLength === 0 || parsed.method === 'GET' || parsed.method === 'HEAD') {
					req.complete = true
					buffer = new Uint8Array(0)
					this.emit('request', req, res)
					queueMicrotask(() => req.emit('end'))
				} else if (bodyData.length >= contentLength) {
					const body = bodyData.subarray(0, contentLength)
					req.complete = true
					buffer = bodyData.subarray(contentLength)
					this.emit('request', req, res)
					queueMicrotask(() => {
						req.emit('data', body)
						req.emit('end')
					})
				} else {
					// Need more body data
					let received = bodyData.length
					let bodyChunks = [bodyData]

					this.emit('request', req, res)

					if (bodyData.length > 0) {
						queueMicrotask(() => req.emit('data', bodyData))
					}

					const origHandler = socket.listeners('data')[0]
					socket.removeListener('data', origHandler)

					const bodyHandler = (chunk) => {
						received += chunk.length
						req.emit('data', chunk)
						if (received >= contentLength) {
							req.complete = true
							socket.removeListener('data', bodyHandler)
							buffer = new Uint8Array(0)
							req.emit('end')
						}
					}
					socket.on('data', bodyHandler)
				}
			})

			socket.on('error', () => {})
		})
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

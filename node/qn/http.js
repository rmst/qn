/**
 * qn:http - Modern HTTP server using Web standard Request/Response
 *
 * Similar to Deno.serve() / Bun.serve() — takes a (Request) => Response
 * handler instead of the Node.js (req, res) callback style.
 */

import { createServer as createTcpServer } from 'node:net'
import { readRequest, writeResponse } from 'node:http/parse'

/**
 * Wrap a node:net Socket into the async reader interface used by HTTP parsing.
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
		close() {
			socket.destroy()
		},
	}
}

/**
 * Handle a single HTTP connection: parse request, call handler, write response.
 */
async function handleConnection(socket, handler, onError) {
	const reader = socketReader(socket)
	try {
		const request = await readRequest(reader)
		if (!request) { socket.destroy(); return }

		const response = await handler(request)

		await writeResponse(data => {
			socket.write(data)
			return Promise.resolve()
		}, response)
	} catch (err) {
		if (onError) onError(err)
	} finally {
		socket.end()
	}
}

/**
 * Start an HTTP server with a Web standard (Request) => Response handler.
 *
 * @param {Object|Function} optionsOrHandler - Options object or handler function
 * @param {Function} [handlerOrOptions] - Handler function or options object
 * @returns {Promise<HttpServer>}
 *
 * @example
 *   const server = await serve({ port: 8080 }, (req) => new Response("hello"))
 *   const server = await serve((req) => new Response("hello"), { port: 8080 })
 *   const server = await serve((req) => new Response("hello"))
 */
export function serve(optionsOrHandler, handlerOrOptions) {
	let handler, options
	if (typeof optionsOrHandler === 'function') {
		handler = optionsOrHandler
		options = handlerOrOptions || {}
	} else {
		options = optionsOrHandler || {}
		handler = handlerOrOptions
	}
	if (typeof handler !== 'function')
		throw new TypeError('serve: handler must be a function')

	const port = options.port ?? 0
	const hostname = options.hostname ?? '0.0.0.0'
	const onError = options.onError || null

	const tcpServer = createTcpServer()

	tcpServer.on('connection', (socket) => {
		handleConnection(socket, handler, onError)
	})

	return new Promise((resolve, reject) => {
		tcpServer.on('error', reject)
		tcpServer.listen(port, hostname, undefined, () => {
			tcpServer.removeListener('error', reject)
			resolve(new HttpServer(tcpServer))
		})
	})
}

class HttpServer {
	#server

	constructor(server) {
		this.#server = server
	}

	address() {
		return this.#server.address()
	}

	close() {
		this.#server.close()
	}
}

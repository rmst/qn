/**
 * qn:http - Modern HTTP server using Web standard Request/Response
 *
 * Similar to Deno.serve() / Bun.serve() — takes a (Request) => Response
 * handler instead of the Node.js (req, res) callback style.
 */

import { createServer as createTcpServer } from 'node:net'
import { socketReader, readRequest, writeResponse } from 'node:http/parse'

const DEFAULT_HEADER_TIMEOUT = 60_000  // 60 seconds
const DEFAULT_KEEP_ALIVE_TIMEOUT = 5_000  // 5 seconds

/**
 * Handle an HTTP connection: parse requests in a loop, supporting keep-alive.
 */
async function handleConnection(socket, handler, onError, headerTimeout, keepAliveTimeout) {
	const reader = socketReader(socket)
	const abort = new AbortController()
	socket.on('close', () => abort.abort())

	let firstRequest = true

	while (!socket.destroyed) {
		const timeout = firstRequest ? headerTimeout : keepAliveTimeout
		const timer = setTimeout(() => socket.destroy(), timeout)

		let request, keepAlive
		try {
			const result = readRequest(reader, { signal: abort.signal }, { returnKeepAlive: true })
			// readRequest with returnKeepAlive returns { request, keepAlive }
			const resolved = await result
			clearTimeout(timer)
			if (!resolved) { socket.destroy(); return }
			request = resolved.request
			keepAlive = resolved.keepAlive
		} catch (err) {
			clearTimeout(timer)
			if (err?.name === 'AbortError' || err?.message === 'socket closed') return
			socket.destroy()
			return
		}
		firstRequest = false

		try {
			const response = await handler(request)

			await writeResponse(data => {
				return new Promise((resolve, reject) => {
					if (socket.destroyed) { reject(new Error('socket closed')); return }
					socket.write(data, (err) => {
						if (err) reject(err)
						else resolve()
					})
				})
			}, response, { keepAlive })
		} catch (err) {
			if (err?.name === 'AbortError' || err?.message === 'socket closed') return
			if (!socket.destroyed) {
				try {
					socket.write('HTTP/1.1 500 Internal Server Error\r\nconnection: close\r\ncontent-length: 21\r\n\r\nInternal Server Error')
				} catch {}
			}
			if (onError) onError(err)
			// After an error, close the connection — state may be inconsistent
			socket.end()
			return
		}

		// Drain any unconsumed request body so the reader is clean for the next request
		if (request.body) {
			try { for await (const _ of request.body) {} } catch {}
		}

		if (!keepAlive) {
			socket.end()
			return
		}
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
	const hostname = options.hostname ?? '127.0.0.1'
	const onError = options.onError || null
	const headerTimeout = options.headerTimeout ?? DEFAULT_HEADER_TIMEOUT
	const keepAliveTimeout = options.keepAliveTimeout ?? DEFAULT_KEEP_ALIVE_TIMEOUT

	const tcpServer = createTcpServer()

	tcpServer.on('connection', (socket) => {
		socket.on('error', () => {})
		handleConnection(socket, handler, onError, headerTimeout, keepAliveTimeout)
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

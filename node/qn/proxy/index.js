/**
 * qn:proxy - Reverse proxy module
 *
 * Creates an HTTP reverse proxy that forwards requests to backend servers
 * based on a user-provided routing function. Supports both HTTP and WebSocket.
 *
 * @example
 *   import { createProxy } from 'qn:proxy'
 *   const proxy = await createProxy({
 *     port: 8080,
 *     hostname: '0.0.0.0',
 *     route: (req) => {
 *       if (req.headers.host === 'app.local') return 'http://localhost:3000'
 *       return null // 404
 *     },
 *   })
 */

import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'

const HOP_BY_HOP = new Set([
	'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
	'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
])

const WS_HIGH_WATER = 64 * 1024
const DEFAULT_TIMEOUT = 120_000

/**
 * Create a reverse proxy server.
 *
 * @param {Object} options
 * @param {number} [options.port=0] - Port to listen on (0 = random)
 * @param {string} [options.hostname='127.0.0.1'] - Address to bind
 * @param {number} [options.timeout=120000] - Backend timeout in ms (0 = no timeout)
 * @param {(req: http.IncomingMessage) => string|null} options.route
 *   Routing function: receives the incoming request, returns a backend
 *   origin URL (e.g. 'http://localhost:3000') or null for 404.
 * @returns {Promise<{ address(): object, close(): Promise<void> }>}
 */
export async function createProxy({ port = 0, hostname = '127.0.0.1', timeout = DEFAULT_TIMEOUT, route } = {}) {
	if (typeof route !== 'function')
		throw new TypeError('createProxy: route must be a function')

	const wss = new WebSocketServer({ noServer: true })

	const server = http.createServer(async (req, res) => {
		const target = route(req)
		if (!target) {
			res.writeHead(404)
			res.end('Not Found')
			return
		}
		try {
			await forwardHTTP(req, res, target, timeout)
		} catch (err) {
			if (res.headersSent) return
			if (err && err.name === 'TimeoutError') {
				res.writeHead(504)
				res.end('Gateway Timeout')
			} else {
				res.writeHead(502)
				res.end('Bad Gateway')
			}
		}
	})

	server.on('upgrade', (req, socket, head) => {
		const target = route(req)
		if (!target) { socket.destroy(); return }
		forwardWS(wss, req, socket, head, target)
	})

	await new Promise((resolve, reject) => {
		server.on('error', reject)
		server.listen(port, hostname, () => {
			server.removeListener('error', reject)
			resolve()
		})
	})

	return {
		address: () => server.address(),
		close: () => new Promise(resolve => {
			wss.close()
			server.close(resolve)
		}),
	}
}

async function forwardHTTP(req, res, target, timeout) {
	const url = new URL(req.url, target)

	const headers = filterHeaders(req.headers)
	headers['x-forwarded-for'] = req.socket.remoteAddress
	headers['x-forwarded-proto'] = 'http'
	headers['x-forwarded-host'] = req.headers.host || ''

	// Abort backend fetch if client disconnects or timeout expires
	const abort = new AbortController()
	req.socket.on('close', () => abort.abort())
	const timer = timeout > 0 ? setTimeout(() => abort.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), timeout) : null

	// If the client sent Content-Length, buffer the body so fetch preserves it.
	// Otherwise stream through (fetch will use chunked transfer-encoding).
	let body = undefined
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		if (req.headers['content-length']) {
			const chunks = []
			req.on('data', c => chunks.push(c))
			await new Promise(r => req.on('end', r))
			if (chunks.length > 0) body = Buffer.concat(chunks)
		} else {
			delete headers['content-length']
			body = incomingBodyStream(req)
		}
	}

	let response
	try {
		response = await fetch(url.href, {
			method: req.method,
			headers,
			body,
			signal: abort.signal,
		})
	} finally {
		if (timer) clearTimeout(timer)
	}

	// Forward response headers, skipping hop-by-hop
	const resHeaders = {}
	response.headers.forEach((v, k) => {
		if (!HOP_BY_HOP.has(k)) resHeaders[k] = v
	})

	res.writeHead(response.status, resHeaders)

	if (response.body) {
		for await (const chunk of response.body) {
			if (!res.write(chunk)) {
				await new Promise(resolve => res.once('drain', resolve))
			}
		}
	}
	res.end()
}

function incomingBodyStream(req) {
	const queue = []
	let done = false
	let waiting = null

	req.on('data', (chunk) => {
		if (waiting) {
			const resolve = waiting
			waiting = null
			resolve({ value: chunk, done: false })
		} else {
			queue.push(chunk)
		}
	})
	req.on('end', () => {
		done = true
		if (waiting) {
			const resolve = waiting
			waiting = null
			resolve({ value: undefined, done: true })
		}
	})
	req.on('error', () => {
		done = true
		if (waiting) {
			const resolve = waiting
			waiting = null
			resolve({ value: undefined, done: true })
		}
	})

	return {
		[Symbol.asyncIterator]() {
			return {
				next() {
					if (queue.length > 0)
						return Promise.resolve({ value: queue.shift(), done: false })
					if (done)
						return Promise.resolve({ value: undefined, done: true })
					return new Promise(resolve => { waiting = resolve })
				}
			}
		}
	}
}

function forwardWS(wss, req, socket, head, target) {
	const wsUrl = target.replace(/^http/, 'ws') + req.url

	const backend = new WebSocket(wsUrl)
	backend.on('error', () => socket.destroy())

	backend.on('open', () => {
		wss.handleUpgrade(req, socket, head, (client) => {
			pipeWS(client, backend)
			pipeWS(backend, client)
			client.on('close', (code, reason) => backend.close(code, reason))
			backend.on('close', (code, reason) => client.close(code, reason))
			client.on('error', () => backend.terminate())
			backend.on('error', () => client.terminate())
		})
	})
}

/** Pipe messages from src to dst with backpressure */
function pipeWS(src, dst) {
	src.on('message', (data, isBinary) => {
		if (dst.readyState !== WebSocket.OPEN) return
		dst.send(data, { binary: isBinary }, () => {
			// Resume src once the send has been flushed
			if (src.isPaused) src.resume()
		})
		if (dst.bufferedAmount > WS_HIGH_WATER) src.pause()
	})
}

function filterHeaders(headers) {
	const out = {}
	for (const [k, v] of Object.entries(headers)) {
		if (!HOP_BY_HOP.has(k.toLowerCase()))
			out[k] = Array.isArray(v) ? v.join(', ') : v
	}
	return out
}



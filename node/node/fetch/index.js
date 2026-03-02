/**
 * Fetch API implementation using libuv TCP streams + BearSSL TLS
 * https://fetch.spec.whatwg.org/
 */

import {
	tcpNew, tcpConnect as _tcpConnect, tcpNodelay,
	readStart, readStop, write as _streamWrite,
	close as _streamClose, setOnRead, setOnConnect,
	AF_INET, AF_INET6,
} from 'qn/uv-stream'
import { getaddrinfo as _getaddrinfo } from 'qn_uv_dns'
import * as tls from 'qn:tls'
import { existsSync } from 'node:fs'
import { Headers } from './Headers.js'
import { Request } from './Request.js'
import { Response } from './Response.js'
import {
	concatChunks, isChunkedComplete, decodeChunked,
	parseResponseHead, buildRequest as _buildRequest,
	readResponseHead, bodyStream, writeChunkedBody,
} from 'node:http/parse'

export { Headers, Request, Response }

/**
 * Async queue with backpressure that decouples socket reads from body
 * consumption.
 *
 * A background task reads from the socket (via bodyStream) and pushes
 * chunks into a bounded buffer. When the buffer is full, reading pauses
 * until the consumer pulls. This gives us:
 *
 * - Deterministic socket cleanup: the drain task runs to completion
 *   when the server finishes sending, closing the socket in the
 *   bodyStream finally block. No GC dependency.
 * - Backpressure: buffer is capped at HIGH_WATER bytes. When full,
 *   the drain pauses (stops reading from the socket) until the
 *   consumer pulls enough data below LOW_WATER.
 * - Cancellation: abort() stops the drain and closes the socket.
 * - Streaming: data flows through chunk-by-chunk for large responses.
 */
const HIGH_WATER = 64 * 1024
const LOW_WATER = 16 * 1024
const BODY_TIMEOUT = 300_000  // 5 minutes — abort abandoned streams

class BodyQueue {
	constructor() {
		this._chunks = []
		this._size = 0
		this._pullWait = null   // consumer waiting for data
		this._drainWait = null  // producer waiting for buffer space
		this._done = false
		this._error = null
		this._aborted = false
		this._timeout = null
	}

	push(chunk) {
		if (this._aborted) return false
		if (this._pullWait) {
			// Consumer is waiting — deliver directly, no buffering
			const resolve = this._pullWait
			this._pullWait = null
			resolve(chunk)
			return true
		}
		this._chunks.push(chunk)
		this._size += chunk.byteLength
		return this._size < HIGH_WATER
	}

	waitForDrain() {
		// Start body timeout — if nobody pulls within BODY_TIMEOUT,
		// the response was abandoned. Abort to free the socket.
		this._timeout = setTimeout(() => this.abort(), BODY_TIMEOUT)
		return new Promise(r => { this._drainWait = r })
	}

	_clearTimeout() {
		if (this._timeout) {
			clearTimeout(this._timeout)
			this._timeout = null
		}
	}

	end(error) {
		this._done = true
		this._error = error || null
		this._clearTimeout()
		if (this._pullWait) {
			const resolve = this._pullWait
			this._pullWait = null
			resolve(null)
		}
	}

	pull() {
		if (this._chunks.length > 0) {
			const chunk = this._chunks.shift()
			this._size -= chunk.byteLength
			// Resume drain if buffer dropped below low water
			if (this._drainWait && this._size < LOW_WATER) {
				this._clearTimeout()
				const resolve = this._drainWait
				this._drainWait = null
				resolve()
			}
			return Promise.resolve(chunk)
		}
		if (this._done) {
			if (this._error) return Promise.reject(this._error)
			return Promise.resolve(null)
		}
		return new Promise(r => { this._pullWait = r })
	}

	abort() {
		this._aborted = true
		this._done = true
		this._clearTimeout()
		// Unblock drain so it can exit
		if (this._drainWait) {
			const resolve = this._drainWait
			this._drainWait = null
			resolve()
		}
		// Unblock consumer
		if (this._pullWait) {
			const resolve = this._pullWait
			this._pullWait = null
			resolve(null)
		}
	}
}

/**
 * Start a background drain that reads from bodyStream into a
 * backpressure-controlled BodyQueue. Returns an async generator
 * that the Response body reads from.
 */
function pipedBody(reader, leftover, contentLength, isChunked) {
	const queue = new BodyQueue()

	// Background drain — reads the socket, pushes to queue
	;(async () => {
		try {
			const stream = bodyStream(reader, leftover, contentLength, isChunked)
			for await (const chunk of stream) {
				if (queue._aborted) break
				const ok = queue.push(chunk)
				if (!ok && !queue._aborted) {
					await queue.waitForDrain()
				}
			}
			queue.end()
		} catch (e) {
			queue.end(e)
		}
	})()

	const body = async function* () {
		for (;;) {
			const chunk = await queue.pull()
			if (chunk === null) return
			yield chunk
		}
	}()

	body._pipe = queue
	return body
}

const SYSTEM_CA_PATHS = [
	'/etc/ssl/certs/ca-certificates.crt',
	'/etc/pki/tls/certs/ca-bundle.crt',
	'/etc/ssl/cert.pem',
	'/etc/ssl/ca-bundle.pem',
	'/usr/local/share/certs/ca-root-nss.crt',
	'/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
]

let _caCertsLoaded = false
function ensureCACerts() {
	if (_caCertsLoaded) return
	_caCertsLoaded = true

	const sslCertFile = globalThis.process?.env?.SSL_CERT_FILE
	if (sslCertFile) {
		tls.loadCACerts(sslCertFile)
	} else {
		for (const p of SYSTEM_CA_PATHS) {
			if (existsSync(p)) {
				tls.loadCACerts(p)
				break
			}
		}
	}

	const extraCerts = globalThis.process?.env?.NODE_EXTRA_CA_CERTS
	if (extraCerts) {
		tls.loadCACerts(extraCerts)
	}
}

const MAX_REDIRECTS = 20

function isRedirectStatus(status) {
	return [301, 302, 303, 307, 308].includes(status)
}

/**
 * Connect a TCP stream to host:port via libuv.
 * Returns the stream handle.
 */
async function tcpConnect(host, port, signal) {
	if (signal?.aborted) throw signal.reason

	let addrs = await _getaddrinfo(host, port, { family: AF_INET })
	if (signal?.aborted) throw signal.reason
	if (addrs.length === 0) {
		addrs = await _getaddrinfo(host, port)
		if (addrs.length === 0) throw new TypeError(`fetch failed: DNS lookup failed for ${host}`)
	}

	const family = addrs[0].family
	const handle = tcpNew(family)

	return new Promise((resolve, reject) => {
		const onAbort = () => {
			_streamClose(handle)
			reject(signal.reason)
		}
		if (signal) signal.addEventListener('abort', onAbort, { once: true })

		setOnConnect(handle, (err) => {
			if (signal) signal.removeEventListener('abort', onAbort)
			if (err) {
				_streamClose(handle)
				reject(new TypeError(`fetch failed: ${err.message || err}`))
			} else {
				tcpNodelay(handle, true)
				resolve(handle)
			}
		})

		try {
			_tcpConnect(handle, addrs[0].address, port)
		} catch (e) {
			if (signal) signal.removeEventListener('abort', onAbort)
			_streamClose(handle)
			reject(new TypeError(`fetch failed: ${e.message}`))
		}
	})
}

/**
 * Create a transport { read, write } from a libuv stream handle.
 * One-shot read pattern: start reading, resolve on first chunk, stop.
 */
function plainTransport(handle) {
	let pendingResolve = null
	let pendingReject = null
	let buffered = null
	let eof = false

	setOnRead(handle, (buf, err) => {
		if (err) {
			readStop(handle)
			if (pendingReject) {
				const rej = pendingReject
				pendingResolve = pendingReject = null
				rej(new Error('fetch: stream read error'))
			}
			return
		}
		if (buf === null) {
			eof = true
			readStop(handle)
			if (pendingResolve) {
				const res = pendingResolve
				pendingResolve = pendingReject = null
				res(null)
			}
			return
		}
		readStop(handle)
		const chunk = new Uint8Array(buf)
		if (pendingResolve) {
			const res = pendingResolve
			pendingResolve = pendingReject = null
			res(chunk)
		} else {
			buffered = chunk
		}
	})

	return {
		read({ signal } = {}) {
			if (buffered) {
				const b = buffered
				buffered = null
				return Promise.resolve(b)
			}
			if (eof) return Promise.resolve(null)
			if (signal?.aborted) return Promise.reject(signal.reason)
			return new Promise((resolve, reject) => {
				pendingResolve = resolve
				pendingReject = reject
				if (signal) {
					signal.addEventListener('abort', () => {
						readStop(handle)
						pendingResolve = pendingReject = null
						reject(signal.reason)
					}, { once: true })
				}
				readStart(handle)
			})
		},
		async write(data, { signal } = {}) {
			if (signal?.aborted) throw signal.reason
			await _streamWrite(handle, data)
		},
	}
}

function buildRequest(method, path, host, port, headers, isDefaultPort) {
	return _buildRequest(method, path, host, port, headers, isDefaultPort)
}

/**
 * Send an HTTP request over an established TCP stream and return
 * a reader { read(buf, off, len), close() } for the response.
 * Handles TLS handshake if isHttps.
 */
async function sendRequest(handle, host, isHttps, reqBytes, bodyBytes, bodyIter, signal) {
	const transport = isHttps ? tls.streamTransport(handle) : plainTransport(handle)

	if (isHttps) {
		ensureCACerts()
		const conn = tls.connect(host)
		try {
			await tls.handshake(conn, transport, signal)
			await tls.writeAll(conn, transport, reqBytes, signal)
			if (bodyBytes) await tls.writeAll(conn, transport, bodyBytes, signal)
			else if (bodyIter) await writeChunkedBody(data => tls.writeAll(conn, transport, data, signal), bodyIter)
		} catch (e) {
			try { await tls.close(conn, transport) } catch {}
			try { _streamClose(handle) } catch {}
			throw e
		}
		let closed = false
		return {
			read(buf, off, len) {
				return tls.read(conn, transport, buf, off, len, signal)
			},
			async close() {
				if (closed) return
				closed = true
				try { await tls.close(conn, transport) } catch {}
				try { _streamClose(handle) } catch {}
			},
		}
	}

	/* Plain HTTP */
	try {
		await transport.write(reqBytes, { signal })
		if (bodyBytes) await transport.write(bodyBytes, { signal })
		else if (bodyIter) await writeChunkedBody(data => transport.write(data, { signal }), bodyIter)
	} catch (e) {
		_streamClose(handle)
		throw e
	}
	let closed = false
	let leftover = null
	return {
		async read(buf, off, len) {
			/* Convert chunk-based transport.read() to positional read(buf, off, len) */
			let chunk = leftover
			leftover = null
			if (!chunk) {
				chunk = await transport.read({ signal })
				if (!chunk) return 0
			}
			const n = Math.min(chunk.byteLength, len)
			new Uint8Array(buf, off, n).set(chunk.subarray(0, n))
			if (n < chunk.byteLength) leftover = chunk.subarray(n)
			return n
		},
		close() {
			if (closed) return
			closed = true
			_streamClose(handle)
		},
	}
}


/**
 * Fetch a resource from the network
 *
 * @param {string|URL|Request} input - The URL or Request to fetch
 * @param {Object} [init] - Optional configuration (overrides Request properties)
 * @returns {Promise<Response>}
 */
export async function fetch(input, init = {}) {
	let url

	if (input instanceof Request) {
		if (input.bodyUsed) throw new TypeError('Request body has already been consumed')
		try {
			url = new URL(input.url)
		} catch {
			throw new TypeError(`Invalid URL: ${input.url}`)
		}
		init = { method: input.method, headers: input.headers, body: input.body, signal: input.signal, ...init }
	} else if (input instanceof URL) {
		url = input
	} else if (typeof input === 'string') {
		try {
			url = new URL(input)
		} catch {
			throw new TypeError(`Invalid URL: ${input}`)
		}
	} else {
		throw new TypeError('Input must be a string, URL, or Request')
	}

	const signal = init.signal || null
	if (signal?.aborted) {
		throw signal.reason
	}

	const method = (init.method || 'GET').toUpperCase()
	if (!/^[!#$%&'*+\-.^_`|~\w]+$/.test(method))
		throw new TypeError(`Invalid HTTP method: ${JSON.stringify(init.method)}`)
	const headers = init.headers instanceof Headers
		? new Headers(init.headers)
		: new Headers(init.headers || {})

	let bodyBytes = null
	let bodyIter = null
	if (init.body !== undefined && init.body !== null) {
		if (typeof init.body === 'string') {
			bodyBytes = new TextEncoder().encode(init.body)
			if (!headers.has('content-type')) {
				headers.set('content-type', 'text/plain;charset=UTF-8')
			}
			headers.set('content-length', String(bodyBytes.byteLength))
		} else if (init.body instanceof Uint8Array) {
			bodyBytes = init.body
			headers.set('content-length', String(bodyBytes.byteLength))
		} else if (init.body instanceof ArrayBuffer) {
			bodyBytes = new Uint8Array(init.body)
			headers.set('content-length', String(bodyBytes.byteLength))
		} else if (typeof init.body?.[Symbol.asyncIterator] === 'function'
			|| typeof init.body?.[Symbol.iterator] === 'function') {
			bodyIter = init.body
			if (!headers.has('transfer-encoding'))
				headers.set('transfer-encoding', 'chunked')
		} else {
			throw new TypeError('Unsupported body type')
		}
	}

	let redirectCount = 0
	let redirected = false
	const redirectMode = init.redirect || 'follow'

	while (true) {
		if (signal?.aborted) throw signal.reason

		const isHttps = url.protocol === 'https:'
		const defaultPort = isHttps ? 443 : 80
		const host = url.hostname
		const port = url.port ? parseInt(url.port, 10) : defaultPort
		const path = (url.pathname || '/') + (url.search || '')
		const isDefaultPort = port === defaultPort

		let handle
		try {
			handle = await tcpConnect(host, port, signal)
		} catch (e) {
			if (signal?.aborted) throw signal.reason
			throw new TypeError(`fetch failed: ${e.message}`)
		}

		const reqStr = buildRequest(method, path, host, port, headers, isDefaultPort)
		const reqBytes = new TextEncoder().encode(reqStr)

		let reader
		try {
			reader = await sendRequest(handle, host, isHttps, reqBytes, bodyBytes, bodyIter, signal)
		} catch (e) {
			if (signal?.aborted) throw signal.reason
			throw e instanceof TypeError ? e : new TypeError(`fetch failed: ${e.message}`)
		}

		try {
			const head = await readResponseHead(reader, 64 * 1024)
			if (!head) throw new TypeError('fetch failed: invalid HTTP response')

			if (isRedirectStatus(head.status)) {
				await reader.close()
				reader = null

				if (redirectMode === 'error') {
					throw new TypeError('fetch failed: redirect encountered')
				}
				if (redirectMode === 'manual') {
					return new Response(null, {
						status: head.status,
						statusText: head.statusText,
						headers: head.headers,
						url: url.href,
						redirected,
					})
				}
				redirectCount++
				if (redirectCount > MAX_REDIRECTS) {
					throw new TypeError('fetch failed: too many redirects')
				}
				const location = head.headers.get('location')
				if (!location) {
					throw new TypeError('fetch failed: redirect without Location header')
				}
				const prevOrigin = url.origin
				url = new URL(location, url)
				if (url.origin !== prevOrigin) {
					headers.delete('authorization')
					headers.delete('cookie')
					headers.delete('proxy-authorization')
				}
				redirected = true
				continue
			}

			const te = head.headers.get('transfer-encoding')
			const cl = head.headers.get('content-length')
			const isChunked = te && te.toLowerCase().includes('chunked')
			const contentLength = cl !== null ? parseInt(cl, 10) : null
			if (isChunked) head.headers.delete('transfer-encoding')

			const body = pipedBody(reader, head.leftover, contentLength, isChunked)
			reader = null  // pipedBody owns the reader now

			return new Response(body, {
				status: head.status,
				statusText: head.statusText,
				headers: head.headers,
				url: url.href,
				redirected,
			})
		} catch (e) {
			if (signal?.aborted) throw signal.reason
			throw e instanceof TypeError ? e : new TypeError(`fetch failed: ${e.message}`)
		} finally {
			if (reader) {
				try { await reader.close() } catch {}
			}
		}
	}
}

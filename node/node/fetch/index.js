/**
 * Fetch API implementation using native sockets + BearSSL TLS
 * https://fetch.spec.whatwg.org/
 */

import * as os from 'os'
import {
	socket as _socket, connect as _connect, connectFinish as _connectFinish,
	getaddrinfo as _getaddrinfo, send as _send, recv as _recv,
	AF_INET, SOCK_STREAM, EAGAIN, EINPROGRESS,
} from 'qn_socket'
import * as tls from 'node:tls'
import { existsSync } from 'node:fs'
import { Headers } from './Headers.js'
import { Request } from './Request.js'
import { Response } from './Response.js'

export { Headers, Request, Response }

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
 * Connect a TCP socket to host:port via event loop.
 */
function tcpConnect(host, port, signal) {
	if (signal?.aborted) return Promise.reject(signal.reason)

	const addrs = _getaddrinfo(host, port, { family: AF_INET })
	if (addrs.length === 0) {
		const addrs6 = _getaddrinfo(host, port)
		if (addrs6.length === 0) throw new TypeError(`fetch failed: DNS lookup failed for ${host}`)
		addrs.push(...addrs6)
	}

	const fd = _socket(addrs[0].family, SOCK_STREAM)
	const ret = _connect(fd, addrs[0].address, port)

	if (ret === -EINPROGRESS) {
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				os.setWriteHandler(fd, null)
				os.close(fd)
				reject(signal.reason)
			}
			if (signal) signal.addEventListener('abort', onAbort, { once: true })
			os.setWriteHandler(fd, () => {
				os.setWriteHandler(fd, null)
				if (signal) signal.removeEventListener('abort', onAbort)
				try {
					_connectFinish(fd)
					resolve(fd)
				} catch (e) {
					os.close(fd)
					reject(new TypeError(`fetch failed: ${e.message}`))
				}
			})
		})
	}

	return Promise.resolve(fd)
}

/**
 * Read one chunk from a plain socket asynchronously.
 * Waits for the read handler to fire, then reads.
 * Returns number of bytes read, or 0 for EOF.
 */
function socketReadAsync(fd, buf, off, len, signal) {
	if (signal?.aborted) return Promise.reject(signal.reason)
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			os.setReadHandler(fd, null)
			reject(signal.reason)
		}
		if (signal) signal.addEventListener('abort', onAbort, { once: true })
		os.setReadHandler(fd, () => {
			const n = _recv(fd, buf, off, len)
			if (n === -EAGAIN) return
			os.setReadHandler(fd, null)
			if (signal) signal.removeEventListener('abort', onAbort)
			resolve(n <= 0 ? 0 : n)
		})
	})
}

/**
 * Write all data to a plain socket via event loop.
 */
function writeAllSocket(fd, data, signal) {
	if (signal?.aborted) return Promise.reject(signal.reason)
	return new Promise((resolve, reject) => {
		let offset = 0
		const buf = data.buffer instanceof ArrayBuffer ? data.buffer : new ArrayBuffer(data.byteLength)
		if (buf !== data.buffer) new Uint8Array(buf).set(data)

		const onAbort = () => {
			os.setWriteHandler(fd, null)
			reject(signal.reason)
		}
		if (signal) signal.addEventListener('abort', onAbort, { once: true })

		const doWrite = () => {
			while (offset < data.byteLength) {
				const n = _send(fd, buf, data.byteOffset + offset, data.byteLength - offset)
				if (n === -EAGAIN) {
					os.setWriteHandler(fd, () => {
						os.setWriteHandler(fd, null)
						doWrite()
					})
					return
				}
				if (n < 0) {
					if (signal) signal.removeEventListener('abort', onAbort)
					reject(new TypeError('fetch failed: write error'))
					return
				}
				offset += n
			}
			if (signal) signal.removeEventListener('abort', onAbort)
			resolve()
		}
		doWrite()
	})
}

function concatChunks(chunks) {
	if (chunks.length === 0) return new Uint8Array(0)
	if (chunks.length === 1) return chunks[0]
	const total = chunks.reduce((sum, c) => sum + c.length, 0)
	const result = new Uint8Array(total)
	let off = 0
	for (const chunk of chunks) {
		result.set(chunk, off)
		off += chunk.length
	}
	return result
}

function validateHeaderValue(name, value) {
	if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
		throw new TypeError(`Invalid header: ${name}`)
	}
}

/**
 * Build HTTP request string
 */
function buildRequest(method, path, host, port, headers, isDefaultPort) {
	const hostHeader = isDefaultPort ? host : `${host}:${port}`
	let req = `${method} ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n`
	for (const [key, value] of headers) {
		if (key.toLowerCase() === 'host') continue
		validateHeaderValue(key, value)
		req += `${key}: ${value}\r\n`
	}
	req += '\r\n'
	return req
}

/**
 * Check if chunked data is complete by walking chunk boundaries.
 * Returns true when we've seen the terminating 0-length chunk.
 */
function isChunkedComplete(data) {
	let pos = 0
	while (pos < data.length) {
		let lineEnd = -1
		for (let i = pos; i < data.length - 1; i++) {
			if (data[i] === 0x0d && data[i + 1] === 0x0a) {
				lineEnd = i
				break
			}
		}
		if (lineEnd === -1) return false

		const sizeLine = new TextDecoder().decode(data.subarray(pos, lineEnd))
		const chunkSize = parseInt(sizeLine.split(';')[0].trim(), 16)
		if (isNaN(chunkSize)) return false
		if (chunkSize === 0) return true

		const nextPos = lineEnd + 2 + chunkSize + 2
		if (nextPos > data.length) return false
		pos = nextPos
	}
	return false
}

/**
 * Decode a chunked transfer-encoded body.
 */
function decodeChunked(data) {
	const chunks = []
	let pos = 0
	while (pos < data.length) {
		let lineEnd = -1
		for (let i = pos; i < data.length - 1; i++) {
			if (data[i] === 0x0d && data[i + 1] === 0x0a) {
				lineEnd = i
				break
			}
		}
		if (lineEnd === -1) break

		const sizeLine = new TextDecoder().decode(data.subarray(pos, lineEnd))
		const chunkSize = parseInt(sizeLine.split(';')[0].trim(), 16)
		if (isNaN(chunkSize)) break
		if (chunkSize === 0) break

		const dataStart = lineEnd + 2
		const dataEnd = dataStart + chunkSize
		if (dataEnd > data.length) break

		chunks.push(data.subarray(dataStart, dataEnd))
		pos = dataEnd + 2
	}
	return concatChunks(chunks)
}

/**
 * Parse HTTP response headers from raw data.
 * Returns { status, statusText, headers, bodyStart } or null if incomplete.
 */
function parseResponseHead(data) {
	let headerEnd = -1
	for (let i = 0; i < data.length - 3; i++) {
		if (data[i] === 0x0d && data[i + 1] === 0x0a &&
			data[i + 2] === 0x0d && data[i + 3] === 0x0a) {
			headerEnd = i
			break
		}
	}
	if (headerEnd === -1) return null

	const headerText = new TextDecoder().decode(data.subarray(0, headerEnd))
	const lines = headerText.split('\r\n')

	const statusLine = lines[0] || ''
	const statusMatch = statusLine.match(/^HTTP\/[\d.]+ (\d+)(?: (.*))?$/)
	const status = statusMatch ? parseInt(statusMatch[1], 10) : 0
	const statusText = statusMatch ? (statusMatch[2] || '') : ''

	const headers = new Headers()
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]
		const colonIdx = line.indexOf(':')
		if (colonIdx > 0) {
			headers.append(line.slice(0, colonIdx).trim(), line.slice(colonIdx + 1).trim())
		}
	}

	return { status, statusText, headers, bodyStart: headerEnd + 4 }
}

/**
 * Send an HTTP request over an established TCP connection and return
 * a reader { read(buf, off, len), close() } for the response.
 * Handles TLS handshake if isHttps. On error, cleans up fd before throwing.
 */
async function sendRequest(fd, host, isHttps, reqBytes, bodyBytes, signal) {
	if (isHttps) {
		ensureCACerts()
		const conn = tls.connect(fd, host)
		try {
			await tls.handshake(conn, fd, signal)
			await tls.writeAll(conn, fd, reqBytes, signal)
			if (bodyBytes) await tls.writeAll(conn, fd, bodyBytes, signal)
		} catch (e) {
			try { await tls.close(conn, fd) } catch {}
			try { os.close(fd) } catch {}
			throw e
		}
		let closed = false
		return {
			read(buf, off, len) {
				return tls.read(conn, fd, buf, off, len, signal)
			},
			async close() {
				if (closed) return
				closed = true
				try { await tls.close(conn, fd) } catch {}
				try { os.close(fd) } catch {}
			},
		}
	}

	try {
		await writeAllSocket(fd, reqBytes, signal)
		if (bodyBytes) await writeAllSocket(fd, bodyBytes, signal)
	} catch (e) {
		os.close(fd)
		throw e
	}
	let closed = false
	return {
		read(buf, off, len) {
			return socketReadAsync(fd, buf, off, len, signal)
		},
		close() {
			if (closed) return
			closed = true
			os.close(fd)
		},
	}
}

/**
 * Read HTTP response headers from a reader.
 * Returns { status, statusText, headers, leftover } or null on error.
 */
async function readResponseHead(reader) {
	const buf = new ArrayBuffer(65536)
	let accumulated = new Uint8Array(0)

	while (true) {
		const parsed = parseResponseHead(accumulated)
		if (parsed) {
			return {
				status: parsed.status,
				statusText: parsed.statusText,
				headers: parsed.headers,
				leftover: accumulated.subarray(parsed.bodyStart),
			}
		}

		const n = await reader.read(buf, 0, 65536)
		if (n <= 0) break
		const prev = accumulated
		accumulated = new Uint8Array(prev.length + n)
		accumulated.set(prev, 0)
		accumulated.set(new Uint8Array(buf, 0, n), prev.length)
	}

	return null
}

/**
 * Async generator that streams body data from a reader.
 * Handles Content-Length, chunked transfer-encoding, and connection-close framing.
 * Owns the reader — closes it when done or on error.
 */
async function* bodyStream(reader, leftover, contentLength, isChunked) {
	try {
		if (isChunked) {
			// Buffer chunked data and decode (chunk framing makes true streaming complex)
			let buffer = leftover
			const readBuf = new ArrayBuffer(65536)
			while (!isChunkedComplete(buffer)) {
				const n = await reader.read(readBuf, 0, 65536)
				if (n <= 0) break
				const prev = buffer
				buffer = new Uint8Array(prev.length + n)
				buffer.set(prev, 0)
				buffer.set(new Uint8Array(readBuf, 0, n), prev.length)
			}
			yield decodeChunked(buffer)
		} else if (contentLength !== null) {
			let remaining = contentLength
			if (leftover.length > 0) {
				const toYield = leftover.subarray(0, Math.min(leftover.length, remaining))
				remaining -= toYield.length
				if (toYield.length > 0) yield toYield
			}
			const readBuf = new ArrayBuffer(65536)
			while (remaining > 0) {
				const n = await reader.read(readBuf, 0, Math.min(remaining, 65536))
				if (n <= 0) break
				remaining -= n
				yield new Uint8Array(readBuf.slice(0, n))
			}
		} else {
			// Read until connection close
			if (leftover.length > 0) yield leftover
			const readBuf = new ArrayBuffer(65536)
			for (;;) {
				const n = await reader.read(readBuf, 0, 65536)
				if (n <= 0) break
				yield new Uint8Array(readBuf.slice(0, n))
			}
		}
	} finally {
		await reader.close()
	}
}

/**
 * Fetch a resource from the network
 *
 * @param {string|URL} input - The URL to fetch
 * @param {Object} [init] - Optional configuration
 * @returns {Promise<Response>}
 */
export async function fetch(input, init = {}) {
	let url
	if (input instanceof URL) {
		url = input
	} else if (typeof input === 'string') {
		try {
			url = new URL(input)
		} catch {
			throw new TypeError(`Invalid URL: ${input}`)
		}
	} else {
		throw new TypeError('Input must be a string or URL')
	}

	const signal = init.signal || null
	if (signal?.aborted) {
		throw signal.reason
	}

	const method = (init.method || 'GET').toUpperCase()
	const headers = init.headers instanceof Headers
		? new Headers(init.headers)
		: new Headers(init.headers || {})

	let bodyBytes = null
	if (init.body !== undefined && init.body !== null) {
		if (typeof init.body === 'string') {
			bodyBytes = new TextEncoder().encode(init.body)
			if (!headers.has('content-type')) {
				headers.set('content-type', 'text/plain;charset=UTF-8')
			}
		} else if (init.body instanceof Uint8Array) {
			bodyBytes = init.body
		} else if (init.body instanceof ArrayBuffer) {
			bodyBytes = new Uint8Array(init.body)
		} else {
			throw new TypeError('Unsupported body type')
		}
		headers.set('content-length', String(bodyBytes.byteLength))
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

		let fd
		try {
			fd = await tcpConnect(host, port, signal)
		} catch (e) {
			if (signal?.aborted) throw signal.reason
			throw new TypeError(`fetch failed: ${e.message}`)
		}

		const reqStr = buildRequest(method, path, host, port, headers, isDefaultPort)
		const reqBytes = new TextEncoder().encode(reqStr)

		let reader
		try {
			reader = await sendRequest(fd, host, isHttps, reqBytes, bodyBytes, signal)
		} catch (e) {
			if (signal?.aborted) throw signal.reason
			throw e instanceof TypeError ? e : new TypeError(`fetch failed: ${e.message}`)
		}

		try {
			const head = await readResponseHead(reader)
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
				url = new URL(location, url)
				redirected = true
				continue
			}

			const te = head.headers.get('transfer-encoding')
			const cl = head.headers.get('content-length')
			const isChunked = te && te.toLowerCase().includes('chunked')
			const contentLength = cl !== null ? parseInt(cl, 10) : null
			if (isChunked) head.headers.delete('transfer-encoding')

			const body = bodyStream(reader, head.leftover, contentLength, isChunked)
			reader = null

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

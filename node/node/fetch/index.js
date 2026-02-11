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
import {
	tlsLoadCACerts, tlsConnect, tlsRead, tlsWriteAll, tlsFlush, tlsClose,
} from 'qn_tls'
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
		tlsLoadCACerts(sslCertFile)
	} else {
		for (const p of SYSTEM_CA_PATHS) {
			if (existsSync(p)) {
				tlsLoadCACerts(p)
				break
			}
		}
	}

	const extraCerts = globalThis.process?.env?.NODE_EXTRA_CA_CERTS
	if (extraCerts) {
		tlsLoadCACerts(extraCerts)
	}
}

const MAX_REDIRECTS = 20

function isRedirectStatus(status) {
	return [301, 302, 303, 307, 308].includes(status)
}

/**
 * Connect a TCP socket to host:port, blocking via event loop.
 */
function tcpConnect(host, port) {
	const addrs = _getaddrinfo(host, port, { family: AF_INET })
	if (addrs.length === 0) {
		const addrs6 = _getaddrinfo(host, port)
		if (addrs6.length === 0) throw new TypeError(`fetch failed: DNS lookup failed for ${host}`)
		addrs.push(...addrs6)
	}

	const fd = _socket(addrs[0].family, SOCK_STREAM)
	const ret = _connect(fd, addrs[0].address, port)

	if (ret === -EINPROGRESS) {
		// Wait for connect to complete via event loop
		return new Promise((resolve, reject) => {
			os.setWriteHandler(fd, () => {
				os.setWriteHandler(fd, null)
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
 * Blocking read all available data from a plain socket fd.
 * Reads until the read handler fires, then reads everything available.
 */
function readAllSocket(fd) {
	return new Promise((resolve, reject) => {
		const chunks = []
		const buf = new ArrayBuffer(65536)

		os.setReadHandler(fd, () => {
			const n = _recv(fd, buf, 0, 65536)
			if (n === -EAGAIN) return
			if (n <= 0) {
				os.setReadHandler(fd, null)
				resolve(concatChunks(chunks))
				return
			}
			chunks.push(new Uint8Array(buf.slice(0, n)))
		})
	})
}

/**
 * Read exactly `count` bytes from a TLS connection (blocking).
 */
function tlsReadExact(tls, count) {
	const chunks = []
	let remaining = count
	const buf = new ArrayBuffer(65536)
	while (remaining > 0) {
		const toRead = Math.min(remaining, 65536)
		const n = tlsRead(tls, buf, 0, toRead)
		if (n <= 0) break
		chunks.push(new Uint8Array(buf.slice(0, n)))
		remaining -= n
	}
	return concatChunks(chunks)
}

/**
 * Read all data from a TLS connection until EOF (blocking).
 */
function tlsReadUntilClose(tls) {
	const chunks = []
	const buf = new ArrayBuffer(65536)
	for (;;) {
		const n = tlsRead(tls, buf, 0, 65536)
		if (n <= 0) break
		chunks.push(new Uint8Array(buf.slice(0, n)))
	}
	return concatChunks(chunks)
}

/**
 * Read HTTP response from a TLS connection.
 * Parses headers incrementally, then reads the body based on
 * Content-Length or Transfer-Encoding to avoid blocking on EOF.
 */
function readHttpResponseTls(tls) {
	const buf = new ArrayBuffer(65536)
	let accumulated = new Uint8Array(0)

	// Read until we have the full header block
	while (true) {
		const parsed = parseResponseHead(accumulated)
		if (parsed) {
			const bodyData = accumulated.subarray(parsed.bodyStart)
			const te = parsed.headers.get('transfer-encoding')
			const cl = parsed.headers.get('content-length')
			const isChunked = te && te.toLowerCase().includes('chunked')

			if (isChunked) {
				// Read chunked body - we might already have some/all of it
				let chunkedData = bodyData
				while (!isChunkedComplete(chunkedData)) {
					const n = tlsRead(tls, buf, 0, 65536)
					if (n <= 0) break
					const prev = chunkedData
					chunkedData = new Uint8Array(prev.length + n)
					chunkedData.set(prev, 0)
					chunkedData.set(new Uint8Array(buf.slice(0, n)), prev.length)
				}
				const body = decodeChunked(chunkedData)
				parsed.headers.delete('transfer-encoding')
				return { ...parsed, body }
			} else if (cl !== null) {
				const contentLength = parseInt(cl, 10)
				const remaining = contentLength - bodyData.length
				let body
				if (remaining <= 0) {
					body = bodyData.subarray(0, contentLength)
				} else {
					const rest = tlsReadExact(tls, remaining)
					body = new Uint8Array(bodyData.length + rest.length)
					body.set(bodyData, 0)
					body.set(rest, bodyData.length)
				}
				return { ...parsed, body }
			} else {
				// No Content-Length, no chunked: read until connection close
				const rest = tlsReadUntilClose(tls)
				const body = new Uint8Array(bodyData.length + rest.length)
				body.set(bodyData, 0)
				body.set(rest, bodyData.length)
				return { ...parsed, body }
			}
		}

		const n = tlsRead(tls, buf, 0, 65536)
		if (n <= 0) break
		const prev = accumulated
		accumulated = new Uint8Array(prev.length + n)
		accumulated.set(prev, 0)
		accumulated.set(new Uint8Array(buf.slice(0, n)), prev.length)
	}

	return null
}

/**
 * Check if chunked data is complete by walking chunk boundaries.
 * Returns true when we've seen the terminating 0-length chunk.
 */
function isChunkedComplete(data) {
	let pos = 0
	while (pos < data.length) {
		// Find end of chunk size line
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

		// Skip: chunk size line (\r\n) + chunk data + trailing \r\n
		const nextPos = lineEnd + 2 + chunkSize + 2
		if (nextPos > data.length) return false
		pos = nextPos
	}
	return false
}

/**
 * Write all data to a plain socket via event loop.
 */
function writeAllSocket(fd, data) {
	return new Promise((resolve, reject) => {
		let offset = 0
		const buf = data.buffer instanceof ArrayBuffer ? data.buffer : new ArrayBuffer(data.byteLength)
		if (buf !== data.buffer) new Uint8Array(buf).set(data)

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
					reject(new TypeError('fetch failed: write error'))
					return
				}
				offset += n
			}
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

/**
 * Race a promise against an AbortSignal.
 * On abort, closes the socket fd to unblock any pending reads.
 */
function raceAbort(signal, promise, fd) {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			os.setReadHandler(fd, null)
			reject(signal.reason)
		}
		signal.addEventListener('abort', onAbort, { once: true })
		promise.then(
			v => { signal.removeEventListener('abort', onAbort); resolve(v) },
			e => { signal.removeEventListener('abort', onAbort); reject(e) },
		)
	})
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
 * Decode a chunked transfer-encoded body.
 * Each chunk: <hex-size>\r\n<data>\r\n ... ending with 0\r\n\r\n
 */
function decodeChunked(data) {
	const chunks = []
	let pos = 0
	while (pos < data.length) {
		// Find end of chunk size line
		let lineEnd = -1
		for (let i = pos; i < data.length - 1; i++) {
			if (data[i] === 0x0d && data[i + 1] === 0x0a) {
				lineEnd = i
				break
			}
		}
		if (lineEnd === -1) break

		const sizeLine = new TextDecoder().decode(data.subarray(pos, lineEnd))
		// Chunk size may have extensions after semicolon
		const chunkSize = parseInt(sizeLine.split(';')[0].trim(), 16)
		if (isNaN(chunkSize)) break
		if (chunkSize === 0) break

		const dataStart = lineEnd + 2
		const dataEnd = dataStart + chunkSize
		if (dataEnd > data.length) break

		chunks.push(data.subarray(dataStart, dataEnd))
		// Skip past chunk data and trailing \r\n
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
		} catch (e) {
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
			fd = await tcpConnect(host, port)
		} catch (e) {
			throw new TypeError(`fetch failed: ${e.message}`)
		}

		let responseData
		try {
			const reqStr = buildRequest(method, path, host, port, headers, isDefaultPort)

			if (isHttps) {
				ensureCACerts()
				const tls = tlsConnect(fd, host)
				try {
					const reqBytes = new TextEncoder().encode(reqStr)
					const reqBuf = reqBytes.buffer.slice(
						reqBytes.byteOffset,
						reqBytes.byteOffset + reqBytes.byteLength
					)
					tlsWriteAll(tls, reqBuf, 0, reqBytes.byteLength)
					if (bodyBytes) {
						const bodyBuf = bodyBytes.buffer.slice(
							bodyBytes.byteOffset,
							bodyBytes.byteOffset + bodyBytes.byteLength
						)
						tlsWriteAll(tls, bodyBuf, 0, bodyBytes.byteLength)
					}
					tlsFlush(tls)

					const httpResp = readHttpResponseTls(tls)
					if (!httpResp) {
						throw new TypeError('fetch failed: invalid HTTP response')
					}

					// Handle redirects
					if (isRedirectStatus(httpResp.status)) {
						if (redirectMode === 'error') {
							throw new TypeError('fetch failed: redirect encountered')
						}
						if (redirectMode === 'manual') {
							return new Response(httpResp.body, {
								status: httpResp.status,
								statusText: httpResp.statusText,
								headers: httpResp.headers,
								url: url.href,
								redirected,
							})
						}
						redirectCount++
						if (redirectCount > MAX_REDIRECTS) {
							throw new TypeError('fetch failed: too many redirects')
						}
						const location = httpResp.headers.get('location')
						if (!location) {
							throw new TypeError('fetch failed: redirect without Location header')
						}
						url = new URL(location, url)
						redirected = true
						continue
					}

					return new Response(httpResp.body, {
						status: httpResp.status,
						statusText: httpResp.statusText,
						headers: httpResp.headers,
						url: url.href,
						redirected,
					})
				} finally {
					tlsClose(tls)
				}
			} else {
				const reqBytes = new TextEncoder().encode(reqStr)
				await writeAllSocket(fd, reqBytes)
				if (bodyBytes) {
					await writeAllSocket(fd, bodyBytes)
				}
				// Race the socket read against abort signal
				if (signal) {
					responseData = await raceAbort(signal, readAllSocket(fd), fd)
				} else {
					responseData = await readAllSocket(fd)
				}
			}
		} finally {
			os.close(fd)
		}

		const parsed = parseResponseHead(responseData)
		if (!parsed) {
			throw new TypeError('fetch failed: invalid HTTP response')
		}

		const te = parsed.headers.get('transfer-encoding')
		const isChunked = te && te.toLowerCase().includes('chunked')
		const rawBody = responseData.subarray(parsed.bodyStart)
		const body = isChunked ? decodeChunked(rawBody) : rawBody

		// Remove transfer-encoding header since we've decoded the body
		if (isChunked) parsed.headers.delete('transfer-encoding')

		// Handle redirects
		if (isRedirectStatus(parsed.status)) {
			if (redirectMode === 'error') {
				throw new TypeError('fetch failed: redirect encountered')
			}
			if (redirectMode === 'manual') {
				return new Response(body, {
					status: parsed.status,
					statusText: parsed.statusText,
					headers: parsed.headers,
					url: url.href,
					redirected,
				})
			}
			// follow mode
			redirectCount++
			if (redirectCount > MAX_REDIRECTS) {
				throw new TypeError('fetch failed: too many redirects')
			}

			const location = parsed.headers.get('location')
			if (!location) {
				throw new TypeError('fetch failed: redirect without Location header')
			}

			url = new URL(location, url)
			redirected = true
			continue
		}

		return new Response(body, {
			status: parsed.status,
			statusText: parsed.statusText,
			headers: parsed.headers,
			url: url.href,
			redirected,
		})
	}
}

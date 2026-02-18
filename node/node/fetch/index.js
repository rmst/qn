/**
 * Fetch API implementation using native sockets + BearSSL TLS
 * https://fetch.spec.whatwg.org/
 */

import * as os from 'os'
import {
	socket as _socket, connect as _connect, connectFinish as _connectFinish,
	send as _send, recv as _recv,
	AF_INET, SOCK_STREAM, EAGAIN, EINPROGRESS,
} from 'qn_socket'
import { getaddrinfo as _getaddrinfo } from 'qn_uv_dns'
import * as tls from 'node:tls'
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
async function tcpConnect(host, port, signal) {
	if (signal?.aborted) throw signal.reason

	let addrs = await _getaddrinfo(host, port, { family: AF_INET })
	if (signal?.aborted) throw signal.reason
	if (addrs.length === 0) {
		addrs = await _getaddrinfo(host, port)
		if (addrs.length === 0) throw new TypeError(`fetch failed: DNS lookup failed for ${host}`)
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

	return fd
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

function buildRequest(method, path, host, port, headers, isDefaultPort) {
	return _buildRequest(method, path, host, port, headers, isDefaultPort)
}

/**
 * Send an HTTP request over an established TCP connection and return
 * a reader { read(buf, off, len), close() } for the response.
 * Handles TLS handshake if isHttps. On error, cleans up fd before throwing.
 */
async function sendRequest(fd, host, isHttps, reqBytes, bodyBytes, bodyIter, signal) {
	if (isHttps) {
		ensureCACerts()
		const conn = tls.connect(fd, host)
		try {
			await tls.handshake(conn, fd, signal)
			await tls.writeAll(conn, fd, reqBytes, signal)
			if (bodyBytes) await tls.writeAll(conn, fd, bodyBytes, signal)
			else if (bodyIter) await writeChunkedBody(data => tls.writeAll(conn, fd, data, signal), bodyIter)
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
		else if (bodyIter) await writeChunkedBody(data => writeAllSocket(fd, data, signal), bodyIter)
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
			reader = await sendRequest(fd, host, isHttps, reqBytes, bodyBytes, bodyIter, signal)
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

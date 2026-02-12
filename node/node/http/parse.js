/**
 * Shared HTTP/1.1 parsing utilities.
 *
 * Used by node:fetch, node:http, and qn:wireguard for transport-independent
 * HTTP request/response parsing and serialization.
 */

import { Headers } from 'node:fetch/Headers'

export function concatChunks(chunks) {
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
 * Check if chunked data is complete by walking chunk boundaries.
 */
export function isChunkedComplete(data) {
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
export function decodeChunked(data) {
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
export function parseResponseHead(data) {
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
 * Parse an HTTP request from raw data.
 * Returns { method, url, httpVersion, headers, rawHeaders, headerEnd }
 * or null if headers aren't complete yet.
 */
export function parseRequestHead(data) {
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
 * Build an HTTP/1.1 request string.
 */
export function buildRequest(method, path, host, port, headers, isDefaultPort) {
	const hostHeader = isDefaultPort ? host : `${host}:${port}`
	let req = `${method} ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n`
	for (const [key, value] of headers) {
		if (key.toLowerCase() === 'host') continue
		if (/[\r\n]/.test(key) || /[\r\n]/.test(value))
			throw new TypeError(`Invalid header: ${key}`)
		req += `${key}: ${value}\r\n`
	}
	req += '\r\n'
	return req
}

/**
 * Read HTTP response headers from a reader ({ read(buf, off, len) }).
 * Returns { status, statusText, headers, leftover } or null on error.
 */
export async function readResponseHead(reader) {
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
 * Read HTTP request headers from a reader ({ read(buf, off, len) }).
 * Returns { method, url, httpVersion, headers, rawHeaders, leftover } or null.
 */
export async function readRequestHead(reader) {
	const buf = new ArrayBuffer(65536)
	let accumulated = new Uint8Array(0)

	while (true) {
		const parsed = parseRequestHead(accumulated)
		if (parsed) {
			return {
				method: parsed.method,
				url: parsed.url,
				httpVersion: parsed.httpVersion,
				headers: parsed.headers,
				rawHeaders: parsed.rawHeaders,
				leftover: accumulated.subarray(parsed.headerEnd),
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
 * Create an async iterable that streams a content-length framed request body.
 * Does NOT close the reader — suitable for server-side body reading where
 * the connection must remain open for the response.
 */
export function requestBodyStream(reader, leftover, contentLength) {
	let remaining = contentLength
	let first = true
	return {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					if (first && leftover.length > 0) {
						first = false
						const take = leftover.subarray(0, Math.min(leftover.length, remaining))
						remaining -= take.length
						if (take.length > 0)
							return { value: take, done: false }
					}
					first = false
					if (remaining <= 0) return { done: true }
					const readBuf = new ArrayBuffer(65536)
					const n = await reader.read(readBuf, 0, Math.min(remaining, 65536))
					if (n <= 0) return { done: true }
					remaining -= n
					return { value: new Uint8Array(readBuf, 0, n), done: false }
				},
			}
		},
	}
}

/**
 * Create an async iterable that reads a chunked request body.
 * Does NOT close the reader — suitable for server-side body reading.
 */
export function chunkedRequestBodyStream(reader, leftover) {
	return {
		async *[Symbol.asyncIterator]() {
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
		},
	}
}

/**
 * Write an async iterable body using chunked transfer-encoding.
 * @param {(data: Uint8Array) => Promise<void>} writeFn - Write function
 * @param {AsyncIterable<Uint8Array|string>} iterable - Body chunks
 */
export async function writeChunkedBody(writeFn, iterable) {
	const encoder = new TextEncoder()
	for await (const chunk of iterable) {
		const data = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
		await writeFn(encoder.encode(data.byteLength.toString(16) + '\r\n'))
		await writeFn(data)
		await writeFn(encoder.encode('\r\n'))
	}
	await writeFn(encoder.encode('0\r\n\r\n'))
}

/**
 * Async generator that streams body data from a reader.
 * Handles Content-Length, chunked transfer-encoding, and connection-close framing.
 * Owns the reader — closes it when done or on error.
 */
export async function* bodyStream(reader, leftover, contentLength, isChunked) {
	try {
		if (isChunked) {
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

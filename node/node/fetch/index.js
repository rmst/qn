/**
 * Fetch API implementation using curl
 * https://fetch.spec.whatwg.org/
 */

import { execFile } from 'node:child_process'
import { Headers } from './Headers.js'
import { Response } from './Response.js'

export { Headers, Response }

/**
 * Build curl arguments from fetch options
 */
function buildCurlArgs(url, options) {
	const args = [
		'-sS',          // Silent mode (no progress) but show errors
		'-i',           // Include response headers
		'-L',           // Follow redirects
		'--max-redirs', '20',
	]

	// HTTP method
	const method = (options.method || 'GET').toUpperCase()
	if (method !== 'GET') {
		args.push('-X', method)
	}

	// Normalize headers
	const headers = options.headers instanceof Headers
		? new Headers(options.headers)
		: new Headers(options.headers || {})

	// Request body
	if (options.body !== undefined && options.body !== null) {
		// Use --data-binary @- to read from stdin
		args.push('--data-binary', '@-')

		let bodyBytes
		if (typeof options.body === 'string') {
			bodyBytes = new TextEncoder().encode(options.body)
			// Set default Content-Type for string bodies (per fetch spec)
			if (!headers.has('content-type')) {
				headers.set('content-type', 'text/plain;charset=UTF-8')
			}
		} else if (options.body instanceof Uint8Array) {
			bodyBytes = options.body
		} else if (options.body instanceof ArrayBuffer) {
			bodyBytes = new Uint8Array(options.body)
		} else {
			throw new TypeError('Unsupported body type')
		}
		options._bodyBytes = bodyBytes
	}

	// Add headers to curl args
	for (const [key, value] of headers) {
		args.push('-H', `${key}: ${value}`)
	}

	// Redirect handling
	if (options.redirect === 'error') {
		// Remove -L, curl will not follow redirects
		const idx = args.indexOf('-L')
		if (idx !== -1) args.splice(idx, 1)
		// Remove --max-redirs
		const maxIdx = args.indexOf('--max-redirs')
		if (maxIdx !== -1) args.splice(maxIdx, 2)
	} else if (options.redirect === 'manual') {
		const idx = args.indexOf('-L')
		if (idx !== -1) args.splice(idx, 1)
		const maxIdx = args.indexOf('--max-redirs')
		if (maxIdx !== -1) args.splice(maxIdx, 2)
	}

	// URL comes last, with -- to prevent option injection
	args.push('--', url)

	return args
}

/**
 * Parse curl response (headers + body)
 * When following redirects, curl -i outputs multiple response headers.
 * We need to find and parse the final response.
 */
function parseResponse(data, requestUrl) {
	// Convert to string to find HTTP headers pattern
	// With -L -i, curl outputs headers for each redirect followed by headers for final response
	// We need to find the LAST set of headers

	let offset = 0
	let redirected = false

	// Keep finding HTTP responses until we reach the final one
	while (true) {
		// Find the header/body boundary from current offset
		let headerEnd = -1
		for (let i = offset; i < data.length - 3; i++) {
			if (data[i] === 0x0d && data[i + 1] === 0x0a &&
				data[i + 2] === 0x0d && data[i + 3] === 0x0a) {
				headerEnd = i
				break
			}
		}

		// Fallback: try \n\n
		if (headerEnd === -1) {
			for (let i = offset; i < data.length - 1; i++) {
				if (data[i] === 0x0a && data[i + 1] === 0x0a) {
					headerEnd = i
					break
				}
			}
		}

		if (headerEnd === -1) {
			// No headers found, treat entire response as body
			return {
				status: 200,
				statusText: 'OK',
				headers: new Headers(),
				body: data.slice(offset),
				redirected,
			}
		}

		// Body starts after \r\n\r\n or \n\n
		// headerEnd points to first byte of the boundary sequence
		const bodyStart = data[headerEnd] === 0x0a
			? headerEnd + 2   // \n\n case (headerEnd is first \n)
			: headerEnd + 4   // \r\n\r\n case (headerEnd is first \r)

		// Check if body starts with another HTTP status line (indicating a redirect was followed)
		// Look for "HTTP/" at the start of the body
		if (bodyStart < data.length - 5 &&
			data[bodyStart] === 0x48 &&     // H
			data[bodyStart + 1] === 0x54 && // T
			data[bodyStart + 2] === 0x54 && // T
			data[bodyStart + 3] === 0x50 && // P
			data[bodyStart + 4] === 0x2f) { // /
			// This is another HTTP response, continue parsing from here
			offset = bodyStart
			redirected = true
			continue
		}

		// This is the final response
		const headerBytes = data.slice(offset, headerEnd)
		const headerText = new TextDecoder().decode(headerBytes)
		const headerLines = headerText.split(/\r?\n/)

		// Parse status line: "HTTP/1.1 200 OK" or "HTTP/2 200"
		const statusLine = headerLines[0] || ''
		const statusMatch = statusLine.match(/^HTTP\/[\d.]+ (\d+)(?: (.*))?$/)
		const status = statusMatch ? parseInt(statusMatch[1], 10) : 0
		const statusText = statusMatch ? (statusMatch[2] || '') : ''

		// Parse headers
		const headers = new Headers()
		for (let i = 1; i < headerLines.length; i++) {
			const line = headerLines[i]
			const colonIdx = line.indexOf(':')
			if (colonIdx > 0) {
				const key = line.slice(0, colonIdx).trim()
				const value = line.slice(colonIdx + 1).trim()
				headers.append(key, value)
			}
		}

		const body = data.slice(bodyStart)

		return {
			status,
			statusText,
			headers,
			body,
			redirected,
		}
	}
}

/**
 * Handle redirect responses when redirect mode is 'error'
 */
function isRedirectStatus(status) {
	return [301, 302, 303, 307, 308].includes(status)
}

/**
 * Fetch a resource from the network
 *
 * @param {string|URL} input - The URL to fetch
 * @param {Object} [init] - Optional configuration
 * @param {string} [init.method='GET'] - HTTP method
 * @param {Headers|Object|Array} [init.headers] - Request headers
 * @param {string|Uint8Array|ArrayBuffer} [init.body] - Request body
 * @param {string} [init.redirect='follow'] - Redirect mode: 'follow', 'error', or 'manual'
 * @param {AbortSignal} [init.signal] - AbortSignal for cancellation
 * @returns {Promise<Response>}
 */
export function fetch(input, init = {}) {
	return new Promise((resolve, reject) => {
		// Normalize URL
		let url
		if (input instanceof URL) {
			url = input.href
		} else if (typeof input === 'string') {
			// Validate URL
			try {
				url = new URL(input).href
			} catch (e) {
				reject(new TypeError(`Invalid URL: ${input}`))
				return
			}
		} else {
			reject(new TypeError('Input must be a string or URL'))
			return
		}

		const options = { ...init }
		const args = buildCurlArgs(url, options)

		// Set up timeout handling
		let timeoutId = null
		let aborted = false

		const child = execFile('curl', args, (error, stdout, stderr) => {
			if (timeoutId !== null) {
				clearTimeout(timeoutId)
			}

			if (aborted) {
				reject(new DOMException('The operation was aborted', 'AbortError'))
				return
			}

			if (error && error.killed) {
				reject(new DOMException('The operation was aborted', 'AbortError'))
				return
			}

			if (error) {
				// Check if curl is not found (exit code 127)
				if (error.code === 127) {
					reject(new TypeError('fetch failed: curl is required but not found in PATH'))
					return
				}
				// curl failed (network error, DNS failure, etc.)
				// stderr contains the actual curl error message
				const stderrText = stderr && stderr.length > 0
					? (typeof stderr === 'string' ? stderr : new TextDecoder().decode(stderr)).trim()
					: null
				const errorDetail = stderrText || error.message
				reject(new TypeError(`fetch failed: ${errorDetail}`))
				return
			}

			// Parse the response
			const parsed = parseResponse(stdout, url)

			// Handle redirect mode
			if (options.redirect === 'error' && isRedirectStatus(parsed.status)) {
				reject(new TypeError('fetch failed: redirect encountered'))
				return
			}

			const response = new Response(parsed.body, {
				status: parsed.status,
				statusText: parsed.statusText,
				headers: parsed.headers,
				url: url,
				redirected: parsed.redirected,
			})

			resolve(response)
		})

		// Write body to stdin if present
		if (options._bodyBytes) {
			child.stdin.write(options._bodyBytes)
			child.stdin.end()
		}

		// Handle AbortSignal
		if (init.signal) {
			if (init.signal.aborted) {
				aborted = true
				child.kill()
				reject(new DOMException('The operation was aborted', 'AbortError'))
				return
			}

			init.signal.addEventListener('abort', () => {
				aborted = true
				child.kill()
			})
		}
	})
}

/**
 * Request class - WHATWG Fetch Standard compliant
 * https://fetch.spec.whatwg.org/#request-class
 */

import { Headers } from './Headers.js'

export class Request {
	constructor(input, init = {}) {
		if (input instanceof Request) {
			this._url = input._url
			this._method = init.method ? init.method.toUpperCase() : input._method
			this._headers = new Headers(init.headers || input._headers)
			this._body = init.body !== undefined ? normalizeBody(init.body) : input._body
			this._bodyStream = init.body !== undefined ? normalizeBodyStream(init.body) : input._bodyStream || null
			this._signal = init.signal || input._signal || null
		} else {
			this._url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input)
			this._method = (init.method || 'GET').toUpperCase()
			this._headers = init.headers instanceof Headers
				? new Headers(init.headers)
				: new Headers(init.headers || {})
			const rawBody = init.body !== undefined && init.body !== null ? init.body : null
			this._body = rawBody ? normalizeBody(rawBody) : null
			this._bodyStream = rawBody ? normalizeBodyStream(rawBody) : null
			this._signal = init.signal || null
		}
		this._bodyUsed = false
	}

	get url() { return this._url }
	get method() { return this._method }
	get headers() { return this._headers }
	get signal() { return this._signal }
	get bodyUsed() { return this._bodyUsed }
	get redirect() { return 'follow' }
	get mode() { return 'cors' }
	get credentials() { return 'same-origin' }
	get referrer() { return 'about:client' }
	get referrerPolicy() { return '' }

	get body() {
		if (this._bodyStream) return this._bodyStream
		return this._body
	}

	async _consumeBody() {
		if (this._bodyUsed) {
			throw new TypeError('Body has already been consumed')
		}
		this._bodyUsed = true
		if (this._bodyStream) {
			const chunks = []
			for await (const chunk of this._bodyStream) {
				chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
			}
			if (chunks.length === 0) return null
			if (chunks.length === 1) return chunks[0]
			const total = chunks.reduce((sum, c) => sum + c.length, 0)
			const result = new Uint8Array(total)
			let off = 0
			for (const c of chunks) { result.set(c, off); off += c.length }
			return result
		}
		return this._body
	}

	async arrayBuffer() {
		const body = await this._consumeBody()
		if (body === null) return new ArrayBuffer(0)
		return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
	}

	async text() {
		const body = await this._consumeBody()
		if (body === null) return ''
		return new TextDecoder().decode(body)
	}

	async json() {
		const text = await this.text()
		return JSON.parse(text)
	}

	async blob() {
		throw new TypeError('Request.blob() is not supported')
	}

	async formData() {
		throw new TypeError('Request.formData() is not supported')
	}

	clone() {
		if (this._bodyUsed) {
			throw new TypeError('Cannot clone a Request whose body has been used')
		}
		return new Request(this)
	}

	get [Symbol.toStringTag]() {
		return 'Request'
	}
}

function normalizeBody(body) {
	if (typeof body === 'string') {
		return new TextEncoder().encode(body)
	}
	if (body instanceof Uint8Array) {
		return body
	}
	if (body instanceof ArrayBuffer) {
		return new Uint8Array(body)
	}
	return null
}

function normalizeBodyStream(body) {
	if (typeof body?.[Symbol.asyncIterator] === 'function') {
		return body
	}
	return null
}

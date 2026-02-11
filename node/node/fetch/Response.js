/**
 * Response class - WHATWG Fetch Standard compliant
 * https://fetch.spec.whatwg.org/#response-class
 */

import { Headers } from './Headers.js'

export class Response {
	constructor(body, init = {}) {
		if (typeof body === 'string') {
			this._body = new TextEncoder().encode(body)
		} else if (body instanceof ArrayBuffer) {
			this._body = new Uint8Array(body)
		} else {
			this._body = body // Uint8Array or null
		}
		this._bodyUsed = false

		this.status = init.status !== undefined ? init.status : 200
		this.statusText = init.statusText !== undefined ? init.statusText : ''
		this.ok = this.status >= 200 && this.status < 300
		this.redirected = init.redirected || false
		this.type = init.type || 'default'
		this.url = init.url || ''

		if (init.headers instanceof Headers) {
			this.headers = init.headers
		} else {
			this.headers = new Headers(init.headers)
		}
	}

	get bodyUsed() {
		return this._bodyUsed
	}

	_consumeBody() {
		if (this._bodyUsed) {
			throw new TypeError('Body has already been consumed')
		}
		this._bodyUsed = true
		return this._body
	}

	async arrayBuffer() {
		const body = this._consumeBody()
		if (body === null) {
			return new ArrayBuffer(0)
		}
		// Return a copy as ArrayBuffer
		return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
	}

	async text() {
		const body = this._consumeBody()
		if (body === null) {
			return ''
		}
		return new TextDecoder().decode(body)
	}

	async json() {
		const text = await this.text()
		return JSON.parse(text)
	}

	async blob() {
		throw new TypeError('Response.blob() is not supported')
	}

	async formData() {
		throw new TypeError('Response.formData() is not supported')
	}

	clone() {
		if (this._bodyUsed) {
			throw new TypeError('Cannot clone a Response whose body has been used')
		}
		return new Response(
			this._body ? new Uint8Array(this._body) : null,
			{
				status: this.status,
				statusText: this.statusText,
				headers: new Headers(this.headers),
				url: this.url,
				redirected: this.redirected,
				type: this.type,
			}
		)
	}

	static error() {
		const response = new Response(null, { status: 0, statusText: '' })
		response.type = 'error'
		return response
	}

	static redirect(url, status = 302) {
		if (![301, 302, 303, 307, 308].includes(status)) {
			throw new RangeError('Invalid redirect status code')
		}
		return new Response(null, {
			status,
			headers: { Location: url },
		})
	}

	static json(data, init = {}) {
		const body = JSON.stringify(data)
		const headers = new Headers(init.headers)
		if (!headers.has('content-type')) {
			headers.set('content-type', 'application/json')
		}
		return new Response(
			new TextEncoder().encode(body),
			{
				...init,
				headers,
			}
		)
	}

	get [Symbol.toStringTag]() {
		return 'Response'
	}
}

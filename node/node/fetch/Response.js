/**
 * Response class - WHATWG Fetch Standard compliant
 * https://fetch.spec.whatwg.org/#response-class
 */

import { Headers } from './Headers.js'

export class Response {
	constructor(body, init = {}) {
		this._bodyStream = null
		if (typeof body === 'string') {
			this._body = new TextEncoder().encode(body)
		} else if (body instanceof ArrayBuffer) {
			this._body = new Uint8Array(body)
		} else if (body instanceof Uint8Array || body === null || body === undefined) {
			this._body = body || null
		} else if (typeof body?.[Symbol.asyncIterator] === 'function') {
			this._body = null
			this._bodyStream = body
		} else {
			this._body = body
		}
		this._bodyUsed = false
		this._bodyObj = undefined

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

	get body() {
		if (this._bodyObj !== undefined) return this._bodyObj
		const self = this
		if (this._bodyStream) {
			this._bodyObj = {
				[Symbol.asyncIterator]() {
					if (self._bodyUsed) throw new TypeError('Body has already been consumed')
					self._bodyUsed = true
					return self._bodyStream[Symbol.asyncIterator]()
				},
				getReader() {
					const iter = this[Symbol.asyncIterator]()
					return {
						async read() {
							const { value, done } = await iter.next()
							return { value: done ? undefined : value, done }
						},
						releaseLock() {},
						cancel() {},
					}
				},
			}
		} else if (this._body) {
			this._bodyObj = {
				async *[Symbol.asyncIterator]() {
					if (self._bodyUsed) throw new TypeError('Body has already been consumed')
					self._bodyUsed = true
					yield self._body
				},
				getReader() {
					const iter = this[Symbol.asyncIterator]()
					return {
						async read() {
							const { value, done } = await iter.next()
							return { value: done ? undefined : value, done }
						},
						releaseLock() {},
						cancel() {},
					}
				},
			}
		} else {
			this._bodyObj = null
		}
		return this._bodyObj
	}

	async _consumeBody() {
		if (this._bodyUsed) {
			throw new TypeError('Body has already been consumed')
		}
		this._bodyUsed = true
		if (this._bodyStream) {
			const chunks = []
			for await (const chunk of this._bodyStream) {
				chunks.push(chunk)
			}
			if (chunks.length === 0) {
				this._body = new Uint8Array(0)
			} else if (chunks.length === 1) {
				this._body = chunks[0]
			} else {
				const total = chunks.reduce((sum, c) => sum + c.length, 0)
				const result = new Uint8Array(total)
				let off = 0
				for (const chunk of chunks) {
					result.set(chunk, off)
					off += chunk.length
				}
				this._body = result
			}
			this._bodyStream = null
		}
		return this._body
	}

	async arrayBuffer() {
		const body = await this._consumeBody()
		if (body === null) {
			return new ArrayBuffer(0)
		}
		// Return a copy as ArrayBuffer
		return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
	}

	async text() {
		const body = await this._consumeBody()
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
		if (this._bodyStream) {
			throw new TypeError('Cannot clone a streaming Response body')
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

/**
 * Headers class - WHATWG Fetch Standard compliant
 * https://fetch.spec.whatwg.org/#headers-class
 */

export class Headers {
	constructor(init) {
		this._headers = new Map()
		this._cookies = []

		if (init) {
			if (init instanceof Headers) {
				for (const [key, value] of init._headers) {
					this._headers.set(key, value)
				}
				this._cookies = [...init._cookies]
			} else if (Array.isArray(init)) {
				for (const [key, value] of init) {
					this.append(key, value)
				}
			} else if (typeof init === 'object') {
				for (const key of Object.keys(init)) {
					this.append(key, init[key])
				}
			}
		}
	}

	append(name, value) {
		const key = name.toLowerCase()
		if (key === 'set-cookie') {
			this._cookies.push(String(value))
			return
		}
		const existing = this._headers.get(key)
		if (existing !== undefined) {
			this._headers.set(key, existing + ', ' + value)
		} else {
			this._headers.set(key, String(value))
		}
	}

	delete(name) {
		const key = name.toLowerCase()
		if (key === 'set-cookie') {
			this._cookies = []
			return
		}
		this._headers.delete(key)
	}

	get(name) {
		const key = name.toLowerCase()
		if (key === 'set-cookie') {
			return this._cookies.length > 0 ? this._cookies.join(', ') : null
		}
		const value = this._headers.get(key)
		return value !== undefined ? value : null
	}

	getSetCookie() {
		return [...this._cookies]
	}

	has(name) {
		const key = name.toLowerCase()
		if (key === 'set-cookie') return this._cookies.length > 0
		return this._headers.has(key)
	}

	set(name, value) {
		const key = name.toLowerCase()
		if (key === 'set-cookie') {
			this._cookies = [String(value)]
			return
		}
		this._headers.set(key, String(value))
	}

	*entries() {
		yield* this._headers.entries()
		for (const cookie of this._cookies) {
			yield ['set-cookie', cookie]
		}
	}

	*keys() {
		yield* this._headers.keys()
		for (let i = 0; i < this._cookies.length; i++) {
			yield 'set-cookie'
		}
	}

	*values() {
		yield* this._headers.values()
		for (const cookie of this._cookies) {
			yield cookie
		}
	}

	forEach(callback, thisArg) {
		for (const [key, value] of this._headers) {
			callback.call(thisArg, value, key, this)
		}
		for (const cookie of this._cookies) {
			callback.call(thisArg, cookie, 'set-cookie', this)
		}
	}

	[Symbol.iterator]() {
		return this.entries()
	}

	get [Symbol.toStringTag]() {
		return 'Headers'
	}
}

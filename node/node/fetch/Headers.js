/**
 * Headers class - WHATWG Fetch Standard compliant
 * https://fetch.spec.whatwg.org/#headers-class
 */

export class Headers {
	constructor(init) {
		this._headers = new Map()

		if (init) {
			if (init instanceof Headers) {
				for (const [key, value] of init) {
					this.append(key, value)
				}
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
		const existing = this._headers.get(key)
		if (existing !== undefined) {
			this._headers.set(key, existing + ', ' + value)
		} else {
			this._headers.set(key, String(value))
		}
	}

	delete(name) {
		this._headers.delete(name.toLowerCase())
	}

	get(name) {
		const value = this._headers.get(name.toLowerCase())
		return value !== undefined ? value : null
	}

	has(name) {
		return this._headers.has(name.toLowerCase())
	}

	set(name, value) {
		this._headers.set(name.toLowerCase(), String(value))
	}

	entries() {
		return this._headers.entries()
	}

	keys() {
		return this._headers.keys()
	}

	values() {
		return this._headers.values()
	}

	forEach(callback, thisArg) {
		for (const [key, value] of this._headers) {
			callback.call(thisArg, value, key, this)
		}
	}

	[Symbol.iterator]() {
		return this._headers[Symbol.iterator]()
	}

	get [Symbol.toStringTag]() {
		return 'Headers'
	}
}

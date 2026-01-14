/**
 * Minimal EventEmitter implementation for Node.js compatibility.
 * @see https://nodejs.org/api/events.html
 */
export class EventEmitter {
	#listeners = {}

	/**
	 * @param {string} event
	 * @param {Function} listener
	 * @returns {this}
	 */
	on(event, listener) {
		if (!this.#listeners[event]) {
			this.#listeners[event] = []
		}
		this.#listeners[event].push(listener)
		return this
	}

	/**
	 * Alias for on()
	 * @param {string} event
	 * @param {Function} listener
	 * @returns {this}
	 */
	addListener(event, listener) {
		return this.on(event, listener)
	}

	/**
	 * @param {string} event
	 * @param {Function} listener
	 * @returns {this}
	 */
	once(event, listener) {
		const wrapper = (...args) => {
			this.removeListener(event, wrapper)
			listener.apply(this, args)
		}
		wrapper._originalListener = listener
		return this.on(event, wrapper)
	}

	/**
	 * @param {string} event
	 * @param {Function} listener
	 * @returns {this}
	 */
	removeListener(event, listener) {
		const listeners = this.#listeners[event]
		if (!listeners) return this

		const index = listeners.findIndex(
			l => l === listener || l._originalListener === listener
		)
		if (index !== -1) {
			listeners.splice(index, 1)
		}
		return this
	}

	/**
	 * Alias for removeListener()
	 * @param {string} event
	 * @param {Function} listener
	 * @returns {this}
	 */
	off(event, listener) {
		return this.removeListener(event, listener)
	}

	/**
	 * @param {string} [event]
	 * @returns {this}
	 */
	removeAllListeners(event) {
		if (event === undefined) {
			this.#listeners = {}
		} else {
			delete this.#listeners[event]
		}
		return this
	}

	/**
	 * @param {string} event
	 * @param  {...any} args
	 * @returns {boolean}
	 */
	emit(event, ...args) {
		const listeners = this.#listeners[event]
		if (!listeners || listeners.length === 0) {
			return false
		}
		for (const listener of [...listeners]) {
			listener.apply(this, args)
		}
		return true
	}

	/**
	 * @param {string} event
	 * @returns {Function[]}
	 */
	listeners(event) {
		return this.#listeners[event] ? [...this.#listeners[event]] : []
	}

	/**
	 * @param {string} event
	 * @returns {number}
	 */
	listenerCount(event) {
		return this.#listeners[event] ? this.#listeners[event].length : 0
	}

	/**
	 * @returns {string[]}
	 */
	eventNames() {
		return Object.keys(this.#listeners)
	}
}

export default EventEmitter

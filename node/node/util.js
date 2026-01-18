/**
 * Node.js util module compatibility for QuickJS-x.
 * @see https://nodejs.org/api/util.html
 */

/**
 * Converts a callback-style function to a Promise-returning function.
 * Supports util.promisify.custom symbol for custom implementations.
 * @param {Function} original - Function with (err, value) callback as last param
 * @returns {Function} Promise-returning version
 */
export const promisify = Object.assign(
	function promisify(original) {
		if (typeof original !== 'function') {
			throw new TypeError('The "original" argument must be of type Function')
		}

		// Check for custom promisified version
		if (original[promisify.custom]) {
			const fn = original[promisify.custom]
			if (typeof fn !== 'function') {
				throw new TypeError('The "util.promisify.custom" property must be of type Function')
			}
			return Object.defineProperty(fn, promisify.custom, {
				value: fn,
				enumerable: false,
				writable: false,
				configurable: true
			})
		}

		function fn(...args) {
			return new Promise((resolve, reject) => {
				original.call(this, ...args, (err, value) => {
					if (err) {
						reject(err)
					} else {
						resolve(value)
					}
				})
			})
		}

		Object.setPrototypeOf(fn, Object.getPrototypeOf(original))
		Object.defineProperty(fn, promisify.custom, {
			value: fn,
			enumerable: false,
			writable: false,
			configurable: true
		})

		return Object.defineProperties(fn, Object.getOwnPropertyDescriptors(original))
	},
	{
		custom: Symbol.for('nodejs.util.promisify.custom')
	}
)

export default { promisify }

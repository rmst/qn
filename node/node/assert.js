/**
 * Node.js assert module compatibility for Qn.
 * Implements the subset used by qn and jix tests.
 * @see https://nodejs.org/api/assert.html
 */

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

/**
 * Custom error class for assertion failures.
 */
export class AssertionError extends Error {
	constructor(options) {
		const { message, actual, expected, operator } = options
		super(message)
		this.name = 'AssertionError'
		this.code = 'ERR_ASSERTION'
		this.actual = actual
		this.expected = expected
		this.operator = operator
		this.generatedMessage = !options.message
	}
}

/**
 * Check if two values are strictly equal (===).
 */
function isStrictEqual(a, b) {
	return a === b || (Number.isNaN(a) && Number.isNaN(b))
}

/**
 * Get the type tag for a value.
 */
function getTag(value) {
	if (value === null) return 'null'
	if (value === undefined) return 'undefined'
	if (Array.isArray(value)) return 'Array'
	if (value instanceof Date) return 'Date'
	if (value instanceof RegExp) return 'RegExp'
	if (value instanceof Error) return 'Error'
	if (value instanceof Map) return 'Map'
	if (value instanceof Set) return 'Set'
	if (ArrayBuffer.isView(value)) return 'TypedArray'
	if (value instanceof ArrayBuffer) return 'ArrayBuffer'
	return typeof value === 'object' ? 'Object' : typeof value
}

/**
 * Deep strict equality check.
 * Returns true if values are deeply equal, false otherwise.
 */
function isDeepStrictEqual(a, b, seen = new Map()) {
	// Strict equality handles primitives and same references
	if (isStrictEqual(a, b)) return true

	// Type check
	const tagA = getTag(a)
	const tagB = getTag(b)
	if (tagA !== tagB) return false

	// Handle null/undefined (already handled by isStrictEqual, but be safe)
	if (a === null || b === null || a === undefined || b === undefined) {
		return false
	}

	// Handle circular references
	if (seen.has(a)) {
		return seen.get(a) === b
	}
	seen.set(a, b)

	// Date comparison
	if (tagA === 'Date') {
		return a.getTime() === b.getTime()
	}

	// RegExp comparison
	if (tagA === 'RegExp') {
		return a.source === b.source && a.flags === b.flags
	}

	// Error comparison
	if (tagA === 'Error') {
		return a.name === b.name && a.message === b.message
	}

	// TypedArray / ArrayBuffer comparison
	if (tagA === 'TypedArray' || tagA === 'ArrayBuffer') {
		const viewA = tagA === 'ArrayBuffer' ? new Uint8Array(a) : a
		const viewB = tagA === 'ArrayBuffer' ? new Uint8Array(b) : b
		if (viewA.length !== viewB.length) return false
		for (let i = 0; i < viewA.length; i++) {
			if (viewA[i] !== viewB[i]) return false
		}
		return true
	}

	// Map comparison
	if (tagA === 'Map') {
		if (a.size !== b.size) return false
		for (const [key, val] of a) {
			if (!b.has(key) || !isDeepStrictEqual(val, b.get(key), seen)) {
				return false
			}
		}
		return true
	}

	// Set comparison
	if (tagA === 'Set') {
		if (a.size !== b.size) return false
		for (const val of a) {
			if (!b.has(val)) return false
		}
		return true
	}

	// Array comparison
	if (tagA === 'Array') {
		if (a.length !== b.length) return false
		for (let i = 0; i < a.length; i++) {
			if (!isDeepStrictEqual(a[i], b[i], seen)) return false
		}
		return true
	}

	// Object comparison
	if (tagA === 'Object') {
		const keysA = Object.keys(a)
		const keysB = Object.keys(b)
		if (keysA.length !== keysB.length) return false

		for (const key of keysA) {
			if (!Object.prototype.hasOwnProperty.call(b, key)) return false
			if (!isDeepStrictEqual(a[key], b[key], seen)) return false
		}
		return true
	}

	return false
}

/**
 * Format a value for display in error messages.
 */
function formatValue(value, indent = 0) {
	const pad = '  '.repeat(indent)
	const tag = getTag(value)

	if (value === undefined) return 'undefined'
	if (value === null) return 'null'
	if (typeof value === 'string') return JSON.stringify(value)
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	if (typeof value === 'bigint') return `${value}n`
	if (typeof value === 'symbol') return value.toString()
	if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`

	if (tag === 'Date') return `Date(${value.toISOString()})`
	if (tag === 'RegExp') return value.toString()
	if (tag === 'Error') return `${value.name}: ${value.message}`

	if (tag === 'Array') {
		if (value.length === 0) return '[]'
		const items = value.map(v => formatValue(v, indent + 1))
		if (items.join(', ').length < 60 && !items.some(i => i.includes('\n'))) {
			return `[ ${items.join(', ')} ]`
		}
		return `[\n${pad}  ${items.join(`,\n${pad}  `)}\n${pad}]`
	}

	if (tag === 'Object') {
		const keys = Object.keys(value)
		if (keys.length === 0) return '{}'
		const items = keys.map(k => `${k}: ${formatValue(value[k], indent + 1)}`)
		if (items.join(', ').length < 60 && !items.some(i => i.includes('\n'))) {
			return `{ ${items.join(', ')} }`
		}
		return `{\n${pad}  ${items.join(`,\n${pad}  `)}\n${pad}}`
	}

	if (tag === 'Map') return `Map(${value.size})`
	if (tag === 'Set') return `Set(${value.size})`
	if (tag === 'TypedArray') return `${value.constructor.name}(${value.length})`

	return String(value)
}

/**
 * Generate a diff between two values showing where they differ.
 * Returns an array of diff lines with +/- prefixes.
 */
function generateDiff(actual, expected, path = '') {
	const lines = []
	const tagA = getTag(actual)
	const tagE = getTag(expected)

	if (tagA !== tagE) {
		lines.push(`${RED}- ${path || 'value'}: ${formatValue(expected)}${RESET}`)
		lines.push(`${GREEN}+ ${path || 'value'}: ${formatValue(actual)}${RESET}`)
		return lines
	}

	if (tagA === 'Array') {
		const maxLen = Math.max(actual.length, expected.length)
		for (let i = 0; i < maxLen; i++) {
			const itemPath = path ? `${path}[${i}]` : `[${i}]`
			if (i >= actual.length) {
				lines.push(`${RED}- ${itemPath}: ${formatValue(expected[i])}${RESET}`)
			} else if (i >= expected.length) {
				lines.push(`${GREEN}+ ${itemPath}: ${formatValue(actual[i])}${RESET}`)
			} else if (!isDeepStrictEqual(actual[i], expected[i])) {
				lines.push(...generateDiff(actual[i], expected[i], itemPath))
			}
		}
		return lines
	}

	if (tagA === 'Object') {
		const allKeys = new Set([...Object.keys(actual), ...Object.keys(expected)])
		for (const key of allKeys) {
			const keyPath = path ? `${path}.${key}` : key
			const inActual = Object.prototype.hasOwnProperty.call(actual, key)
			const inExpected = Object.prototype.hasOwnProperty.call(expected, key)

			if (!inActual) {
				lines.push(`${RED}- ${keyPath}: ${formatValue(expected[key])}${RESET}`)
			} else if (!inExpected) {
				lines.push(`${GREEN}+ ${keyPath}: ${formatValue(actual[key])}${RESET}`)
			} else if (!isDeepStrictEqual(actual[key], expected[key])) {
				lines.push(...generateDiff(actual[key], expected[key], keyPath))
			}
		}
		return lines
	}

	// Primitives that differ
	lines.push(`${RED}- ${path || 'value'}: ${formatValue(expected)}${RESET}`)
	lines.push(`${GREEN}+ ${path || 'value'}: ${formatValue(actual)}${RESET}`)
	return lines
}

/**
 * Assert that a value is truthy.
 */
function assert(value, message) {
	if (!value) {
		throw new AssertionError({
			message: message || `Expected truthy value, got ${formatValue(value)}`,
			actual: value,
			expected: true,
			operator: '=='
		})
	}
}

/**
 * Assert that a value is truthy (alias for assert).
 */
assert.ok = function ok(value, message) {
	assert(value, message)
}

/**
 * Assert that two values are strictly equal (===).
 */
assert.strictEqual = function strictEqual(actual, expected, message) {
	if (!isStrictEqual(actual, expected)) {
		const defaultMsg = `Expected values to be strictly equal:\n\n${GREEN}+ actual${RESET} ${RED}- expected${RESET}\n\n${GREEN}+ ${formatValue(actual)}${RESET}\n${RED}- ${formatValue(expected)}${RESET}`
		throw new AssertionError({
			message: message || defaultMsg,
			actual,
			expected,
			operator: 'strictEqual'
		})
	}
}

/**
 * Assert that two values are deeply strictly equal.
 */
assert.deepStrictEqual = function deepStrictEqualAssert(actual, expected, message) {
	if (!isDeepStrictEqual(actual, expected)) {
		const diff = generateDiff(actual, expected)
		const diffStr = diff.length > 0 ? `\n\n${diff.join('\n')}` : ''
		const defaultMsg = `Expected values to be deeply strictly equal:${diffStr}`
		throw new AssertionError({
			message: message || defaultMsg,
			actual,
			expected,
			operator: 'deepStrictEqual'
		})
	}
}

/**
 * Throw an AssertionError.
 */
assert.fail = function fail(message) {
	throw new AssertionError({
		message: message || 'Failed',
		operator: 'fail'
	})
}

/**
 * Assert that a string matches a regular expression.
 */
assert.match = function match(string, regexp, message) {
	if (typeof string !== 'string') {
		throw new TypeError('The "string" argument must be of type string')
	}
	if (!(regexp instanceof RegExp)) {
		throw new TypeError('The "regexp" argument must be an instance of RegExp')
	}
	if (!regexp.test(string)) {
		throw new AssertionError({
			message: message || `The input did not match the regular expression ${regexp}. Input: ${formatValue(string)}`,
			actual: string,
			expected: regexp,
			operator: 'match'
		})
	}
}

/**
 * Assert that a string does not match a regular expression.
 */
assert.doesNotMatch = function doesNotMatch(string, regexp, message) {
	if (typeof string !== 'string') {
		throw new TypeError('The "string" argument must be of type string')
	}
	if (!(regexp instanceof RegExp)) {
		throw new TypeError('The "regexp" argument must be an instance of RegExp')
	}
	if (regexp.test(string)) {
		throw new AssertionError({
			message: message || `The input was expected to not match the regular expression ${regexp}. Input: ${formatValue(string)}`,
			actual: string,
			expected: regexp,
			operator: 'doesNotMatch'
		})
	}
}

// Also export AssertionError
assert.AssertionError = AssertionError

export default assert
export { assert }

const { ok, strictEqual, deepStrictEqual, fail, match, doesNotMatch } = assert
export { ok, strictEqual, deepStrictEqual, fail, match, doesNotMatch }

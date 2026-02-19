/**
 * Parse stdio option into array of 3 values.
 * @param {string|string[]|undefined} stdio
 * @returns {(string|number)[]} Array of ['pipe'|'inherit'|'ignore'|number, ...]
 */
export function parseStdio(stdio) {
	if (stdio === undefined || stdio === 'pipe') {
		return ['pipe', 'pipe', 'pipe']
	}
	if (stdio === 'inherit') {
		return ['inherit', 'inherit', 'inherit']
	}
	if (stdio === 'ignore') {
		return ['ignore', 'ignore', 'ignore']
	}
	if (Array.isArray(stdio)) {
		return [
			stdio[0] ?? 'pipe',
			stdio[1] ?? 'pipe',
			stdio[2] ?? 'pipe',
		]
	}
	throw new TypeError(`Invalid stdio option: ${stdio}`)
}

import { signals as _signals } from 'qn_uv_signals'

// Build reverse map (number → name)
const _signalNames = Object.fromEntries(
	Object.entries(_signals).map(([k, v]) => [v, k])
)

/**
 * Signal name to number mapping.
 * @param {string|number} signal
 * @returns {number}
 */
export function getSignalNumber(signal) {
	if (typeof signal === 'number') return signal
	return _signals[signal] || 15
}

/**
 * Signal number to name mapping.
 * @param {number} num
 * @returns {string}
 */
export function signalName(num) {
	return _signalNames[num] || `SIG${num}`
}

/**
 * Error for unsupported Node.js compatibility features.
 */
export class NodeCompatibilityError extends Error {
	constructor(message) {
		super(message)
		this.name = 'NodeCompatibilityError'
	}
}

/**
 * Check for unsupported options and throw NodeCompatibilityError.
 * @param {Object} options - The options object to check
 * @param {string[]} unsupportedKeys - Keys that are not supported
 * @param {string} fnName - Function name for error message
 */
export function checkUnsupportedOptions(options, unsupportedKeys, fnName) {
	if (!options) return
	for (const key of unsupportedKeys) {
		if (options[key] !== undefined) {
			throw new NodeCompatibilityError(
				`${fnName}: option '${key}' is not supported`
			)
		}
	}
}

/**
 * Check encoding option - we only support utf8/string output.
 * @param {Object} options
 * @param {string} fnName
 */
export function checkEncodingOption(options, fnName) {
	if (!options || options.encoding === undefined) return
	const enc = options.encoding
	if (enc !== 'utf8' && enc !== 'utf-8') {
		throw new NodeCompatibilityError(
			`${fnName}: encoding '${enc}' is not supported, only 'utf8' is supported`
		)
	}
}

/**
 * Prefix each line of a string.
 * @param {string} prefix
 * @param {string} str
 * @returns {string}
 */
export function prefixLines(prefix, str) {
	return str.split("\n")
		.map(line => prefix + line)
		.join("\n")
}

/**
 * Indent a string by two spaces.
 * @param {string} str
 * @returns {string}
 */
export const indent = str => prefixLines("  ", str)

import * as std from 'std'

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
 * Reads the entire contents from a file descriptor using std.fdopen.
 * @param {number} fd - The file descriptor to read from.
 * @returns {string} - The string contents of the file descriptor.
 */
export function readFromFd(fd) {
	const file = std.fdopen(fd, 'r')

	if (file === null) {
		throw new Error(`Failed to open file descriptor: ${fd}`)
	}

	const output = file.readAsString()
	file.close()

	return output
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

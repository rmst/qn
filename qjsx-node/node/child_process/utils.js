import * as std from 'std'

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

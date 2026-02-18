import * as std from 'std'
import * as os from 'os'
import { Buffer } from 'node:buffer'

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
 * Create pipes and file descriptors based on stdio configuration.
 * Returns the fds for parent side and the options to pass to os.exec.
 * @param {(string|number)[]} stdio - Parsed stdio array
 * @returns {{ parentFds: { stdin: number|null, stdout: number|null, stderr: number|null }, execOptions: object, cleanup: () => void }}
 */
export function setupStdioPipes(stdio) {
	let stdinRead = null, stdinWrite = null
	let stdoutRead = null, stdoutWrite = null
	let stderrRead = null, stderrWrite = null
	const fdsToCloseOnCleanup = []

	if (stdio[0] === 'pipe') {
		[stdinRead, stdinWrite] = os.pipe()
	}
	if (stdio[1] === 'pipe') {
		[stdoutRead, stdoutWrite] = os.pipe()
	}
	if (stdio[2] === 'pipe') {
		[stderrRead, stderrWrite] = os.pipe()
	}

	const execOptions = {}

	if (stdio[0] === 'pipe') {
		execOptions.stdin = stdinRead
	} else if (stdio[0] === 'ignore') {
		execOptions.stdin = os.open('/dev/null', os.O_RDONLY)
		fdsToCloseOnCleanup.push(execOptions.stdin)
	} else if (typeof stdio[0] === 'number') {
		execOptions.stdin = stdio[0]
	}

	if (stdio[1] === 'pipe') {
		execOptions.stdout = stdoutWrite
	} else if (stdio[1] === 'ignore') {
		execOptions.stdout = os.open('/dev/null', os.O_WRONLY)
		fdsToCloseOnCleanup.push(execOptions.stdout)
	} else if (typeof stdio[1] === 'number') {
		execOptions.stdout = stdio[1]
	}

	if (stdio[2] === 'pipe') {
		execOptions.stderr = stderrWrite
	} else if (stdio[2] === 'ignore') {
		execOptions.stderr = os.open('/dev/null', os.O_WRONLY)
		fdsToCloseOnCleanup.push(execOptions.stderr)
	} else if (typeof stdio[2] === 'number') {
		execOptions.stderr = stdio[2]
	}

	// Function to close child-side fds in parent after fork
	const closeChildSide = () => {
		if (stdio[0] === 'pipe') os.close(stdinRead)
		if (stdio[1] === 'pipe') os.close(stdoutWrite)
		if (stdio[2] === 'pipe') os.close(stderrWrite)
		for (const fd of fdsToCloseOnCleanup) {
			os.close(fd)
		}
	}

	return {
		parentFds: {
			stdin: stdio[0] === 'pipe' ? stdinWrite : null,
			stdout: stdio[1] === 'pipe' ? stdoutRead : null,
			stderr: stdio[2] === 'pipe' ? stderrRead : null,
		},
		execOptions,
		closeChildSide,
	}
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
 * Reads the entire contents from a file descriptor as a UTF-8 string.
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
 * Reads the entire contents from a file descriptor as raw bytes.
 * @param {number} fd - The file descriptor to read from.
 * @returns {Buffer} - The raw bytes from the file descriptor.
 */
export function readBytesFromFd(fd) {
	const chunks = []
	const buf = new Uint8Array(4096)
	let totalLen = 0

	while (true) {
		const n = os.read(fd, buf.buffer, 0, buf.length)
		if (n <= 0) break
		chunks.push(buf.slice(0, n))
		totalLen += n
	}

	os.close(fd)

	// Concatenate all chunks
	if (chunks.length === 0) {
		return Buffer.alloc(0)
	}
	if (chunks.length === 1) {
		return Buffer.from(chunks[0])
	}

	const result = Buffer.alloc(totalLen)
	let offset = 0
	for (const chunk of chunks) {
		result.set(chunk, offset)
		offset += chunk.length
	}
	return result
}

/**
 * Write input data to a file descriptor.
 * Supports string, Buffer, TypedArray, or ArrayBuffer.
 * @param {number} fd - The file descriptor to write to.
 * @param {string|Buffer|Uint8Array|ArrayBuffer} input - The data to write.
 */
export function writeInputToFd(fd, input) {
	const file = std.fdopen(fd, 'w')
	if (file === null) {
		throw new Error(`Failed to open file descriptor for writing: ${fd}`)
	}

	if (typeof input === 'string') {
		file.puts(input)
	} else if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
		file.write(input.buffer, input.byteOffset, input.byteLength)
	} else if (input instanceof ArrayBuffer) {
		file.write(input, 0, input.byteLength)
	} else if (ArrayBuffer.isView(input)) {
		file.write(input.buffer, input.byteOffset, input.byteLength)
	} else {
		file.close()
		throw new TypeError('input must be a string, Buffer, TypedArray, or ArrayBuffer')
	}

	file.close()
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

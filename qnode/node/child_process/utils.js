import * as std from 'std'
import * as os from 'os'
import { Buffer } from 'node:buffer'

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

/**
 * Spawn a process with pipes for stdin, stdout, and stderr.
 * This is the shared low-level helper used by both execFile and execFileSync.
 *
 * @param {string} file - The command or executable file to run.
 * @param {string[]} args - The list of arguments to pass to the command.
 * @param {Object} options - Options for the process.
 * @param {Object} [options.env] - Environment variables for the command.
 * @param {string} [options.cwd] - Working directory for the command.
 * @returns {{ pid: number, stdinFd: number, stdoutFd: number, stderrFd: number }}
 */
export function spawnWithPipes(file, args, options = {}) {
	const env = options.env || std.getenviron()
	const cwd = options.cwd || undefined

	// Create pipes for stdin, stdout, and stderr
	const [stdinRead, stdinWrite] = os.pipe()
	const [stdoutRead, stdoutWrite] = os.pipe()
	const [stderrRead, stderrWrite] = os.pipe()

	// Spawn the process (non-blocking)
	const pid = os.exec([file, ...args], {
		block: false,
		env,
		cwd,
		stdin: stdinRead,
		stdout: stdoutWrite,
		stderr: stderrWrite,
	})

	// Close child-side of pipes in parent
	os.close(stdinRead)
	os.close(stdoutWrite)
	os.close(stderrWrite)

	return { pid, stdinFd: stdinWrite, stdoutFd: stdoutRead, stderrFd: stderrRead }
}

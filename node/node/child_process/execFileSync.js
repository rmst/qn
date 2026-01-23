import * as std from 'std'
import { Buffer } from 'node:buffer'
import { spawnSync } from './spawnSync.js'
import { checkUnsupportedOptions, NodeCompatibilityError, indent } from './utils.js'

const UNSUPPORTED_OPTIONS = ['uid', 'gid']

/**
 * Execute a command synchronously and return its output.
 *
 * @param {string} file - The command or executable file to run.
 * @param {Array} [args=[]] - The list of arguments to pass to the command.
 * @param {Object} [options={}] - Optional parameters.
 * @param {Object} [options.env] - Environment variables for the command.
 * @param {string} [options.cwd] - Working directory for the command.
 * @param {string} [options.input] - A string or Uint8Array to be passed as input to the command.
 * @param {number} [options.timeout=0] - Timeout in milliseconds (0 means no timeout).
 * @param {string} [options.killSignal='SIGTERM'] - Signal to send when timeout expires.
 * @param {string} [options.encoding] - If 'utf8', returns string; otherwise returns Uint8Array.
 * @param {string|string[]} [options.stdio='pipe'] - stdio configuration ('pipe', 'inherit', 'ignore', or array).
 *
 * @returns {Uint8Array|string} - The stdout output (Uint8Array by default, string if encoding='utf8').
 *
 * @throws {Error} - Throws an error if the command exits with a non-zero status or times out.
 */
export function execFileSync(file, args = [], options = {}) {
	if (typeof file !== 'string') {
		throw new TypeError('file must be a string')
	}
	if (!Array.isArray(args)) {
		throw new TypeError('args must be an array')
	}
	if (options != null && typeof options !== 'object') {
		throw new TypeError('options must be an object')
	}

	checkUnsupportedOptions(options, UNSUPPORTED_OPTIONS, 'execFileSync')

	// Check encoding option
	const encoding = options.encoding
	if (encoding && encoding.toLowerCase().replace('-', '') !== 'utf8') {
		throw new NodeCompatibilityError(
			`execFileSync: encoding '${encoding}' is not supported, only 'utf8' is supported`
		)
	}
	const useUtf8 = encoding && encoding.toLowerCase().replace('-', '') === 'utf8'

	// Call spawnSync
	const result = spawnSync(file, args, {
		cwd: options.cwd,
		env: options.env,
		input: options.input,
		stdio: options.stdio,
		timeout: options.timeout,
		killSignal: options.killSignal,
		encoding: options.encoding,
	})

	// Helper to get string version of output for error messages
	const outputStr = useUtf8 ? result.stdout : bytesToString(result.stdout)
	const errorOutputStr = useUtf8 ? result.stderr : bytesToString(result.stderr)

	// Handle timeout
	if (result.error) {
		const error = new Error(`Command timed out: ${file}`)
		error.signal = result.signal
		error.stdout = result.stdout
		error.stderr = result.stderr
		throw error
	}

	// Handle error case if exit code is non-zero
	if (result.status !== 0) {
		const argsSection = args
			.map(a => `'${a}'`)
			.join(', ')
			.replaceAll("\n", "\n  ")

		let errorMsg = `Command: ['${file}', ${argsSection}]\n`
		if (argsSection.includes("\n")) {
			errorMsg += "\n"
		}

		errorMsg += `Exit Code: ${result.status}\n`

		if (options.cwd) {
			errorMsg += `Cwd: ${options.cwd}\n`
		}

		errorMsg += `Stderr:\n${indent(errorOutputStr)}\n`
		if (errorOutputStr.includes("\n")) {
			errorMsg += "\n"
		}

		const error = new Error(errorMsg)
		error.status = result.status
		error.stdout = result.stdout
		error.stderr = result.stderr
		throw error
	}

	// Return trimmed output
	if (useUtf8) {
		return result.stdout.trim()
	} else {
		return trimBytes(result.stdout)
	}
}

/**
 * Convert Uint8Array to string (for error messages).
 * @param {Uint8Array|Buffer} bytes
 * @returns {string}
 */
function bytesToString(bytes) {
	if (typeof bytes === 'string') return bytes
	return std._decodeUtf8(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

/**
 * Trim trailing whitespace from Uint8Array.
 * @param {Uint8Array|Buffer} bytes
 * @returns {Buffer}
 */
function trimBytes(bytes) {
	if (typeof bytes === 'string') return bytes
	let end = bytes.length
	// Trim trailing whitespace (space, tab, newline, carriage return)
	while (end > 0) {
		const b = bytes[end - 1]
		if (b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D) {
			end--
		} else {
			break
		}
	}
	// Trim leading whitespace
	let start = 0
	while (start < end) {
		const b = bytes[start]
		if (b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D) {
			start++
		} else {
			break
		}
	}
	return Buffer.from(bytes.subarray(start, end))
}

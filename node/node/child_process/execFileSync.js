import * as std from 'std'
import * as os from 'os'
import { Buffer } from 'node:buffer'
import { readFromFd, readBytesFromFd, indent, checkUnsupportedOptions, NodeCompatibilityError, writeInputToFd } from './utils.js'

const UNSUPPORTED_OPTIONS = [
	'uid',
	'gid',
	'shell',
]

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
 *
 * @example
 * // Returns Uint8Array by default
 * const bytes = execFileSync('echo', ['Hello, World!'])
 * console.log(bytes)  // Uint8Array
 *
 * @example
 * // Returns string with encoding option
 * const output = execFileSync('echo', ['Hello, World!'], { encoding: 'utf8' })
 * console.log(output)  // "Hello, World!"
 *
 * @example
 * // With timeout
 * try {
 *   execFileSync('sleep', ['10'], { timeout: 1000 })
 * } catch (e) {
 *   console.log('Timed out!')
 * }
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

	const env = options.env || std.getenviron()
	const cwd = options.cwd || undefined

	// Parse stdio option
	const stdio = parseStdio(options.stdio)

	// Create pipes for stdin, stdout, stderr based on stdio config
	let stdinRead = null, stdinWrite = null
	let stdoutRead = null, stdoutWrite = null
	let stderrRead = null, stderrWrite = null

	if (stdio[0] === 'pipe') {
		[stdinRead, stdinWrite] = os.pipe()
	}
	if (stdio[1] === 'pipe') {
		[stdoutRead, stdoutWrite] = os.pipe()
	}
	if (stdio[2] === 'pipe') {
		[stderrRead, stderrWrite] = os.pipe()
	}

	// Build exec options
	const execOptions = {
		block: false,
		env,
		cwd,
	}

	if (stdio[0] === 'pipe') {
		execOptions.stdin = stdinRead
	} else if (stdio[0] === 'ignore') {
		execOptions.stdin = os.open('/dev/null', os.O_RDONLY)
	} else if (typeof stdio[0] === 'number') {
		execOptions.stdin = stdio[0]
	}
	// 'inherit' means don't set - use parent's

	if (stdio[1] === 'pipe') {
		execOptions.stdout = stdoutWrite
	} else if (stdio[1] === 'ignore') {
		execOptions.stdout = os.open('/dev/null', os.O_WRONLY)
	} else if (typeof stdio[1] === 'number') {
		execOptions.stdout = stdio[1]
	}

	if (stdio[2] === 'pipe') {
		execOptions.stderr = stderrWrite
	} else if (stdio[2] === 'ignore') {
		execOptions.stderr = os.open('/dev/null', os.O_WRONLY)
	} else if (typeof stdio[2] === 'number') {
		execOptions.stderr = stdio[2]
	}

	// Spawn the process
	const pid = os.exec([file, ...args], execOptions)

	// Close child-side of pipes in parent
	if (stdio[0] === 'pipe') os.close(stdinRead)
	if (stdio[1] === 'pipe') os.close(stdoutWrite)
	if (stdio[2] === 'pipe') os.close(stderrWrite)

	// Close /dev/null fds we opened for 'ignore'
	if (stdio[0] === 'ignore' && execOptions.stdin !== undefined) {
		os.close(execOptions.stdin)
	}
	if (stdio[1] === 'ignore' && execOptions.stdout !== undefined) {
		os.close(execOptions.stdout)
	}
	if (stdio[2] === 'ignore' && execOptions.stderr !== undefined) {
		os.close(execOptions.stderr)
	}

	// Write input to the process if provided, then close stdin
	if (stdio[0] === 'pipe') {
		if (options.input !== undefined) {
			writeInputToFd(stdinWrite, options.input)
		} else {
			os.close(stdinWrite)
		}
	}

	// Poll for process exit with timeout support
	const timeout = options.timeout || 0
	const killSignal = options.killSignal || 'SIGTERM'
	const startTime = Date.now()
	let timedOut = false
	let exitCode = null
	let signalCode = null

	while (true) {
		const [ret, status] = os.waitpid(pid, os.WNOHANG)

		if (ret === pid) {
			// Process has exited - decode status
			if ((status & 0x7F) === 0) {
				// Normal exit
				exitCode = (status >> 8) & 0xFF
			} else {
				// Killed by signal
				signalCode = status & 0x7F
			}
			break
		}

		// Check timeout
		if (timeout > 0 && Date.now() - startTime > timeout) {
			timedOut = true
			os.kill(pid, typeof killSignal === 'string' ? getSignalNumber(killSignal) : killSignal)
			// Wait for the process to actually terminate
			os.waitpid(pid, 0)
			break
		}

		// Small sleep to avoid busy-waiting (1ms)
		os.sleep(1)
	}

	// Read stdout and stderr from pipes (if piped)
	let output, errorOutput
	if (stdio[1] === 'pipe') {
		output = useUtf8 ? readFromFd(stdoutRead) : readBytesFromFd(stdoutRead)
	} else {
		output = useUtf8 ? '' : Buffer.alloc(0)
	}

	if (stdio[2] === 'pipe') {
		errorOutput = useUtf8 ? readFromFd(stderrRead) : readBytesFromFd(stderrRead)
	} else {
		errorOutput = useUtf8 ? '' : Buffer.alloc(0)
	}

	// Helper to get string version of output for error messages
	const outputStr = useUtf8 ? output : bytesToString(output)
	const errorOutputStr = useUtf8 ? errorOutput : bytesToString(errorOutput)

	// Handle timeout
	if (timedOut) {
		const error = new Error(`Command timed out: ${file}`)
		error.killed = true
		error.signal = killSignal
		error.stdout = output
		error.stderr = errorOutput
		throw error
	}

	// Handle error case if exit code is non-zero
	if (exitCode !== 0) {
		const argsSection = args
			.map(a => `'${a}'`)
			.join(', ')
			.replaceAll("\n", "\n  ")

		let errorMsg = `Command: ['${file}', ${argsSection}]\n`
		if (argsSection.includes("\n")) {
			errorMsg += "\n"
		}

		errorMsg += `Exit Code: ${exitCode}\n`

		if (options.env) {
			const envVars = Object.entries(options.env)
				.map(([key, value]) => `${key}=${value}`)
				.join('\n')

			errorMsg += `Env:\n${indent(envVars)}\n\n`
		}

		if (options.cwd) {
			errorMsg += `Cwd: ${options.cwd}\n`
		}

		errorMsg += `Stderr:\n${indent(errorOutputStr)}\n`
		if (errorOutputStr.includes("\n")) {
			errorMsg += "\n"
		}

		const error = new Error(errorMsg)
		error.status = exitCode
		error.stdout = output
		error.stderr = errorOutput
		throw error
	}

	// Return trimmed output
	if (useUtf8) {
		return output.trim()
	} else {
		return trimBytes(output)
	}
}

/**
 * Convert Uint8Array to string (for error messages).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToString(bytes) {
	return std._decodeUtf8(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

/**
 * Trim trailing whitespace from Uint8Array.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function trimBytes(bytes) {
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
	return bytes.subarray(start, end)
}

// Signal name to number mapping
function getSignalNumber(signal) {
	const signals = {
		SIGHUP: 1,
		SIGINT: 2,
		SIGQUIT: 3,
		SIGKILL: 9,
		SIGTERM: 15,
	}
	return signals[signal] || 15
}

/**
 * Parse stdio option into array of 3 values.
 * @param {string|string[]|undefined} stdio
 * @returns {string[]} Array of ['pipe'|'inherit'|'ignore', ...]
 */
function parseStdio(stdio) {
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
			stdio[0] || 'pipe',
			stdio[1] || 'pipe',
			stdio[2] || 'pipe',
		]
	}
	throw new TypeError(`Invalid stdio option: ${stdio}`)
}

import * as os from 'os'
import { Buffer } from 'node:buffer'
import { spawn } from './spawn.js'
import { NodeCompatibilityError } from './utils.js'
import { promisify } from 'node:util'
import { setTimeout as _setTimeout, clearTimeout as _clearTimeout } from 'qn_vm'

/**
 * Execute a file asynchronously.
 * @param {string} file - The command or executable file to run.
 * @param {string[]} [args=[]] - The list of arguments to pass to the command.
 * @param {Object} [options={}] - Optional parameters.
 * @param {Object} [options.env] - Environment variables for the command.
 * @param {string} [options.cwd] - Working directory for the command.
 * @param {string} [options.input] - A string to be passed as input to the command (closes stdin after).
 * @param {number} [options.timeout=0] - Timeout in milliseconds (0 means no timeout).
 * @param {string} [options.killSignal='SIGTERM'] - Signal to send when timeout expires.
 * @param {string} [options.encoding] - If 'utf8', callback receives strings; otherwise Uint8Array.
 * @param {AbortSignal} [options.signal] - AbortSignal to abort the child process.
 * @param {Function} [callback] - Called with (error, stdout, stderr) when process completes.
 * @returns {ChildProcess}
 *
 * @example
 * // With callback
 * execFile('ls', ['-la'], (error, stdout, stderr) => {
 *   if (error) console.error(error)
 *   else console.log(stdout)
 * })
 *
 * @example
 * // With streaming
 * const child = execFile('cat')
 * child.stdout.on('data', (chunk) => console.log('received:', chunk))
 * child.stdin.write('hello\n')
 * child.stdin.end()
 *
 * @example
 * // With timeout
 * execFile('sleep', ['10'], { timeout: 1000 }, (error, stdout, stderr) => {
 *   if (error) console.error('Timed out or failed:', error.message)
 * })
 */
export function execFile(file, args, options, callback) {
	// Handle overloaded arguments
	if (typeof args === 'function') {
		callback = args
		args = []
		options = {}
	} else if (typeof args === 'object' && !Array.isArray(args)) {
		callback = options
		options = args
		args = []
	} else if (typeof options === 'function') {
		callback = options
		options = {}
	}

	args = args || []
	options = options || {}

	if (typeof file !== 'string') {
		throw new TypeError('file must be a string')
	}
	if (!Array.isArray(args)) {
		throw new TypeError('args must be an array')
	}

	// Spawn the process using spawn (which now uses shared utilities)
	const child = spawn(file, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: 'pipe',  // execFile always uses pipes
		signal: options.signal,
		detached: options.detached,
	})

	// Set up timeout if specified
	let timeoutId = null
	let timedOut = false
	const timeout = options.timeout || 0
	const killSignal = options.killSignal || 'SIGTERM'

	if (timeout > 0) {
		timeoutId = _setTimeout(() => {
			timedOut = true
			child.kill(killSignal)
			// Destroy streams to prevent blocking if descendants hold pipes open
			if (child.stdout) child.stdout.destroy()
			if (child.stderr) child.stderr.destroy()
		}, timeout)

		child.on('close', () => {
			if (timeoutId !== null) {
				_clearTimeout(timeoutId)
				timeoutId = null
			}
		})
	}

	// Write input if provided and close stdin
	if (options.input !== undefined) {
		child.stdin.end(options.input)
	}

	// If callback provided, collect stream data and call on close
	if (typeof callback === 'function') {
		// Check encoding option
		const encoding = options.encoding
		if (encoding && encoding.toLowerCase().replace('-', '') !== 'utf8') {
			throw new NodeCompatibilityError(
				`execFile: encoding '${encoding}' is not supported, only 'utf8' is supported`
			)
		}
		const useUtf8 = encoding && encoding.toLowerCase().replace('-', '') === 'utf8'

		// Set encoding on streams if specified
		if (useUtf8) {
			child.stdout.setEncoding('utf8')
			child.stderr.setEncoding('utf8')
		}

		// Collect output - strings if encoding set, otherwise Uint8Array chunks
		let stdoutChunks = useUtf8 ? '' : []
		let stderrChunks = useUtf8 ? '' : []

		child.stdout.on('data', (chunk) => {
			if (useUtf8) {
				stdoutChunks += chunk
			} else {
				stdoutChunks.push(chunk)
			}
		})

		child.stderr.on('data', (chunk) => {
			if (useUtf8) {
				stderrChunks += chunk
			} else {
				stderrChunks.push(chunk)
			}
		})

		child.on('close', (code) => {
			// Combine chunks into final output
			let stdoutData, stderrData
			if (useUtf8) {
				stdoutData = stdoutChunks
				stderrData = stderrChunks
			} else {
				stdoutData = concatToBuffer(stdoutChunks)
				stderrData = concatToBuffer(stderrChunks)
			}

			let error = null
			if (timedOut) {
				error = Object.assign(new Error(`Command timed out: ${file}`), {
					code,
					killed: true,
					signal: killSignal,
				})
			} else if (code !== 0) {
				error = Object.assign(new Error(`Command failed: ${file}`), { code })
			}
			callback(error, stdoutData, stderrData)
		})
	}

	return child
}

execFile[promisify.custom] = (file, args, options) => {
	return new Promise((resolve, reject) => {
		execFile(file, args, options, (err, stdout, stderr) => {
			if (err) {
				err.stdout = stdout
				err.stderr = stderr
				reject(err)
			} else {
				resolve({ stdout, stderr })
			}
		})
	})
}

/**
 * Concatenate array of Uint8Arrays into a single Buffer.
 * @param {Uint8Array[]} arrays
 * @returns {Buffer}
 */
function concatToBuffer(arrays) {
	if (arrays.length === 0) {
		return Buffer.alloc(0)
	}
	if (arrays.length === 1) {
		return Buffer.from(arrays[0])
	}

	const totalLen = arrays.reduce((sum, arr) => sum + arr.length, 0)
	const result = Buffer.alloc(totalLen)
	let offset = 0
	for (const arr of arrays) {
		result.set(arr, offset)
		offset += arr.length
	}
	return result
}

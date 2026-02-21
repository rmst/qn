import { execFile } from './execFile.js'
import { checkUnsupportedOptions, checkEncodingOption } from './utils.js'
import { promisify } from 'node:util'

const UNSUPPORTED_OPTIONS = [
	'uid',
	'gid',
	'signal',
]

/**
 * Execute a shell command asynchronously.
 *
 * @param {string} command - The shell command to run.
 * @param {Object} [options] - Optional parameters.
 * @param {string} [options.cwd] - Working directory for the command.
 * @param {Object} [options.env] - Environment variables for the command.
 * @param {string} [options.shell='/bin/sh'] - Shell to use.
 * @param {number} [options.timeout=0] - Timeout in milliseconds (0 means no timeout).
 * @param {string} [options.killSignal='SIGTERM'] - Signal to send when timeout expires.
 * @param {Function} [callback] - Called with (error, stdout, stderr) when process completes.
 * @returns {ChildProcess}
 *
 * @example
 * exec('ls -la', (error, stdout, stderr) => {
 *   if (error) console.error(error)
 *   else console.log(stdout)
 * })
 *
 * @example
 * const child = exec('cat')
 * child.stdin.write('hello')
 * child.stdin.end()
 */
export function exec(command, options, callback) {
	// Handle overloaded arguments: exec(command, callback)
	if (typeof options === 'function') {
		callback = options
		options = {}
	}

	options = options || {}

	if (typeof command !== 'string') {
		throw new TypeError('command must be a string')
	}

	checkUnsupportedOptions(options, UNSUPPORTED_OPTIONS, 'exec')
	checkEncodingOption(options, 'exec')

	const shell = options.shell || '/bin/sh'

	// Pass through supported options, excluding shell since we handle it
	const execFileOptions = {
		cwd: options.cwd,
		env: options.env,
		input: options.input,
		encoding: options.encoding,
		timeout: options.timeout,
		killSignal: options.killSignal,
		maxBuffer: options.maxBuffer,
	}

	return execFile(shell, ['-c', command], execFileOptions, callback)
}

exec[promisify.custom] = (command, options) => {
	return new Promise((resolve, reject) => {
		exec(command, options, (err, stdout, stderr) => {
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

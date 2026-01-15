import { execFile } from 'node/child_process/execFile.js'
import { checkUnsupportedOptions, checkEncodingOption } from 'node/child_process/utils.js'

const UNSUPPORTED_OPTIONS = [
	'timeout',
	'killSignal',
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
	}

	return execFile(shell, ['-c', command], execFileOptions, callback)
}

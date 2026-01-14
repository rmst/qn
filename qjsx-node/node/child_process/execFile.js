import * as std from 'std'
import * as os from 'os'
import { ChildProcess } from 'node/child_process/ChildProcess.js'

/**
 * Execute a file asynchronously.
 * @param {string} file - The command or executable file to run.
 * @param {string[]} [args=[]] - The list of arguments to pass to the command.
 * @param {Object} [options={}] - Optional parameters.
 * @param {Object} [options.env] - Environment variables for the command.
 * @param {string} [options.cwd] - Working directory for the command.
 * @param {string} [options.input] - A string to be passed as input to the command (closes stdin after).
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

	const env = options.env || std.getenviron()
	const cwd = options.cwd || undefined

	// Create pipes for all stdio
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

	// Create ChildProcess instance with streams
	const child = new ChildProcess(pid, {
		stdoutFd: stdoutRead,
		stderrFd: stderrRead,
		stdinFd: stdinWrite,
	})

	// Write input if provided and close stdin
	if (options.input !== undefined) {
		child.stdin.end(options.input)
	}

	// If callback provided, collect stream data and call on close
	if (typeof callback === 'function') {
		let stdoutData = ''
		let stderrData = ''

		child.stdout.on('data', (chunk) => {
			stdoutData += chunk
		})

		child.stderr.on('data', (chunk) => {
			stderrData += chunk
		})

		child.on('close', (code) => {
			const error = code !== 0
				? Object.assign(new Error(`Command failed: ${file}`), { code })
				: null
			callback(error, stdoutData, stderrData)
		})
	}

	return child
}

import * as std from 'std'
import * as os from 'os'
import { ChildProcess } from './ChildProcess.js'
import { parseStdio, setupStdioPipes, checkUnsupportedOptions } from './utils.js'

const UNSUPPORTED_OPTIONS = [
	'detached',
	'uid',
	'gid',
	'timeout',
	'killSignal',
	'serialization',
	'argv0',
	'windowsHide',
	'windowsVerbatimArguments',
]

/**
 * Spawn a child process.
 *
 * @param {string} command - The command to run.
 * @param {string[]} [args=[]] - List of string arguments.
 * @param {Object} [options={}] - Optional parameters.
 * @param {string} [options.cwd] - Working directory for the command.
 * @param {Object} [options.env] - Environment variables for the command.
 * @param {string|string[]} [options.stdio='pipe'] - stdio configuration.
 * @param {boolean|string} [options.shell=false] - Run command in shell.
 * @param {AbortSignal} [options.signal] - AbortSignal to abort the child process.
 * @returns {ChildProcess}
 *
 * @example
 * const child = spawn('ls', ['-la'])
 * child.stdout.on('data', (data) => console.log(data))
 * child.on('close', (code) => console.log('exited with', code))
 *
 * @example
 * const child = spawn('echo', ['hello'], { stdio: 'inherit' })
 */
export function spawn(command, args, options) {
	// Handle overloaded arguments: spawn(cmd, options)
	if (args && !Array.isArray(args)) {
		options = args
		args = []
	}

	args = args || []
	options = options || {}

	if (typeof command !== 'string') {
		throw new TypeError('command must be a string')
	}
	if (!Array.isArray(args)) {
		throw new TypeError('args must be an array')
	}

	checkUnsupportedOptions(options, UNSUPPORTED_OPTIONS, 'spawn')

	const env = options.env || std.getenviron()
	const cwd = options.cwd || undefined

	// Handle shell option
	let execCommand = command
	let execArgs = args
	if (options.shell) {
		const shell = typeof options.shell === 'string' ? options.shell : '/bin/sh'
		execArgs = ['-c', [command, ...args].join(' ')]
		execCommand = shell
	}

	// Setup pipes using shared utility
	const stdio = parseStdio(options.stdio)
	const { parentFds, execOptions, closeChildSide } = setupStdioPipes(stdio)

	// Add env and cwd to exec options
	execOptions.block = false
	execOptions.env = env
	execOptions.cwd = cwd

	// Spawn the process
	const pid = os.exec([execCommand, ...execArgs], execOptions)

	// Close child-side of pipes in parent
	closeChildSide()

	// Create ChildProcess instance
	const childOpts = {}
	if (parentFds.stdin !== null) childOpts.stdinFd = parentFds.stdin
	if (parentFds.stdout !== null) childOpts.stdoutFd = parentFds.stdout
	if (parentFds.stderr !== null) childOpts.stderrFd = parentFds.stderr

	const child = new ChildProcess(pid, childOpts)

	// Handle AbortSignal
	if (options.signal) {
		if (options.signal.aborted) {
			child.kill()
		} else {
			options.signal.addEventListener('abort', () => {
				child.kill()
			}, { once: true })
		}
	}

	return child
}

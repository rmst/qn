import * as std from 'std'
import * as os from 'os'
import { ChildProcess } from 'node/child_process/ChildProcess.js'
import { checkUnsupportedOptions } from 'node/child_process/utils.js'

const UNSUPPORTED_OPTIONS = [
	'detached',
	'uid',
	'gid',
	'signal',
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

	// Parse stdio option
	const stdio = parseStdio(options.stdio)

	// Create pipes based on stdio config
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
	const execOptions = { env, cwd, block: false }

	if (stdio[0] === 'pipe') {
		execOptions.stdin = stdinRead
	} else if (stdio[0] === 'ignore') {
		execOptions.stdin = os.open('/dev/null', os.O_RDONLY)
	}
	// 'inherit' means don't set - use parent's

	if (stdio[1] === 'pipe') {
		execOptions.stdout = stdoutWrite
	} else if (stdio[1] === 'ignore') {
		execOptions.stdout = os.open('/dev/null', os.O_WRONLY)
	}

	if (stdio[2] === 'pipe') {
		execOptions.stderr = stderrWrite
	} else if (stdio[2] === 'ignore') {
		execOptions.stderr = os.open('/dev/null', os.O_WRONLY)
	}

	// Spawn the process
	const pid = os.exec([execCommand, ...execArgs], execOptions)

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

	// Create ChildProcess instance
	const childOpts = {}
	if (stdio[0] === 'pipe') childOpts.stdinFd = stdinWrite
	if (stdio[1] === 'pipe') childOpts.stdoutFd = stdoutRead
	if (stdio[2] === 'pipe') childOpts.stderrFd = stderrRead

	return new ChildProcess(pid, childOpts)
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

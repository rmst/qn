import * as std from 'std'
import * as os from 'os'
import { Buffer } from 'node:buffer'
import {
	parseStdio,
	setupStdioPipes,
	getSignalNumber,
	signalName,
	readFromFd,
	readBytesFromFd,
	checkUnsupportedOptions,
	NodeCompatibilityError,
	writeInputToFd,
} from './utils.js'

const UNSUPPORTED_OPTIONS = ['uid', 'gid']

/**
 * Synchronously spawn a child process and return result object.
 *
 * @param {string} command - The command to run.
 * @param {string[]} [args=[]] - List of string arguments.
 * @param {Object} [options={}] - Optional parameters.
 * @param {string} [options.cwd] - Working directory.
 * @param {Object} [options.env] - Environment variables.
 * @param {string|Buffer} [options.input] - Input to write to stdin.
 * @param {string|string[]} [options.stdio='pipe'] - stdio configuration.
 * @param {string} [options.encoding] - If set, stdout/stderr are strings.
 * @param {number} [options.timeout] - Timeout in milliseconds.
 * @param {string} [options.killSignal='SIGTERM'] - Signal on timeout.
 * @param {boolean|string} [options.shell=false] - Run in shell.
 * @returns {{ pid: number, stdout: Buffer|string, stderr: Buffer|string, status: number|null, signal: string|null, error?: Error }}
 */
export function spawnSync(command, args, options) {
	// Handle overloaded arguments: spawnSync(cmd, options)
	if (args && !Array.isArray(args)) {
		options = args
		args = []
	}

	args = args || []
	options = options || {}

	if (typeof command !== 'string') {
		throw new TypeError('command must be a string')
	}

	checkUnsupportedOptions(options, UNSUPPORTED_OPTIONS, 'spawnSync')

	const encoding = options.encoding
	if (encoding && encoding.toLowerCase().replace('-', '') !== 'utf8') {
		throw new NodeCompatibilityError(
			`spawnSync: encoding '${encoding}' is not supported, only 'utf8' is supported`
		)
	}
	const useUtf8 = encoding && encoding.toLowerCase().replace('-', '') === 'utf8'

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

	// Write input then close stdin
	if (parentFds.stdin !== null) {
		if (options.input !== undefined) {
			writeInputToFd(parentFds.stdin, options.input)
		} else {
			os.close(parentFds.stdin)
		}
	}

	// Poll for process exit with timeout support
	const timeout = options.timeout || 0
	const killSignal = options.killSignal || 'SIGTERM'
	const startTime = Date.now()
	let timedOut = false
	let status = null
	let signal = null

	while (true) {
		const [ret, waitStatus] = os.waitpid(pid, os.WNOHANG)

		if (ret === pid) {
			if ((waitStatus & 0x7F) === 0) {
				status = (waitStatus >> 8) & 0xFF
			} else {
				signal = signalName(waitStatus & 0x7F)
			}
			break
		}

		if (timeout > 0 && Date.now() - startTime > timeout) {
			timedOut = true
			os.kill(pid, getSignalNumber(killSignal))
			os.waitpid(pid, 0)
			// Close pipes to prevent blocking reads
			if (parentFds.stdout !== null) os.close(parentFds.stdout)
			if (parentFds.stderr !== null) os.close(parentFds.stderr)
			break
		}

		os.sleep(1)
	}

	// Read stdout and stderr
	let stdout, stderr
	if (timedOut) {
		stdout = useUtf8 ? '' : Buffer.alloc(0)
		stderr = useUtf8 ? '' : Buffer.alloc(0)
	} else {
		if (parentFds.stdout !== null) {
			stdout = useUtf8 ? readFromFd(parentFds.stdout) : readBytesFromFd(parentFds.stdout)
		} else {
			stdout = useUtf8 ? '' : Buffer.alloc(0)
		}

		if (parentFds.stderr !== null) {
			stderr = useUtf8 ? readFromFd(parentFds.stderr) : readBytesFromFd(parentFds.stderr)
		} else {
			stderr = useUtf8 ? '' : Buffer.alloc(0)
		}
	}

	const result = {
		pid,
		stdout,
		stderr,
		status,
		signal: timedOut ? killSignal : signal,
		output: [null, stdout, stderr],
	}

	if (timedOut) {
		result.error = new Error(`spawnSync ${command} ETIMEDOUT`)
		result.error.code = 'ETIMEDOUT'
	}

	return result
}

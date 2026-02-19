import * as std from 'std'
import * as os from 'os'
import { Buffer } from 'node:buffer'
import { setNonBlock } from 'qn:uv-fs'
import {
	parseStdio,
	setupStdioPipes,
	getSignalNumber,
	signalName,
	checkUnsupportedOptions,
	NodeCompatibilityError,
	writeInputToFd,
} from './utils.js'

const UNSUPPORTED_OPTIONS = ['uid', 'gid']

function drainFd(fd, chunks) {
	const buf = new Uint8Array(65536)
	while (true) {
		const n = os.read(fd, buf.buffer, 0, buf.length)
		if (n > 0) {
			chunks.push(buf.slice(0, n))
		} else {
			break
		}
	}
}

function assembleOutput(chunks, useUtf8) {
	if (chunks.length === 0) return useUtf8 ? '' : Buffer.alloc(0)

	let totalLen = 0
	for (const chunk of chunks) totalLen += chunk.length
	if (totalLen === 0) return useUtf8 ? '' : Buffer.alloc(0)

	const result = Buffer.alloc(totalLen)
	let offset = 0
	for (const chunk of chunks) {
		result.set(chunk, offset)
		offset += chunk.length
	}

	if (useUtf8) {
		return std._decodeUtf8(result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength))
	}
	return result
}

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

	// Set stdout/stderr to non-blocking for draining during poll loop
	if (parentFds.stdout !== null) setNonBlock(parentFds.stdout)
	if (parentFds.stderr !== null) setNonBlock(parentFds.stderr)

	const stdoutChunks = []
	const stderrChunks = []

	// Poll for process exit with timeout support
	const timeout = options.timeout || 0
	const killSignal = options.killSignal || 'SIGTERM'
	const startTime = Date.now()
	let timedOut = false
	let status = null
	let signal = null

	while (true) {
		if (parentFds.stdout !== null) drainFd(parentFds.stdout, stdoutChunks)
		if (parentFds.stderr !== null) drainFd(parentFds.stderr, stderrChunks)

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
			break
		}

		os.sleep(1)
	}

	// Final drain and close
	if (parentFds.stdout !== null) {
		drainFd(parentFds.stdout, stdoutChunks)
		os.close(parentFds.stdout)
	}
	if (parentFds.stderr !== null) {
		drainFd(parentFds.stderr, stderrChunks)
		os.close(parentFds.stderr)
	}

	const stdout = assembleOutput(stdoutChunks, useUtf8)
	const stderr = assembleOutput(stderrChunks, useUtf8)

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

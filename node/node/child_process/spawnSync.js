import * as std from 'std'
import { Buffer } from 'node:buffer'
import { spawnSync as _spawnSync, killPid } from 'qn:uv-process'
import {
	parseStdio,
	getSignalNumber,
	signalName,
	checkUnsupportedOptions,
	NodeCompatibilityError,
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

	// Parse stdio config
	const stdio = parseStdio(options.stdio)

	// Prepare input as Uint8Array
	let inputBuf = null
	if (options.input !== undefined) {
		if (typeof options.input === 'string') {
			inputBuf = std._encodeUtf8(options.input)
		} else if (options.input instanceof ArrayBuffer) {
			inputBuf = new Uint8Array(options.input)
		} else if (ArrayBuffer.isView(options.input)) {
			inputBuf = new Uint8Array(options.input.buffer, options.input.byteOffset, options.input.byteLength)
		}
	}

	// Convert env object to "KEY=VALUE" array for C
	let envArr = null
	if (env) {
		envArr = Object.entries(env).map(([k, v]) => `${k}=${v}`)
	}

	const killSignal = options.killSignal || 'SIGTERM'
	const killSigNum = getSignalNumber(killSignal)

	// Call C-level synchronous spawn
	const raw = _spawnSync(execCommand, execArgs, {
		cwd,
		env: envArr,
		stdio,
		input: inputBuf,
		timeout: options.timeout || 0,
		killSignal: killSigNum,
	})

	// Convert raw Uint8Array stdout/stderr to Buffer or string
	const rawStdout = raw.stdout || new Uint8Array(0)
	const rawStderr = raw.stderr || new Uint8Array(0)

	let stdout, stderr
	if (useUtf8) {
		stdout = rawStdout.length > 0
			? std._decodeUtf8(rawStdout.buffer.slice(rawStdout.byteOffset, rawStdout.byteOffset + rawStdout.byteLength))
			: ''
		stderr = rawStderr.length > 0
			? std._decodeUtf8(rawStderr.buffer.slice(rawStderr.byteOffset, rawStderr.byteOffset + rawStderr.byteLength))
			: ''
	} else {
		stdout = Buffer.from(rawStdout)
		stderr = Buffer.from(rawStderr)
	}

	// Build result
	const status = raw.status
	const signal = raw.signal !== null ? signalName(raw.signal) : null

	const result = {
		pid: raw.pid,
		stdout,
		stderr,
		status,
		signal: raw.timedOut ? killSignal : signal,
		output: [null, stdout, stderr],
	}

	if (raw.error) {
		result.error = raw.error
	} else if (raw.timedOut) {
		result.error = new Error(`spawnSync ${command} ETIMEDOUT`)
		result.error.code = 'ETIMEDOUT'
	}

	return result
}

import * as std from 'std'
import * as os from 'os'
import { readFromFd, indent, checkUnsupportedOptions, checkEncodingOption, writeInputToFd } from './utils.js'

const UNSUPPORTED_OPTIONS = [
	'timeout',
	'killSignal',
	'uid',
	'gid',
	'stdio',
]

/**
 * Execute a shell command synchronously and return its output.
 *
 * @param {string} command - The shell command to run.
 * @param {Object} [options={}] - Optional parameters.
 * @param {Object} [options.env] - Environment variables for the command.
 * @param {string} [options.cwd] - Working directory for the command.
 * @param {string} [options.stdout] - Redirect stdout (can be 'inherit').
 * @param {string} [options.stderr] - Redirect stderr (can be 'inherit').
 * @param {string} [options.input] - A string to be passed as input to the command.
 * @param {string} [options.shell] - Shell to use (default: '/bin/sh').
 *
 * @returns {string} - The stdout output of the command (if not forwarded).
 *
 * @throws {Error} - Throws an error if the command exits with a non-zero status.
 *
 * @example
 * const output = execSync('echo "Hello, World!"')
 * console.log(output)  // Outputs: Hello, World!
 *
 * @example
 * const output = execSync('cat', { input: 'Hello from input!' })
 * console.log(output)  // Outputs: Hello from input!
 */
export function execSync(command, options = {}) {
	if (typeof command !== 'string') {
		throw new TypeError('command must be a string')
	}

	checkUnsupportedOptions(options, UNSUPPORTED_OPTIONS, 'execSync')
	checkEncodingOption(options, 'execSync')

	const shell = options.shell || '/bin/sh'
	const env = options.env || std.getenviron()
	const cwd = options.cwd || undefined

	// Create pipes for stdin, stdout, and stderr
	let stdinRead = null
	let stdinWrite = null
	if (options.input) {
		[stdinRead, stdinWrite] = os.pipe()
	}

	const inheritStdout = options.stdout === 'inherit'
	let stdoutRead, stdoutWrite
	if (!inheritStdout) {
		[stdoutRead, stdoutWrite] = os.pipe()
	}

	const inheritStderr = options.stderr === 'inherit'
	let stderrRead, stderrWrite
	if (!inheritStderr) {
		[stderrRead, stderrWrite] = os.pipe()
	}

	// Prepare the process execution
	const execOptions = {
		env,
		cwd,
		...(options.input ? { stdin: stdinRead } : {}),
		...(inheritStdout ? {} : { stdout: stdoutWrite }),
		...(inheritStderr ? {} : { stderr: stderrWrite }),
	}

	// Write input to the process if provided
	if (options.input) {
		writeInputToFd(stdinWrite, options.input)
	}

	const exitCode = os.exec([shell, '-c', command], execOptions)

	// Close the parent's copy of stdinRead after the child has inherited it
	if (options.input) {
		os.close(stdinRead)
	}

	// Read stdout and stderr from pipes if not forwarded
	let output = ""
	if (!inheritStdout) {
		os.close(stdoutWrite)
		output = readFromFd(stdoutRead)
		os.close(stdoutRead)
	}

	let errorOutput = ""
	if (!inheritStderr) {
		os.close(stderrWrite)
		errorOutput = readFromFd(stderrRead)
		os.close(stderrRead)
	}

	// Handle error case if exit code is non-zero
	if (exitCode !== 0) {
		let errorMsg = `Command: ${command}\n`
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

		errorMsg += `Stderr:\n${indent(errorOutput)}\n`

		const error = new Error(errorMsg)
		error.status = exitCode
		throw error
	}

	return output.trim()
}

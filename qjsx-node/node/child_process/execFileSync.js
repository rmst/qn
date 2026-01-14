import * as std from 'std'
import * as os from 'os'
import { readFromFd, indent } from 'node/child_process/utils.js'

/**
 * Execute a command synchronously and return its output.
 *
 * @param {string} file - The command or executable file to run.
 * @param {Array} [args=[]] - The list of arguments to pass to the command.
 * @param {Object} [options={}] - Optional parameters.
 * @param {Object} [options.env] - Environment variables for the command.
 * @param {string} [options.cwd] - Working directory for the command.
 * @param {string} [options.stdout] - Redirect stdout (can be 'inherit').
 * @param {string} [options.stderr] - Redirect stderr (can be 'inherit').
 * @param {string} [options.input] - A string to be passed as input to the command.
 *
 * @returns {string} - The stdout output of the command (if not forwarded).
 *
 * @throws {Error} - Throws an error if the command exits with a non-zero status.
 *
 * @example
 * const output = execFileSync('echo', ['Hello, World!'])
 * console.log(output)  // Outputs: Hello, World!
 *
 * @example
 * const output = execFileSync('cat', [], { input: 'Hello from input!' })
 * console.log(output)  // Outputs: Hello from input!
 *
 * @example
 * execFileSync('your_command', ['arg1'], { stdout: 'inherit', stderr: 'inherit' })
 */
export function execFileSync(file, args = [], options = {}) {
	if (typeof file !== 'string') {
		throw new TypeError('file must be a string')
	}
	if (!Array.isArray(args)) {
		throw new TypeError('args must be an array')
	}
	if (options != null && typeof options !== 'object') {
		throw new TypeError('options must be an object')
	}

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
		const inputFile = std.fdopen(stdinWrite, 'w')
		inputFile.puts(options.input)
		inputFile.close()
	}

	const exitCode = os.exec([file, ...args], execOptions)

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
		const argsSection = args
			.map(a => `'${a}'`)
			.join(', ')
			.replaceAll("\n", "\n  ")

		let errorMsg = `Command: ['${file}', ${argsSection}]\n`
		if (argsSection.includes("\n")) {
			errorMsg += "\n"
		}

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
		if (errorOutput.includes("\n")) {
			errorMsg += "\n"
		}

		const error = new Error(errorMsg)
		error.status = exitCode
		throw error
	}

	return output.trim()
}

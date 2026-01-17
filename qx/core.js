/**
 * qx - Minimal zx-compatible shell scripting for QuickJS
 *
 * Provides the $ tagged template function for running shell commands
 * with a Promise-based API inspired by Google's zx.
 *
 * @see https://github.com/google/zx
 */

import process from 'node:process'
import { writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'

/**
 * ProcessOutput represents the result of a completed command.
 */
export class ProcessOutput {
	/** @type {string} */
	#stdout

	/** @type {string} */
	#stderr

	/** @type {number|null} */
	#exitCode

	/** @type {string|null} */
	#signal

	/**
	 * @param {string} stdout
	 * @param {string} stderr
	 * @param {number|null} exitCode
	 * @param {string|null} signal
	 */
	constructor(stdout, stderr, exitCode, signal = null) {
		this.#stdout = stdout
		this.#stderr = stderr
		this.#exitCode = exitCode
		this.#signal = signal
	}

	/** @returns {string} */
	get stdout() {
		return this.#stdout
	}

	/** @returns {string} */
	get stderr() {
		return this.#stderr
	}

	/** @returns {number|null} */
	get exitCode() {
		return this.#exitCode
	}

	/** @returns {string|null} */
	get signal() {
		return this.#signal
	}

	/**
	 * Returns stdout with trailing newline removed.
	 * @returns {string}
	 */
	toString() {
		return this.#stdout.replace(/\n$/, '')
	}

	/**
	 * Returns stdout as text (alias for toString for zx compatibility).
	 * @returns {string}
	 */
	text() {
		return this.toString()
	}

	/**
	 * Returns stdout split into lines.
	 * @param {string} [delimiter='\n']
	 * @returns {string[]}
	 */
	lines(delimiter = '\n') {
		return this.#stdout.split(delimiter).filter(line => line !== '')
	}

	/**
	 * Parses stdout as JSON.
	 * @returns {any}
	 */
	json() {
		return JSON.parse(this.#stdout)
	}
}

/**
 * ProcessPromise wraps a command execution with a Promise-based API.
 * Supports method chaining for configuration and output formatting.
 */
export class ProcessPromise extends Promise {
	/** @type {ChildProcess|null} */
	#child = null

	/** @type {boolean} */
	#nothrow = false

	/** @type {boolean} */
	#quiet = false

	/** @type {boolean} */
	#verbose = false

	/** @type {string} */
	#cmd = ''

	/** @type {string[]} */
	#args = []

	/** @type {object} */
	#options = {}

	/** @type {'initial'|'running'|'fulfilled'|'rejected'} */
	#stage = 'initial'

	/** @type {string} */
	#stdoutBuffer = ''

	/** @type {string} */
	#stderrBuffer = ''

	/** @type {ProcessPromise|null} */
	#pipeSource = null

	/**
	 * Create a ProcessPromise. Use the $ function instead of calling directly.
	 * @param {function} executor
	 */
	constructor(executor) {
		let resolveFn, rejectFn
		super((resolve, reject) => {
			resolveFn = resolve
			rejectFn = reject
		})
		this._resolve = resolveFn
		this._reject = rejectFn

		if (typeof executor === 'function') {
			executor(resolveFn, rejectFn)
		}
	}

	/**
	 * Configure the command to run.
	 * @internal
	 */
	_configure(cmd, args, options = {}) {
		this.#cmd = cmd
		this.#args = args
		this.#options = options
		return this
	}

	/**
	 * Start the process execution.
	 * @returns {this}
	 */
	run() {
		if (this.#stage !== 'initial') {
			return this
		}

		// If no command was configured, skip execution (used by pipe-to-file)
		if (!this.#cmd) {
			return this
		}

		this.#stage = 'running'

		const shellCmd = this.#options.shell ? '/bin/sh' : this.#cmd
		const shellArgs = this.#options.shell ? ['-c', `${this.#cmd} ${this.#args.join(' ')}`] : this.#args

		if (this.#verbose && !this.#quiet) {
			process.stderr.write(`$ ${this.#cmd} ${this.#args.join(' ')}\n`)
		}

		const child = execFile(shellCmd, shellArgs, {
			env: this.#options.env,
			cwd: this.#options.cwd,
		})

		this.#child = child

		// Set encoding for string output
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')

		child.stdout.on('data', (chunk) => {
			this.#stdoutBuffer += chunk
			if (!this.#quiet) {
				process.stdout.write(chunk)
			}
		})

		child.stderr.on('data', (chunk) => {
			this.#stderrBuffer += chunk
			if (!this.#quiet) {
				process.stderr.write(chunk)
			}
		})

		// If we have a pipe source, connect it
		if (this.#pipeSource) {
			this.#pipeSource.then((output) => {
				child.stdin.end(output.stdout)
			}).catch((err) => {
				child.stdin.end()
			})
		}

		child.on('close', (code, signal) => {
			const output = new ProcessOutput(
				this.#stdoutBuffer,
				this.#stderrBuffer,
				code,
				signal
			)

			if (code !== 0 && !this.#nothrow) {
				this.#stage = 'rejected'
				const error = new Error(
					`Command failed with exit code ${code}: ${this.#cmd} ${this.#args.join(' ')}\n` +
					(this.#stderrBuffer ? `stderr: ${this.#stderrBuffer}` : '')
				)
				error.exitCode = code
				error.stdout = this.#stdoutBuffer
				error.stderr = this.#stderrBuffer
				this._reject(error)
			} else {
				this.#stage = 'fulfilled'
				this._resolve(output)
			}
		})

		return this
	}

	/**
	 * Get the current stage of the process.
	 * @returns {'initial'|'running'|'fulfilled'|'rejected'}
	 */
	get stage() {
		return this.#stage
	}

	/**
	 * Get the child process stdin stream.
	 * Triggers process execution when accessed.
	 * @returns {Writable}
	 */
	get stdin() {
		this.run()
		return this.#child?.stdin
	}

	/**
	 * Get the child process stdout stream.
	 * @returns {Readable}
	 */
	get stdout() {
		this.run()
		return this.#child?.stdout
	}

	/**
	 * Get the child process stderr stream.
	 * @returns {Readable}
	 */
	get stderr() {
		this.run()
		return this.#child?.stderr
	}

	/**
	 * Suppress exceptions on non-zero exit codes.
	 * @param {boolean} [flag=true]
	 * @returns {this}
	 */
	nothrow(flag = true) {
		this.#nothrow = flag
		return this
	}

	/**
	 * Suppress output display.
	 * @param {boolean} [flag=true]
	 * @returns {this}
	 */
	quiet(flag = true) {
		this.#quiet = flag
		return this
	}

	/**
	 * Enable verbose output.
	 * @param {boolean} [flag=true]
	 * @returns {this}
	 */
	verbose(flag = true) {
		this.#verbose = flag
		return this
	}

	/**
	 * Pipe stdout to another ProcessPromise or write to a path.
	 * @param {ProcessPromise|string} dest
	 * @returns {ProcessPromise}
	 */
	pipe(dest) {
		if (dest instanceof ProcessPromise) {
			dest.#pipeSource = this
			this.run()
			return dest
		}

		if (typeof dest === 'string') {
			// Pipe to file using node:fs
			const filePipe = new ProcessPromise()
			this.run()
			this.then((output) => {
				try {
					writeFileSync(dest, output.stdout)
					filePipe._resolve(output)
				} catch (err) {
					filePipe._reject(err)
				}
			}).catch((err) => {
				filePipe._reject(err)
			})
			return filePipe
		}

		throw new Error('pipe() accepts ProcessPromise or file path')
	}

	/**
	 * Kill the process.
	 * @param {string} [signal='SIGTERM']
	 * @returns {boolean}
	 */
	kill(signal = 'SIGTERM') {
		if (this.#child) {
			return this.#child.kill(signal)
		}
		return false
	}

	/**
	 * Get output as text.
	 * @returns {Promise<string>}
	 */
	async text() {
		this.run()
		const output = await this
		return output.text()
	}

	/**
	 * Get output as lines array.
	 * @param {string} [delimiter='\n']
	 * @returns {Promise<string[]>}
	 */
	async lines(delimiter = '\n') {
		this.run()
		const output = await this
		return output.lines(delimiter)
	}

	/**
	 * Parse output as JSON.
	 * @returns {Promise<any>}
	 */
	async json() {
		this.run()
		const output = await this
		return output.json()
	}

	/**
	 * Override then to auto-run the process.
	 */
	then(onFulfilled, onRejected) {
		this.run()
		return super.then(onFulfilled, onRejected)
	}

	/**
	 * Override catch to auto-run the process.
	 */
	catch(onRejected) {
		this.run()
		return super.catch(onRejected)
	}

	/**
	 * Override finally to auto-run the process.
	 */
	finally(onFinally) {
		this.run()
		return super.finally(onFinally)
	}
}

/**
 * Parse a command string into command and arguments.
 * Handles quoted strings and escape sequences.
 * @param {string} cmdString
 * @returns {{ cmd: string, args: string[] }}
 */
function parseCommand(cmdString) {
	const parts = []
	let current = ''
	let inSingleQuote = false
	let inDoubleQuote = false
	let escape = false

	for (let i = 0; i < cmdString.length; i++) {
		const char = cmdString[i]

		if (escape) {
			current += char
			escape = false
			continue
		}

		if (char === '\\' && !inSingleQuote) {
			escape = true
			continue
		}

		if (char === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote
			continue
		}

		if (char === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote
			continue
		}

		if ((char === ' ' || char === '\t' || char === '\n') && !inSingleQuote && !inDoubleQuote) {
			if (current) {
				parts.push(current)
				current = ''
			}
			continue
		}

		current += char
	}

	if (current) {
		parts.push(current)
	}

	const cmd = parts[0] || ''
	const args = parts.slice(1)

	return { cmd, args }
}

/**
 * Escape a value for safe shell interpolation (POSIX sh compatible).
 *
 * Uses single quotes which preserve all characters literally,
 * except for single quotes themselves which use the '\'' trick:
 * end quote, escaped quote, start quote.
 *
 * @param {any} value
 * @returns {string}
 */
function escapeArg(value) {
	if (value === null || value === undefined) {
		return ''
	}

	// ProcessOutput - use stdout
	if (value instanceof ProcessOutput) {
		return escapeArg(value.toString())
	}

	// Array - escape each element and join with spaces
	if (Array.isArray(value)) {
		return value.map(escapeArg).join(' ')
	}

	const str = `${value}`

	// Empty string needs quotes
	if (str === '') {
		return "''"
	}

	// If safe characters only, no quoting needed
	if (/^[a-zA-Z0-9_./:@=-]+$/.test(str)) {
		return str
	}

	// Use single quotes, escape embedded single quotes with '\''
	return "'" + str.replace(/'/g, "'\\''") + "'"
}

/**
 * The $ tagged template function for running shell commands.
 *
 * @example
 * const result = await $`echo "Hello, World!"`
 * console.log(result.stdout) // "Hello, World!\n"
 *
 * @example
 * const files = await $`ls -la`.lines()
 *
 * @example
 * const data = await $`cat data.json`.json()
 *
 * @example
 * await $`echo "hello"`.pipe($`cat`)
 *
 * @param {TemplateStringsArray} pieces
 * @param {...any} args
 * @returns {ProcessPromise}
 */
export function $(pieces, ...args) {
	// Build the command string from template
	let cmdString = pieces[0]
	for (let i = 0; i < args.length; i++) {
		cmdString += escapeArg(args[i])
		cmdString += pieces[i + 1]
	}

	cmdString = cmdString.trim()

	// Use shell mode for complex commands (pipes, redirects, etc.)
	const needsShell = /[|><&;]/.test(cmdString) || cmdString.includes('$(') || cmdString.includes('`')

	let cmd, shellArgs
	if (needsShell) {
		cmd = $.shell
		const prefix = $.prefix ? $.prefix + ' ' : ''
		shellArgs = ['-c', prefix + cmdString]
	} else {
		const parsed = parseCommand(cmdString)
		cmd = parsed.cmd
		shellArgs = parsed.args
	}

	const promise = new ProcessPromise()
	promise._configure(cmd, shellArgs, { shell: false })

	return promise
}

/**
 * Shell to use for commands (POSIX sh by default).
 * @type {string}
 */
$.shell = '/bin/sh'

/**
 * Prefix prepended to shell commands.
 * Default is 'set -e;' (exit on error).
 * Note: 'set -o pipefail' is not POSIX, use bash if needed.
 * @type {string}
 */
$.prefix = 'set -e;'

/**
 * Verbose mode - print commands before execution.
 * @type {boolean}
 */
$.verbose = false

/**
 * Default export is the $ function
 */
export default $

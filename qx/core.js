/**
 * qx - Shell scripting for QuickJS with better ergonomics than zx
 *
 * Key differences from zx:
 * - Configuration via $.quiet`...` instead of $`...`.quiet()
 * - No global mutable state for config ($.quiet = true throws)
 *
 * @example
 * // Basic usage
 * const result = await $`echo "Hello"`
 *
 * // Quiet mode - suppress output
 * const result = await $.quiet`echo "Hello"`
 *
 * // Chain configurations
 * const result = await $.quiet.nothrow`exit 1`
 *
 * // Reuse configured shell
 * const $q = $.quiet
 * await $q`cmd1`
 * await $q`cmd2`
 *
 * @see https://github.com/google/zx
 */

import * as os from 'os'
import process from 'node:process'
import { writeFileSync, globSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { Buffer } from 'node:buffer'

// Signal constants (some missing from QuickJS os module)
const signals = {
	SIGHUP: 1,
	SIGINT: os.SIGINT ?? 2,
	SIGQUIT: os.SIGQUIT ?? 3,
	SIGKILL: 9,
	SIGTERM: os.SIGTERM ?? 15,
}

/**
 * @typedef {Object} ShellConfig
 * @property {string} shell - Shell executable (default: '/bin/sh')
 * @property {string} prefix - Command prefix (default: 'set -e;')
 * @property {boolean} quiet - Suppress stdout/stderr output
 * @property {boolean} verbose - Print commands before execution
 * @property {boolean} nothrow - Don't throw on non-zero exit codes
 */

/** @type {ShellConfig} */
const defaultConfig = {
	shell: '/bin/sh',
	prefix: 'set -e;',
	quiet: false,
	verbose: false,
	nothrow: false,
}

/** @type {Set<number>} Track active process group leaders for cleanup */
const activeProcessGroups = new Set()

// Clean up process groups on exit
process.on('exit', () => {
	if (activeProcessGroups.size > 0) {
		console.error(`qx: killing ${activeProcessGroups.size} orphaned process group(s)`)
		for (const pgid of activeProcessGroups) {
			try { os.kill(-pgid, signals.SIGTERM) } catch {}
		}
		for (const pgid of activeProcessGroups) {
			try { os.kill(-pgid, signals.SIGKILL) } catch {}
		}
		// Reap killed children to avoid leaving zombies
		for (const pgid of activeProcessGroups) {
			try { os.waitpid(pgid, 0) } catch {}
		}
	}
})

/**
 * ProcessOutput represents the result of a completed command.
 * Stores data as binary (Buffer) internally, converts to string on demand.
 */
export class ProcessOutput {
	/** @type {Buffer} */
	#stdoutBuf

	/** @type {Buffer} */
	#stderrBuf

	/** @type {number|null} */
	#exitCode

	/** @type {string|null} */
	#signal

	/**
	 * @param {Buffer} stdout
	 * @param {Buffer} stderr
	 * @param {number|null} exitCode
	 * @param {string|null} signal
	 */
	constructor(stdout, stderr, exitCode, signal = null) {
		this.#stdoutBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '')
		this.#stderrBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr || '')
		this.#exitCode = exitCode
		this.#signal = signal
	}

	/**
	 * Returns stdout as a string (UTF-8).
	 * @returns {string}
	 */
	get stdout() {
		return this.#stdoutBuf.toString('utf8')
	}

	/**
	 * Returns stderr as a string (UTF-8).
	 * @returns {string}
	 */
	get stderr() {
		return this.#stderrBuf.toString('utf8')
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
	 * Returns stdout as a Buffer (binary data).
	 * @returns {Buffer}
	 */
	buffer() {
		return this.#stdoutBuf
	}

	/**
	 * Returns stderr as a Buffer (binary data).
	 * @returns {Buffer}
	 */
	stderrBuffer() {
		return this.#stderrBuf
	}

	/**
	 * Returns stdout with trailing newline removed.
	 * @returns {string}
	 */
	toString() {
		return this.stdout.replace(/\n$/, '')
	}

	/**
	 * Returns stdout as text (alias for toString for zx compatibility).
	 * @param {string} [encoding='utf8']
	 * @returns {string}
	 */
	text(encoding = 'utf8') {
		return this.#stdoutBuf.toString(encoding).replace(/\n$/, '')
	}

	/**
	 * Returns stdout split into lines.
	 * @param {string} [delimiter='\n']
	 * @returns {string[]}
	 */
	lines(delimiter = '\n') {
		return this.stdout.split(delimiter).filter(line => line !== '')
	}

	/**
	 * Parses stdout as JSON.
	 * @returns {any}
	 */
	json() {
		return JSON.parse(this.stdout)
	}
}

/**
 * ProcessPromise wraps a command execution with a Promise-based API.
 */
export class ProcessPromise extends Promise {
	/** @type {ChildProcess|null} */
	#child = null

	/** @type {ShellConfig} */
	#config

	/** @type {string} */
	#cmd = ''

	/** @type {string[]} */
	#args = []

	/** @type {'initial'|'running'|'fulfilled'|'rejected'} */
	#stage = 'initial'

	/** @type {Buffer[]} */
	#stdoutChunks = []

	/** @type {Buffer[]} */
	#stderrChunks = []

	/** @type {ProcessPromise|null} */
	#pipeSource = null

	/** @type {Array<{stream: Writable, ended: boolean}>} */
	#pipeTargets = []

	/** @type {Array<function>} */
	#stdoutListeners = []

	/** @type {number|null} */
	#timeoutId = null

	/**
	 * Create a ProcessPromise. Use the $ function instead of calling directly.
	 * @param {ShellConfig|function} configOrExecutor - Config object or executor function (for Promise compatibility)
	 */
	constructor(configOrExecutor = defaultConfig) {
		// Handle both direct construction (with config) and Promise.then() construction (with executor)
		const isExecutor = typeof configOrExecutor === 'function'

		let resolveFn, rejectFn
		super((resolve, reject) => {
			resolveFn = resolve
			rejectFn = reject
			// If called from Promise internals (e.g., .then()), call the executor
			if (isExecutor) {
				configOrExecutor(resolve, reject)
			}
		})

		this._resolve = resolveFn
		this._reject = rejectFn
		this.#config = isExecutor ? { ...defaultConfig } : { ...configOrExecutor }
	}

	/**
	 * Configure the command to run.
	 * @internal
	 */
	_configure(cmd, args) {
		this.#cmd = cmd
		this.#args = args
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

		if (!this.#cmd) {
			return this
		}

		this.#stage = 'running'

		if (this.#config.verbose && !this.#config.quiet) {
			process.stderr.write(`$ ${this.#cmd} ${this.#args.join(' ')}\n`)
		}

		// Use detached: true to create a new process group for reliable killing
		const child = execFile(this.#cmd, this.#args, { detached: true })
		this.#child = child

		// Track this process group for cleanup on exit
		// The child PID is also the PGID since it's a session leader
		activeProcessGroups.add(child.pid)

		// Don't set encoding - keep data as binary Buffers
		child.stdout.on('data', (chunk) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			this.#stdoutChunks.push(buf)
			if (!this.#config.quiet) {
				process.stdout.write(buf)
			}
			// Notify pipe targets (binary)
			for (const target of this.#pipeTargets) {
				if (!target.ended) {
					target.stream.write(buf)
				}
			}
			// Notify listeners
			for (const listener of this.#stdoutListeners) {
				listener(buf)
			}
		})

		child.stderr.on('data', (chunk) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			this.#stderrChunks.push(buf)
			if (!this.#config.quiet) {
				process.stderr.write(buf)
			}
		})

		// If we have a pipe source, connect it
		if (this.#pipeSource) {
			this.#pipeSource._pipeToStdin(child.stdin)
		}

		child.on('close', (code, signal) => {
			// Remove from active process groups
			activeProcessGroups.delete(child.pid)

			// Clear timeout if set
			if (this.#timeoutId) {
				clearTimeout(this.#timeoutId)
				this.#timeoutId = null
			}

			// Close stdin to avoid fd leak
			if (child.stdin && !child.stdin.destroyed) {
				child.stdin.destroy()
			}

			const stdout = Buffer.concat(this.#stdoutChunks)
			const stderr = Buffer.concat(this.#stderrChunks)
			const output = new ProcessOutput(stdout, stderr, code, signal)

			// End all pipe targets
			for (const target of this.#pipeTargets) {
				if (!target.ended) {
					target.ended = true
					target.stream.end()
				}
			}

			if (code !== 0 && !this.#config.nothrow) {
				this.#stage = 'rejected'
				const stderrStr = stderr.toString('utf8')
				const error = new Error(
					`Command failed with exit code ${code}: ${this.#cmd} ${this.#args.join(' ')}\n` +
					(stderrStr ? `stderr: ${stderrStr}` : '')
				)
				error.exitCode = code
				error.stdout = stdout.toString('utf8')
				error.stderr = stderrStr
				this._reject(error)
			} else {
				this.#stage = 'fulfilled'
				this._resolve(output)
			}
		})

		return this
	}

	/**
	 * Pipe buffered and future stdout to a writable stream.
	 * @internal
	 */
	_pipeToStdin(stdin) {
		// Replay buffered chunks
		for (const chunk of this.#stdoutChunks) {
			stdin.write(chunk)
		}

		// If already done, just end
		if (this.#stage === 'fulfilled' || this.#stage === 'rejected') {
			stdin.end()
			return
		}

		// Subscribe to future chunks
		const target = { stream: stdin, ended: false }
		this.#pipeTargets.push(target)
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
	 * @returns {Writable}
	 */
	get stdin() {
		return this.#child?.stdin
	}

	/**
	 * Get the child process stdout stream.
	 * @returns {Readable}
	 */
	get stdout() {
		return this.#child?.stdout
	}

	/**
	 * Get the child process stderr stream.
	 * @returns {Readable}
	 */
	get stderr() {
		return this.#child?.stderr
	}

	/**
	 * Suppress exceptions on non-zero exit codes.
	 * @deprecated Use $.nothrow`cmd` instead
	 * @param {boolean} [flag=true]
	 * @returns {this}
	 */
	nothrow(flag = true) {
		this.#config.nothrow = flag
		return this
	}

	/**
	 * Suppress output display.
	 * @deprecated Use $.quiet`cmd` instead
	 * @param {boolean} [flag=true]
	 * @returns {this}
	 */
	quiet(flag = true) {
		this.#config.quiet = flag
		return this
	}

	/**
	 * Enable verbose output.
	 * @deprecated Use $.verbose`cmd` instead
	 * @param {boolean} [flag=true]
	 * @returns {this}
	 */
	verbose(flag = true) {
		this.#config.verbose = flag
		return this
	}

	/**
	 * Pipe stdout to another ProcessPromise or write to a path.
	 * Supports late piping - will replay buffered output.
	 * @param {ProcessPromise|string} dest
	 * @returns {ProcessPromise}
	 */
	pipe(dest) {
		if (dest instanceof ProcessPromise) {
			// With eager execution, dest may already be running
			// In that case, connect the pipe directly to its stdin
			if (dest.#stage === 'running' || dest.#stage === 'initial') {
				// If dest hasn't started yet, set pipeSource and start it
				if (dest.#stage === 'initial') {
					dest.#pipeSource = this
					dest.run()
				} else {
					// Dest already running - pipe directly to stdin
					this._pipeToStdin(dest.stdin)
				}
			}
			return dest
		}

		if (typeof dest === 'string') {
			const filePipe = new ProcessPromise(this.#config)
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
	 * Kill the process and its entire process group.
	 * Uses process group kill which reliably kills all descendants.
	 * @param {string|{sigkillTimeout?: number}} [signalOrOptions='SIGTERM']
	 * @param {{sigkillTimeout?: number}} [options={}]
	 * @returns {boolean}
	 */
	kill(signalOrOptions = 'SIGTERM', options = {}) {
		if (!this.#child || !this.#child.pid) {
			return false
		}

		let signal = 'SIGTERM'
		let opts = options
		if (typeof signalOrOptions === 'object') {
			opts = signalOrOptions
		} else {
			signal = signalOrOptions
		}
		const { sigkillTimeout = null } = opts

		const pgid = this.#child.pid // PGID == PID for session leader
		const sig = typeof signal === 'string' ? (signals[signal] || signals[`SIG${signal}`] || 15) : signal

		const child = this.#child

		// Kill the entire process group with a single call
		try {
			os.kill(-pgid, sig)
		} catch {
			// Process group already dead — force-close streams in case orphaned
			// descendant processes (in different process groups) keep pipes open
			if (sigkillTimeout != null) {
				if (child.stdout) child.stdout.destroy()
				if (child.stderr) child.stderr.destroy()
			}
			return false
		}

		// Poll and escalate to SIGKILL if processes don't exit in time
		if (sigkillTimeout != null && sig !== signals.SIGKILL) {
			const sleep = ms => new Promise(r => setTimeout(r, ms))
			const groupAlive = () => { try { os.kill(-pgid, 0); return true } catch { return false } }

			;(async () => {
				const startTime = Date.now()
				while (Date.now() - startTime < sigkillTimeout) {
					if (!groupAlive()) break
					await sleep(50)
				}
				if (groupAlive()) {
					try { os.kill(-pgid, signals.SIGKILL) } catch {}
				}
				// Force-close streams in case orphaned descendant processes
				// (in different process groups) keep pipes open indefinitely
				await sleep(200)
				if (child.stdout && !child.stdout.destroyed) child.stdout.destroy()
				if (child.stderr && !child.stderr.destroyed) child.stderr.destroy()
			})()
		}

		return true
	}

	/**
	 * Set a timeout for the process. If the process doesn't complete
	 * within the specified time, it will be killed.
	 * @param {number} ms - Timeout in milliseconds
	 * @param {string} [signal='SIGTERM'] - Signal to send on timeout
	 * @returns {ProcessPromise} this (for chaining)
	 */
	timeout(ms, signal = 'SIGTERM') {
		if (this.#timeoutId) {
			clearTimeout(this.#timeoutId)
		}
		this.#timeoutId = setTimeout(() => {
			if (this.#stage === 'running') {
				this.kill(signal)
			}
		}, ms)
		return this
	}

	/**
	 * Get output as a Buffer (binary data).
	 * @returns {Promise<Buffer>}
	 */
	async buffer() {
		const output = await this
		return output.buffer()
	}

	/**
	 * Get output as text.
	 * @param {string} [encoding='utf8']
	 * @returns {Promise<string>}
	 */
	async text(encoding = 'utf8') {
		const output = await this
		return output.text(encoding)
	}

	/**
	 * Get output as lines array.
	 * @param {string} [delimiter='\n']
	 * @returns {Promise<string[]>}
	 */
	async lines(delimiter = '\n') {
		const output = await this
		return output.lines(delimiter)
	}

	/**
	 * Parse output as JSON.
	 * @returns {Promise<any>}
	 */
	async json() {
		const output = await this
		return output.json()
	}
}

// Always quote interpolated strings for consistent behavior.
// This prevents subtle bugs where `$`'${file}'`` works for simple filenames
// but breaks when the filename contains spaces (since escapeArg would add its own quotes).
const ALWAYS_QUOTE = true

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

	// If safe characters only, no quoting needed (if ALWAYS_QUOTE is disabled)
	if (!ALWAYS_QUOTE && /^[a-zA-Z0-9_./:@=-]+$/.test(str)) {
		return str
	}

	// Use single quotes, escape embedded single quotes with '\''
	return "'" + str.replace(/'/g, "'\\''") + "'"
}

/**
 * Create a shell function with the given configuration.
 * @param {ShellConfig} config
 * @returns {Shell}
 */
function createShell(config) {
	/**
	 * Execute a shell command or return configured shell.
	 * @param {TemplateStringsArray|Object} piecesOrOptions
	 * @param {...any} args
	 * @returns {ProcessPromise|Shell}
	 */
	function shell(piecesOrOptions, ...args) {
		// $({...}) returns a configured shell
		if (piecesOrOptions && typeof piecesOrOptions === 'object' && !Array.isArray(piecesOrOptions) && !piecesOrOptions.raw) {
			return createShell({ ...config, ...piecesOrOptions })
		}

		const pieces = piecesOrOptions
		// Build the command string from template
		let cmdString = pieces[0]
		for (let i = 0; i < args.length; i++) {
			cmdString += escapeArg(args[i])
			cmdString += pieces[i + 1]
		}

		cmdString = cmdString.trim()

		// Always use shell to ensure proper variable expansion, globbing, etc.
		const prefix = config.prefix ? config.prefix + ' ' : ''
		const cmd = config.shell
		const shellArgs = ['-c', prefix + cmdString]

		const promise = new ProcessPromise(config)
		promise._configure(cmd, shellArgs)

		// Apply timeout if configured
		if (config.timeout) {
			promise.timeout(config.timeout)
		}

		// Run eagerly - command starts immediately
		promise.run()

		return promise
	}

	const configOptions = new Set(['quiet', 'verbose', 'nothrow', 'shell', 'prefix'])

	return new Proxy(shell, {
		get(target, prop) {
			// Config options return a new shell with that option enabled
			if (prop === 'quiet') {
				return createShell({ ...config, quiet: true })
			}
			if (prop === 'verbose') {
				return createShell({ ...config, verbose: true })
			}
			if (prop === 'nothrow') {
				return createShell({ ...config, nothrow: true })
			}
			// Allow reading shell and prefix
			if (prop === 'shell') {
				return config.shell
			}
			if (prop === 'prefix') {
				return config.prefix
			}
			return Reflect.get(target, prop)
		},
		set(target, prop, value) {
			// Prevent setting config options directly
			if (configOptions.has(prop)) {
				const suggestion = (prop === 'shell' || prop === 'prefix')
					? `Use $({ ${prop}: '...' })\`cmd\` instead.`
					: `Use $.${prop}\`cmd\` instead.`
				throw new Error(`Cannot set $.${prop}. ${suggestion}`)
			}
			return Reflect.set(target, prop, value)
		}
	})
}

/**
 * The $ tagged template function for running shell commands.
 *
 * Commands run immediately when called (eager execution).
 * Use $.quiet, $.verbose, $.nothrow to get configured shells.
 *
 * @example
 * // Basic usage - command runs immediately
 * const result = await $`echo "Hello, World!"`
 *
 * @example
 * // Quiet mode - suppress output
 * const result = await $.quiet`echo "Hello"`
 *
 * @example
 * // Chain configurations
 * const result = await $.quiet.nothrow`exit 1`
 *
 * @example
 * // Store configured shell for reuse
 * const $q = $.quiet
 * await $q`cmd1`
 * await $q`cmd2`
 *
 * @example
 * // Piping (late piping works too)
 * await $`echo "hello"`.pipe($`cat`)
 *
 * @type {Shell}
 */
export const $ = createShell({ ...defaultConfig })

/**
 * @typedef {function(TemplateStringsArray, ...any): ProcessPromise} Shell
 * @property {Shell} quiet - Returns a shell that suppresses output
 * @property {Shell} verbose - Returns a shell that prints commands before execution
 * @property {Shell} nothrow - Returns a shell that doesn't throw on non-zero exit
 * @property {string} shell - The shell executable (default: '/bin/sh')
 * @property {string} prefix - Command prefix (default: 'set -e;')
 */

export default $

/**
 * Retry a function multiple times until it succeeds.
 * @param {number} count - Maximum number of attempts
 * @param {function(): Promise<T>} fn - Async function to retry
 * @returns {Promise<T>} Result of the function
 * @template T
 *
 * @example
 * const result = await retry(3, () => $.quiet`curl https://example.com`)
 */
export async function retry(count, fn) {
	let lastError
	for (let i = 0; i < count; i++) {
		try {
			return await fn()
		} catch (err) {
			lastError = err
		}
	}
	throw lastError
}

/**
 * Find files matching glob patterns.
 * Compatible with zx's glob() function.
 *
 * @param {string|string[]} patterns - Glob pattern(s) to match
 * @param {Object} [options] - Options
 * @param {string} [options.cwd] - Current working directory
 * @param {boolean} [options.dot] - Include dotfiles
 * @param {string[]} [options.ignore] - Patterns to ignore
 * @returns {Promise<string[]>} Array of matching file paths
 *
 * @example
 * const files = await glob('*.js')
 * const allJs = await glob(['src/**\/*.js', 'lib/**\/*.js'])
 * const filtered = await glob('**\/*.ts', { ignore: ['node_modules/**'] })
 */
export async function glob(patterns, options = {}) {
	const { cwd, dot, ignore } = options

	// Convert ignore patterns to negative patterns
	let allPatterns = Array.isArray(patterns) ? [...patterns] : [patterns]
	if (ignore && ignore.length > 0) {
		for (const ignorePattern of ignore) {
			allPatterns.push('!' + ignorePattern)
		}
	}

	return globSync(allPatterns, { cwd, dot })
}

import * as os from 'os'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { signals } from 'qn_uv_signals'

/**
 * Represents a spawned child process.
 * @extends EventEmitter
 * @see https://nodejs.org/api/child_process.html#class-childprocess
 *
 * Events:
 * - 'spawn' - Emitted once the process has spawned successfully
 * - 'error' - Emitted when the process could not be spawned or killed
 * - 'exit' - Emitted when the process exits (code, signal)
 * - 'close' - Emitted when stdio streams have closed (code, signal)
 */
export class ChildProcess extends EventEmitter {
	/** @type {number|undefined} */
	pid = undefined

	/** @type {number|null} */
	exitCode = null

	/** @type {string|null} */
	signalCode = null

	/** @type {boolean} */
	killed = false

	/** @type {Writable|null} */
	stdin = null

	/** @type {Readable|null} */
	stdout = null

	/** @type {Readable|null} */
	stderr = null

	/** @type {boolean} */
	#stdoutClosed = false

	/** @type {boolean} */
	#stderrClosed = false

	/** @type {boolean} */
	#stdinClosed = false

	/** @type {boolean} */
	#exited = false

	/** @type {boolean} */
	#closed = false

	/** @type {boolean} */
	#detached = false

	/**
	 * @param {number} pid
	 * @param {{ stdoutFd: number|null, stderrFd: number|null, stdinFd: number|null, detached?: boolean }} fds
	 */
	constructor(pid, fds) {
		super()
		this.pid = pid
		this.#detached = fds.detached || false

		// Create streams for stdio
		// Note: use != null to catch both null and undefined
		if (fds.stdinFd != null) {
			this.stdin = new Writable(fds.stdinFd)
			this.stdin.on('close', () => {
				this.#stdinClosed = true
			})
		} else {
			this.#stdinClosed = true
		}

		if (fds.stdoutFd != null) {
			this.stdout = new Readable(fds.stdoutFd)
			this.stdout.on('close', () => {
				this.#stdoutClosed = true
				this.#checkClose()
			})
		} else {
			this.#stdoutClosed = true
		}

		if (fds.stderrFd != null) {
			this.stderr = new Readable(fds.stderrFd)
			this.stderr.on('close', () => {
				this.#stderrClosed = true
				this.#checkClose()
			})
		} else {
			this.#stderrClosed = true
		}

		// Emit 'spawn' on next tick
		os.setTimeout(() => this.emit('spawn'), 0)

		// If all streams are already "closed" (i.e., inherited/ignored, no fds to monitor),
		// we need to poll for process exit since there are no stream close events to trigger it
		if (this.#stdoutClosed && this.#stderrClosed && this.#stdinClosed) {
			this.#pollForExit()
		}
	}

	#pollForExit() {
		if (this.#exited) return
		this.#checkExit()
		if (!this.#exited) {
			os.setTimeout(() => this.#pollForExit(), 10)
		}
	}

	#checkExit() {
		if (this.#exited) return

		const [ret, status] = os.waitpid(this.pid, os.WNOHANG)
		if (ret === this.pid) {
			this.#exited = true
			// Decode waitpid status using POSIX macros
			// WIFEXITED: (status & 0x7F) == 0
			// WEXITSTATUS: (status >> 8) & 0xFF
			// WIFSIGNALED: ((status & 0x7F) + 1) >> 1 > 0
			// WTERMSIG: status & 0x7F
			if ((status & 0x7F) === 0) {
				// Normal exit
				this.exitCode = (status >> 8) & 0xFF
			} else {
				// Killed by signal
				this.signalCode = status & 0x7F
			}
			this.emit('exit', this.exitCode, this.signalCode)
			this.#checkClose()
		}
	}

	#checkClose() {
		// 'close' fires when both streams are closed AND process has exited
		// Guard against multiple emissions
		if (this.#closed) return

		if (this.#stdoutClosed && this.#stderrClosed) {
			// Check if process has exited
			if (!this.#exited) {
				this.#checkExit()
			}
			// Re-check #closed since checkExit may have triggered a nested checkClose
			if (this.#exited && !this.#closed) {
				this.#closed = true
				this.emit('close', this.exitCode, this.signalCode)
			} else if (!this.#exited) {
				// Process hasn't exited yet but streams are closed
				// Poll again after a short delay to avoid busy-waiting
				os.setTimeout(() => this.#checkClose(), 1)
			}
		}
	}

	/**
	 * Kill the child process.
	 * For detached processes, kills the entire process group.
	 * @param {string|number} [signal='SIGTERM']
	 * @returns {boolean}
	 */
	kill(signal = 'SIGTERM') {
		if (this.#exited) return false

		const sig = typeof signal === 'string' ? signals[signal] : signal
		if (sig === undefined) {
			throw new Error(`Unknown signal: ${signal}`)
		}

		try {
			if (this.#detached) {
				// For detached processes, kill the entire process group
				// The child is the session/group leader, so its PGID == its PID
				os.kill(-this.pid, sig)
			} else {
				os.kill(this.pid, sig)
			}
			this.killed = true
			return true
		} catch (e) {
			return false
		}
	}
}

/*
 * qn:pty — Pseudo-terminal API
 *
 * Usage:
 *   import { spawn } from 'qn:pty'
 *
 *   let pty = spawn('bash', [], { cols: 80, rows: 24 })
 *   pty.onData((data) => process.stdout.write(data))
 *   pty.onExit(({ exitCode, signal }) => console.log('exited', exitCode))
 *   pty.write('ls -la\n')
 *   pty.resize(120, 40)
 *   pty.kill()
 */

import {
	_op, SPAWN, WRITE, RESIZE, KILL, CLOSE,
	GET_PID, SET_ON_DATA, SET_ON_EXIT, PAUSE, RESUME,
} from 'qn_uv_pty'

/**
 * Spawn a process in a new pseudo-terminal.
 *
 * @param {string} file - Command to run
 * @param {string[]} [args] - Arguments
 * @param {object} [opts]
 * @param {number} [opts.cols=80] - Terminal columns
 * @param {number} [opts.rows=24] - Terminal rows
 * @param {string} [opts.cwd] - Working directory
 * @param {Record<string, string>} [opts.env] - Environment variables
 * @param {string} [opts.name='xterm-256color'] - Terminal type (TERM env var)
 * @returns {Pty}
 */
export function spawn(file, args, opts = {}) {
	let { cols = 80, rows = 24, cwd, env, name = 'xterm-256color' } = opts

	// When a custom env is provided, inject TERM as default.
	// Without custom env, the child inherits TERM from the parent.
	let envArr
	if (env) {
		let merged = { TERM: name, ...env }
		envArr = Object.entries(merged).map(([k, v]) => `${k}=${v}`)
	}

	let handle = _op(SPAWN, file, args, cols, rows, cwd, envArr)
	return new Pty(handle, cols, rows)
}

class Pty {
	#handle
	#cols
	#rows
	#dataListeners = []
	#exitListeners = []
	#exited = false
	#exitResult = null
	#decoder = new TextDecoder()

	constructor(handle, cols, rows) {
		this.#handle = handle
		this.#cols = cols
		this.#rows = rows

		_op(SET_ON_DATA, this.#handle, (data) => {
			let str = this.#decoder.decode(data)
			for (let fn of this.#dataListeners) fn(str)
		})

		_op(SET_ON_EXIT, this.#handle, (code, signal) => {
			this.#exited = true
			this.#exitResult = { exitCode: code, signal: signal ? signal : null }
			for (let fn of this.#exitListeners) fn(this.#exitResult)
		})
	}

	get pid() {
		return _op(GET_PID, this.#handle)
	}

	get cols() {
		return this.#cols
	}

	get rows() {
		return this.#rows
	}

	/**
	 * Register a data listener. Returns a dispose function.
	 * @param {(data: string) => void} fn
	 * @returns {{ dispose: () => void }}
	 */
	onData(fn) {
		this.#dataListeners.push(fn)
		return { dispose: () => {
			let i = this.#dataListeners.indexOf(fn)
			if (i >= 0) this.#dataListeners.splice(i, 1)
		}}
	}

	/**
	 * Register an exit listener. Returns a dispose function.
	 * If the process has already exited, the listener is called immediately.
	 * @param {(result: { exitCode: number, signal: number | null }) => void} fn
	 * @returns {{ dispose: () => void }}
	 */
	onExit(fn) {
		if (this.#exited) {
			fn(this.#exitResult)
			return { dispose: () => {} }
		}
		this.#exitListeners.push(fn)
		return { dispose: () => {
			let i = this.#exitListeners.indexOf(fn)
			if (i >= 0) this.#exitListeners.splice(i, 1)
		}}
	}

	write(data) {
		_op(WRITE, this.#handle, data)
	}

	resize(cols, rows) {
		_op(RESIZE, this.#handle, cols, rows)
		this.#cols = cols
		this.#rows = rows
	}

	kill(signal) {
		_op(KILL, this.#handle, signal)
	}

	pause() {
		_op(PAUSE, this.#handle)
	}

	resume() {
		_op(RESUME, this.#handle)
	}

	close() {
		_op(CLOSE, this.#handle)
	}
}

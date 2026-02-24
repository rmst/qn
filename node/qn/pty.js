/*
 * qn:pty — Pseudo-terminal API
 *
 * Usage:
 *   import { spawn } from 'qn:pty'
 *
 *   let pty = spawn('bash', [], { cols: 80, rows: 24 })
 *   pty.onData = (data) => process.stdout.write(data)
 *   pty.onExit = (code, signal) => console.log('exited', code, signal)
 *   pty.write('ls -la\n')
 *   pty.resize(120, 40)
 *   pty.kill()
 */

import {
	_op, SPAWN, WRITE, RESIZE, KILL, CLOSE,
	GET_PID, SET_ON_DATA, SET_ON_EXIT,
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
 * @returns {Pty}
 */
export function spawn(file, args, opts = {}) {
	let { cols = 80, rows = 24, cwd, env } = opts

	let envArr
	if (env) {
		envArr = Object.entries(env).map(([k, v]) => `${k}=${v}`)
	}

	let handle = _op(SPAWN, file, args, cols, rows, cwd, envArr)
	return new Pty(handle)
}

class Pty {
	#handle

	constructor(handle) {
		this.#handle = handle
	}

	get pid() {
		return _op(GET_PID, this.#handle)
	}

	set onData(fn) {
		_op(SET_ON_DATA, this.#handle, fn)
	}

	set onExit(fn) {
		_op(SET_ON_EXIT, this.#handle, fn)
	}

	write(data) {
		_op(WRITE, this.#handle, data)
	}

	resize(cols, rows) {
		_op(RESIZE, this.#handle, cols, rows)
	}

	kill(signal) {
		_op(KILL, this.#handle, signal)
	}

	close() {
		_op(CLOSE, this.#handle)
	}
}

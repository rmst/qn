import { execFileSync } from './execFileSync.js'

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
 * @param {number} [options.timeout=0] - Timeout in milliseconds (0 means no timeout).
 * @param {string} [options.killSignal='SIGTERM'] - Signal to send when timeout expires.
 *
 * @returns {string} - The stdout output of the command (if not forwarded).
 *
 * @throws {Error} - Throws an error if the command exits with a non-zero status or times out.
 *
 * @example
 * const output = execSync('echo "Hello, World!"')
 * console.log(output)  // Outputs: Hello, World!
 *
 * @example
 * const output = execSync('cat', { input: 'Hello from input!' })
 * console.log(output)  // Outputs: Hello from input!
 *
 * @example
 * // With timeout
 * try {
 *   execSync('sleep 10', { timeout: 1000 })
 * } catch (e) {
 *   console.log('Timed out!')
 * }
 */
export function execSync(command, options = {}) {
	if (typeof command !== 'string') {
		throw new TypeError('command must be a string')
	}

	const shell = options.shell || '/bin/sh'

	// Map stdout/stderr options to stdio array
	const stdio = [
		'pipe',
		options.stdout === 'inherit' ? 'inherit' : 'pipe',
		options.stderr === 'inherit' ? 'inherit' : 'pipe',
	]

	return execFileSync(shell, ['-c', command], {
		env: options.env,
		cwd: options.cwd,
		input: options.input,
		timeout: options.timeout,
		killSignal: options.killSignal,
		encoding: options.encoding ?? 'utf8',
		stdio,
	})
}

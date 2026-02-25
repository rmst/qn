/**
 * Node.js os module compatibility for Qn.
 * Implements the subset used by qn and jix tests.
 * @see https://nodejs.org/api/os.html
 */

import * as qjsOs from 'os'
import * as std from 'std'
import { getArch as _getArch } from 'qn_vm'

/**
 * Returns the operating system's default directory for temporary files.
 * @returns {string}
 */
export function tmpdir() {
	// Check TMPDIR, TMP, TEMP environment variables (standard on Unix/Windows)
	const env = std.getenv('TMPDIR') || std.getenv('TMP') || std.getenv('TEMP')
	if (env) return env

	// Fallback to /tmp on Unix-like systems
	return '/tmp'
}

/**
 * Returns the operating system platform.
 * @returns {string} 'linux', 'darwin', 'win32', etc.
 */
export function platform() {
	// QuickJS os.platform returns the platform string
	const p = qjsOs.platform
	// Normalize to Node.js conventions
	if (p === 'linux') return 'linux'
	if (p === 'darwin' || p === 'mac') return 'darwin'
	if (p === 'win32' || p === 'windows') return 'win32'
	if (p === 'freebsd') return 'freebsd'
	if (p === 'openbsd') return 'openbsd'
	return p || 'linux'
}

/**
 * Returns the operating system CPU architecture.
 * @returns {string} 'x64', 'arm64', etc.
 */
export function arch() {
	return _getArch()
}

/**
 * Returns the home directory of the current user.
 * @returns {string}
 */
export function homedir() {
	return std.getenv('HOME') || std.getenv('USERPROFILE') || '/'
}

/**
 * Returns the hostname of the operating system.
 * @returns {string}
 */
export function hostname() {
	// Not easily available in QuickJS, return a placeholder
	return 'localhost'
}

/**
 * Returns an array of objects containing information about each logical CPU core.
 * Simplified implementation.
 * @returns {Array}
 */
export function cpus() {
	return [{ model: 'unknown', speed: 0 }]
}

/**
 * Returns the total amount of system memory in bytes.
 * @returns {number}
 */
export function totalmem() {
	return 0
}

/**
 * Returns the amount of free system memory in bytes.
 * @returns {number}
 */
export function freemem() {
	return 0
}

/**
 * Returns the system uptime in seconds.
 * @returns {number}
 */
export function uptime() {
	return 0
}

/**
 * Returns the string path of the current user's home directory.
 * @returns {string}
 */
export function userInfo() {
	return {
		username: std.getenv('USER') || std.getenv('USERNAME') || 'user',
		uid: -1,
		gid: -1,
		shell: std.getenv('SHELL') || '/bin/sh',
		homedir: homedir()
	}
}

/**
 * End-of-line marker for the current OS.
 */
export const EOL = '\n'

/**
 * Object containing commonly used OS-specific constants.
 */
export const constants = {
	signals: {},
	errno: {}
}

export default {
	tmpdir,
	platform,
	arch,
	homedir,
	hostname,
	cpus,
	totalmem,
	freemem,
	uptime,
	userInfo,
	EOL,
	constants
}

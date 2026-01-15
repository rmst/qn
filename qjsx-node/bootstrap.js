#!/usr/bin/env qjsx-node
/**
 * QJSX-Node Bootstrap
 *
 * This is a minimal bootstrap file that acts as an interpreter for user scripts.
 * When compiled with qjsxc using the -D flag for all node modules, it creates
 * a standalone executable that can run any JavaScript file with embedded Node.js
 * compatibility modules.
 *
 * All node modules are embedded at compile time using qjsxc's -D flag, so they
 * are available to dynamically loaded scripts without needing external files.
 */

import * as std from "std"
import * as os from "os"

// Node.js compatibility error for unsupported features
class NodeCompatibilityError extends Error {
	constructor(message) {
		super(message)
		this.name = 'NodeCompatibilityError'
	}
}

// Timer globals
globalThis.setTimeout = (fn, delay, ...args) => {
	if (args.length > 0) {
		throw new NodeCompatibilityError('setTimeout does not support passing arguments to callback. Use an arrow function instead.')
	}
	return os.setTimeout(fn, delay)
}

globalThis.clearTimeout = os.clearTimeout

globalThis.setInterval = () => {
	throw new NodeCompatibilityError('setInterval is not supported')
}

globalThis.clearInterval = () => {
	throw new NodeCompatibilityError('clearInterval is not supported')
}

// Performance API
globalThis.performance = {
	now: os.now
}

// Base64 encoding/decoding
globalThis.btoa = (str) => {
	const bytes = new Uint8Array([...str].map(c => c.charCodeAt(0)))
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
	let result = ''
	for (let i = 0; i < bytes.length; i += 3) {
		const b1 = bytes[i], b2 = bytes[i + 1] ?? 0, b3 = bytes[i + 2] ?? 0
		result += chars[b1 >> 2]
		result += chars[((b1 & 3) << 4) | (b2 >> 4)]
		result += i + 1 < bytes.length ? chars[((b2 & 15) << 2) | (b3 >> 6)] : '='
		result += i + 2 < bytes.length ? chars[b3 & 63] : '='
	}
	return result
}

globalThis.atob = (str) => {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
	str = str.replace(/=+$/, '')
	let result = ''
	for (let i = 0; i < str.length; i += 4) {
		const b1 = chars.indexOf(str[i])
		const b2 = chars.indexOf(str[i + 1])
		const b3 = chars.indexOf(str[i + 2])
		const b4 = chars.indexOf(str[i + 3])
		result += String.fromCharCode((b1 << 2) | (b2 >> 4))
		if (b3 !== -1) result += String.fromCharCode(((b2 & 15) << 4) | (b3 >> 2))
		if (b4 !== -1) result += String.fromCharCode(((b3 & 3) << 6) | b4)
	}
	return result
}

// Add missing console methods for Node.js compatibility
console.error = (...args) => { std.err.puts(args.join(' ') + '\n'); std.err.flush() }
console.warn = console.error
console.info = console.log
console.debug = console.log

// If no script provided, start the REPL
if (scriptArgs.length < 2) {
	await import("repl")
} else {
	const scriptPath = scriptArgs[1]

	// Keep scriptArgs as-is to match Node.js argv behavior:
	// argv[0] = interpreter, argv[1] = script, argv[2+] = args

	// Load and execute the user's script
	try {
		await import(scriptPath)
	} catch (e) {
		std.err.puts("Error loading script: " + e.message + "\n")
		if (e.stack) {
			std.err.puts(e.stack + "\n")
		}
		std.exit(1)
	}
}

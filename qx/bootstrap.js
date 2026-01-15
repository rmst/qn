#!/usr/bin/env qx
/**
 * QX Bootstrap
 *
 * Minimal zx-compatible shell scripting for QuickJS.
 * This bootstrap provides the $ function and Node.js compatibility modules.
 *
 * All modules are embedded at compile time using qjsxc's -D flag.
 */

import * as os from "os"
import process from "node:process"
import $, { ProcessPromise, ProcessOutput } from "qx/core"

// Node.js compatibility error for unsupported features
class NodeCompatibilityError extends Error {
	constructor(message) {
		super(message)
		this.name = 'NodeCompatibilityError'
	}
}

// Timer globals (os.setTimeout is the only QuickJS API we need here)
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

// Add missing console methods for Node.js compatibility
console.error = (...args) => { process.stderr.write(args.join(' ') + '\n') }
console.warn = console.error
console.info = console.log
console.debug = console.log

// Expose $ and related classes globally (like zx)
globalThis.$ = $
globalThis.ProcessPromise = ProcessPromise
globalThis.ProcessOutput = ProcessOutput

// cd function for changing directories (uses node:process)
globalThis.cd = (path) => {
	process.chdir(path)
}

// pwd function (uses node:process)
globalThis.pwd = () => {
	return process.cwd()
}

// sleep function (returns a promise)
globalThis.sleep = (ms) => {
	return new Promise(resolve => setTimeout(resolve, ms))
}

// echo function (like zx's echo, uses node:process)
globalThis.echo = (...args) => {
	process.stdout.write(args.join(' ') + '\n')
}

// Quiet mode helper
globalThis.quiet = (fn) => {
	const prevVerbose = $.verbose
	$.verbose = false
	try {
		return fn()
	} finally {
		$.verbose = prevVerbose
	}
}

// within helper - run code in a different directory
globalThis.within = async (fn) => {
	const cwd = process.cwd()
	try {
		return await fn()
	} finally {
		process.chdir(cwd)
	}
}

// Argv parsing (like zx's argv, uses node:process)
globalThis.argv = process.argv.slice(2)

// If no script provided, start the REPL
if (process.argv.length < 2) {
	await import("repl")
} else {
	const scriptPath = process.argv[1]

	// Load and execute the user's script
	try {
		await import(scriptPath)
	} catch (e) {
		process.stderr.write("Error loading script: " + e.message + "\n")
		if (e.stack) {
			process.stderr.write(e.stack + "\n")
		}
		process.exit(1)
	}
}

#!/usr/bin/env qx
/**
 * QX Bootstrap
 *
 * Minimal zx-compatible shell scripting for QuickJS.
 * This bootstrap provides the $ function and Node.js compatibility modules.
 *
 * All modules are embedded at compile time using qjsxc's -D flag.
 */

import "node-globals"
import process from "node:process"
import $, { ProcessPromise, ProcessOutput } from "qx/core"

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
	await process._runScript(process.argv[1])
}

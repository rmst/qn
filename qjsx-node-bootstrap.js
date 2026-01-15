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

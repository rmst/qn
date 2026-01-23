#!/usr/bin/env qn
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
import "node-globals"

// If no script provided, start the REPL
if (scriptArgs.length < 2) {
	await import("repl")
} else if (scriptArgs[1] === '--test') {
	// Run test files (shell expands globs)
	await import('node:test')
	for (let i = 2; i < scriptArgs.length; i++) {
		await import(scriptArgs[i])
	}
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

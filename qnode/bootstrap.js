#!/usr/bin/env qnode
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

import "node-globals"
import process from "node:process"

// If no script provided, start the REPL
if (scriptArgs.length < 2) {
	await import("repl")
} else {
	await process._runScript(scriptArgs[1])
}

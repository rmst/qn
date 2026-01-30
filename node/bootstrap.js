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
import * as os from "os"
import "node-globals"
import { resolve } from "node:path"
import { globSync } from "node:fs"
import { commit, buildTime } from "qn:version-info"

/** Check if a pattern contains glob special characters */
function isGlobPattern(pattern) {
	return /[*?[\]{}!]/.test(pattern)
}

/** Check if a file exists */
function fileExists(path) {
	const [stat, err] = os.stat(path)
	return err === 0 && (stat.mode & os.S_IFMT) === os.S_IFREG
}

/**
 * Resolve a script path to an absolute path.
 * - Relative paths (./ or ../) are resolved against cwd
 * - Absolute paths are returned as-is
 * - Bare paths are returned as-is for QJSXPATH resolution
 */
function resolveScriptPath(path) {
	if (!path || path.startsWith('/')) return path
	if (path.startsWith('./') || path.startsWith('../')) return resolve(path)
	return path
}

// Handle --version flag
if (scriptArgs[1] === '--version' || scriptArgs[1] === '-V') {
	let version = `qn ${commit}`
	if (buildTime) version += ` (dirty, built ${buildTime})`
	std.out.puts(version + '\n')
	std.exit(0)
}

// Handle -e flag (evaluate string as script)
if (scriptArgs[1] === '-e' || scriptArgs[1] === '--eval') {
	if (scriptArgs.length < 3) {
		std.err.puts('Error: -e requires an argument\n')
		std.exit(1)
	}
	try {
		std.evalScript(scriptArgs[2])
	} catch (e) {
		std.err.puts("Error: " + e.message + "\n")
		if (e.stack) std.err.puts(e.stack + "\n")
		std.exit(1)
	}
	std.exit(0)
}

// If no script provided, start the REPL
if (scriptArgs.length < 2) {
	await import("repl")
} else if (scriptArgs[1] === '--test') {
	// Run test files with glob expansion (like Node.js)
	await import('node:test')

	// Separate explicit files from glob patterns (including negative patterns)
	const explicitFiles = []
	const patterns = []
	for (let i = 2; i < scriptArgs.length; i++) {
		const arg = scriptArgs[i]
		// Negative patterns and glob patterns go to glob, explicit files are added directly
		if (arg.startsWith('!') || isGlobPattern(arg) || !fileExists(arg)) {
			patterns.push(arg)
		} else {
			explicitFiles.push(arg)
		}
	}

	// Expand all patterns together (so negative patterns can exclude from positive ones)
	const globFiles = patterns.length > 0 ? globSync(patterns) : []

	// Combine and deduplicate using resolved paths
	const seen = new Set()
	const testFiles = []
	for (const file of [...explicitFiles, ...globFiles]) {
		const resolved = resolve(file)
		if (!seen.has(resolved)) {
			seen.add(resolved)
			testFiles.push(resolved)
		}
	}

	if (testFiles.length === 0) {
		std.err.puts('Warning: no test files found\n')
		std.exit(1)
	}

	for (const testPath of testFiles) {
		await import(testPath)
	}
} else {
	const scriptPath = resolveScriptPath(scriptArgs[1])

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

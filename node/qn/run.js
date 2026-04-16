/**
 * qn run — run package.json scripts
 *
 * Reads scripts from package.json and executes them via the system shell,
 * matching npm run behavior (uses /bin/sh on Unix).
 */

import { readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"

/**
 * Run a named script from package.json.
 * @param {string} projectDir - directory containing package.json
 * @param {string} scriptName - name of the script to run
 * @param {string[]} extraArgs - additional arguments passed after --
 * @returns {Promise<number>} exit code
 */
export function run(projectDir, scriptName, extraArgs = []) {
	let pkgJsonPath = join(projectDir, "package.json")
	if (!existsSync(pkgJsonPath)) {
		console.error(`No package.json found in ${projectDir}`)
		process.exit(1)
	}

	let pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"))
	let scripts = pkg.scripts || {}

	if (!scripts[scriptName]) {
		console.error(`Missing script: "${scriptName}"`)
		console.error()
		listScripts(scripts)
		process.exit(1)
	}

	let cmd = scripts[scriptName]
	if (extraArgs.length > 0) {
		cmd += " " + extraArgs.join(" ")
	}

	// Prepend node_modules/.bin to PATH (like npm does)
	let binDir = join(projectDir, "node_modules", ".bin")
	let env = { ...process.env }
	env.PATH = binDir + ":" + (env.PATH || "")
	env.npm_package_name = pkg.name || ""
	env.npm_lifecycle_event = scriptName

	return new Promise((resolve) => {
		let child = spawn(cmd, {
			shell: true,
			stdio: "inherit",
			cwd: projectDir,
			env,
		})
		child.on("close", (code) => {
			resolve(code || 0)
		})
	})
}

/**
 * Print available scripts from package.json.
 * @param {Record<string, string>} scripts
 */
function listScripts(scripts) {
	let names = Object.keys(scripts)
	if (names.length === 0) {
		console.log("No scripts found in package.json.")
		return
	}
	console.log("Available scripts:")
	for (let name of names) {
		console.log(`  ${name}`)
		console.log(`    ${scripts[name]}`)
	}
}

/**
 * CLI entry point.
 * @param {string[]} args - command line arguments after "run"
 */
export function cli(args) {
	let dir = process.cwd()

	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		if (args.length === 0) {
			// No args — list available scripts
			let pkgJsonPath = join(dir, "package.json")
			if (!existsSync(pkgJsonPath)) {
				console.error(`No package.json found in ${dir}`)
				process.exit(1)
			}
			let pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"))
			listScripts(pkg.scripts || {})
			return Promise.resolve()
		}
		console.log(`Usage: qn run <script> [-- args...]

Run a script defined in package.json.

Options:
  --help, -h    Show this help

Examples:
  qn run build
  qn run test -- --verbose`)
		return Promise.resolve()
	}

	let scriptName = args[0]
	let extraArgs = []

	// Everything after -- is passed to the script
	let dashDash = args.indexOf("--")
	if (dashDash !== -1) {
		extraArgs = args.slice(dashDash + 1)
	}

	return run(dir, scriptName, extraArgs).then((code) => {
		process.exitCode = code
	})
}

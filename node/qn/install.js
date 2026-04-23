/**
 * qn install — minimal package installer
 *
 * Reads package.json dependencies and installs them into node_modules/.
 * Supports: local paths (file:), git URLs (github:, git+https://).
 *
 * Missing features:
 * - npm registry fetching (npmjs.com)
 * - Transitive dependency installation
 * - Lockfile
 * - Semver resolution
 */

import { readFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, resolve, basename, dirname } from "node:path"

/**
 * Parse a dependency specifier into a type and value.
 * @param {string} name - package name
 * @param {string} spec - version/url specifier
 * @returns {{ type: "file" | "github" | "git", value: string }}
 */
function parseSpec(name, spec) {
	if (spec.startsWith("file:")) {
		return { type: "file", value: spec.slice(5) }
	}
	if (spec.startsWith("github:")) {
		return { type: "github", value: spec.slice(7) }
	}
	if (spec.startsWith("git+https://") || spec.startsWith("git+ssh://")) {
		return { type: "git", value: spec.replace(/^git\+/, "") }
	}
	if (/^https?:\/\/github\.com\//.test(spec)) {
		return { type: "git", value: spec }
	}
	// Bare version specifiers (npm) — not yet supported
	return { type: "npm", value: spec }
}

/**
 * Clone or fetch a git repo to a cache directory.
 * Returns the path to the cached clone.
 * @param {string} url - git URL
 * @param {string} cacheDir - base cache directory
 * @returns {string} path to cloned repo
 */
function gitClone(url, cacheDir) {
	// Derive a cache key from the URL
	let key = url.replace(/[^a-zA-Z0-9._-]/g, "_")
	let dest = join(cacheDir, key)

	if (existsSync(join(dest, ".git"))) {
		// Already cloned — pull latest
		try {
			execFileSync("git", ["-C", dest, "fetch", "--depth", "1"], { timeout: 30000 })
			execFileSync("git", ["-C", dest, "reset", "--hard", "FETCH_HEAD"], { timeout: 10000 })
		} catch {
			// Fetch failed (offline?) — use existing clone
		}
	} else {
		mkdirSync(dest, { recursive: true })
		execFileSync("git", ["clone", "--depth", "1", url, dest], { timeout: 60000 })
	}

	return dest
}

/**
 * Resolve a github shorthand (owner/repo, owner/repo#ref) to a cache path.
 * @param {string} spec - e.g. "rmst/tailpipe" or "rmst/tailpipe#v0.1.0"
 * @param {string} cacheDir - base cache directory
 * @returns {string} path to cloned repo
 */
function resolveGithub(spec, cacheDir) {
	let [repo, ref] = spec.split("#")
	let url = `https://github.com/${repo}.git`

	let key = repo.replace("/", "_") + (ref ? `_${ref}` : "")
	let dest = join(cacheDir, key)

	if (existsSync(join(dest, ".git"))) {
		try {
			execFileSync("git", ["-C", dest, "fetch", "--depth", "1", ...(ref ? ["origin", ref] : [])], { timeout: 30000 })
			execFileSync("git", ["-C", dest, "reset", "--hard", "FETCH_HEAD"], { timeout: 10000 })
		} catch {
			// Fetch failed — use existing clone
		}
	} else {
		mkdirSync(dest, { recursive: true })
		execFileSync("git", ["clone", "--depth", "1", ...(ref ? ["-b", ref] : []), url, dest], { timeout: 60000 })
	}

	return dest
}

/**
 * Resolve a file: path relative to the project directory.
 * @param {string} filePath - relative or absolute path
 * @param {string} projectDir - directory containing package.json
 * @returns {string} resolved absolute path
 */
function resolveFile(filePath, projectDir) {
	return resolve(projectDir, filePath)
}

/**
 * Copy a package into node_modules, respecting scoped names.
 * @param {string} name - package name (e.g. "tailpipe" or "@twind/core")
 * @param {string} srcDir - source directory to copy from
 * @param {string} nodeModulesDir - target node_modules directory
 */
function installPackage(name, srcDir, nodeModulesDir) {
	let destDir = join(nodeModulesDir, name)

	// Handle scoped packages (@scope/name)
	if (name.startsWith("@")) {
		let scope = name.split("/")[0]
		mkdirSync(join(nodeModulesDir, scope), { recursive: true })
	}

	// Remove existing
	if (existsSync(destDir)) {
		rmSync(destDir, { recursive: true })
	}

	cpSync(srcDir, destDir, { recursive: true })

	// Clean up .git directory in the copy
	let gitDir = join(destDir, ".git")
	if (existsSync(gitDir)) {
		rmSync(gitDir, { recursive: true })
	}
}

/**
 * Run a lifecycle script if present in the package.
 * @param {string} pkgDir - package directory
 * @param {string} name - script name (e.g. "prepare", "postinstall")
 * @param {object} [opts]
 * @param {object} [opts.pkg] - pre-parsed package.json
 * @param {string} [opts.binDir] - node_modules/.bin dir to prepend to PATH
 */
function runScript(pkgDir, name, opts = {}) {
	let pkg = opts.pkg
	if (!pkg) {
		let pkgJsonPath = join(pkgDir, "package.json")
		if (!existsSync(pkgJsonPath)) return
		pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"))
	}
	let script = pkg.scripts?.[name]
	if (!script) return

	let env = { ...process.env }
	// Ensure lifecycle scripts that invoke `qn` see the currently running binary,
	// not whatever `qn` happens to be on PATH.
	let pathParts = []
	if (opts.binDir) pathParts.push(opts.binDir)
	pathParts.push(dirname(process.execPath))
	env.PATH = pathParts.join(":") + ":" + (env.PATH || "")
	env.QN_EXECPATH = process.execPath
	env.npm_package_name = pkg.name || ""
	env.npm_lifecycle_event = name

	console.log(`  running ${name} script...`)
	try {
		execFileSync("sh", ["-c", script], { cwd: pkgDir, env, stdio: "inherit" })
	} catch (e) {
		console.error(`  ${name} script failed: ${e.message}`)
		throw e
	}
}

/**
 * Get the cache directory for git clones.
 * @returns {string}
 */
function getCacheDir() {
	let home = process.env.HOME || process.env.USERPROFILE || "/tmp"
	return join(home, ".cache", "qn", "packages")
}

/**
 * Install dependencies from a package.json file.
 * @param {string} projectDir - directory containing package.json
 * @param {object} [options]
 * @param {boolean} [options.dev=false] - include devDependencies
 */
export function install(projectDir, options = {}) {
	let pkgJsonPath = join(projectDir, "package.json")
	if (!existsSync(pkgJsonPath)) {
		console.error(`No package.json found in ${projectDir}`)
		process.exit(1)
	}

	let pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"))
	let deps = { ...pkg.dependencies }
	if (options.dev) {
		Object.assign(deps, pkg.devDependencies)
	}

	let nodeModulesDir = join(projectDir, "node_modules")
	let binDir = join(nodeModulesDir, ".bin")

	runScript(projectDir, "preinstall", { pkg, binDir })

	let names = Object.keys(deps)
	let unsupported = []

	if (names.length === 0) {
		console.log("No dependencies to install.")
	} else {
		mkdirSync(nodeModulesDir, { recursive: true })

		let cacheDir = getCacheDir()
		mkdirSync(cacheDir, { recursive: true })

		for (let name of names) {
			let spec = parseSpec(name, deps[name])
			let srcDir

			switch (spec.type) {
				case "file":
					srcDir = resolveFile(spec.value, projectDir)
					if (!existsSync(srcDir)) {
						console.error(`  file path not found: ${srcDir}`)
						process.exit(1)
					}
					console.log(`${name} <- ${spec.value}`)
					break

				case "github":
					console.log(`${name} <- github:${spec.value}`)
					srcDir = resolveGithub(spec.value, cacheDir)
					break

				case "git":
					console.log(`${name} <- ${spec.value}`)
					srcDir = gitClone(spec.value, cacheDir)
					break

				case "npm":
					unsupported.push(name)
					continue
			}

			installPackage(name, srcDir, nodeModulesDir)
			// Only run prepare for git-sourced packages (they may need a build step)
			if (spec.type === "github" || spec.type === "git") {
				runScript(join(nodeModulesDir, name), "prepare", { binDir })
			}
		}
	}

	if (unsupported.length > 0) {
		console.log(`\nSkipped (npm registry not yet supported): ${unsupported.join(", ")}`)
	}

	runScript(projectDir, "install", { pkg, binDir })
	runScript(projectDir, "postinstall", { pkg, binDir })
	runScript(projectDir, "prepare", { pkg, binDir })
}

/**
 * CLI entry point.
 * @param {string[]} args - command line arguments after "install"
 */
export function cli(args) {
	let dev = false
	let dir = process.cwd()

	for (let i = 0; i < args.length; i++) {
		let arg = args[i]
		if (arg === "--dev" || arg === "-D") {
			dev = true
		} else if (arg === "--help" || arg === "-h") {
			console.log(`Usage: qn install [options]

Install dependencies from package.json into node_modules/.

Options:
  --dev, -D     Include devDependencies
  --help, -h    Show this help

Supported dependency specifiers:
  "file:../path"              Local directory
  "github:owner/repo"         GitHub repository
  "github:owner/repo#ref"     GitHub repository at tag/branch/commit
  "git+https://url.git"       Git repository

Not yet supported:
  "^1.2.3", "~1.0.0", etc.   npm registry (planned)
  Transitive dependencies     (planned)`)
			return
		} else if (!arg.startsWith("-")) {
			dir = resolve(arg)
		} else {
			console.error(`Unknown option: ${arg}`)
			process.exit(1)
		}
	}

	install(dir, { dev })
}

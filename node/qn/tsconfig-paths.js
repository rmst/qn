/**
 * qn:tsconfig-paths — TypeScript `compilerOptions.paths` / `baseUrl` resolver.
 *
 * Shared between the bundler (compile-time) and the runtime (via a JS fallback
 * hook on unresolved bare imports). Runs as a fallback after node_modules
 * lookup so catch-all patterns like `"*": ["./../*"]` don't shadow real
 * packages, and pure-JS projects without a tsconfig pay only the cost of one
 * cached walk-up to the filesystem root.
 *
 * Handles: `compilerOptions.paths`, `compilerOptions.baseUrl`, and `extends`
 * chains (relative, absolute, and bare-package via node_modules walk).
 */

import { readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve as pathResolve } from "node:path"

const CONFIG_FILENAMES = ["tsconfig.json", "jsconfig.json"]

/* ------------------------------------------------------------------ *
 * JSONC parsing (tsconfig allows // line, /* block comments, and     *
 * trailing commas).                                                  *
 * ------------------------------------------------------------------ */

function stripJsonc(src) {
	let out = ""
	let i = 0
	let inStr = false, inLine = false, inBlock = false
	while (i < src.length) {
		const c = src[i], n = src[i + 1]
		if (inLine) {
			if (c === "\n") { inLine = false; out += c }
			i++; continue
		}
		if (inBlock) {
			if (c === "*" && n === "/") { inBlock = false; i += 2; continue }
			if (c === "\n") out += c
			i++; continue
		}
		if (inStr) {
			out += c
			if (c === "\\" && i + 1 < src.length) { out += src[i + 1]; i += 2; continue }
			if (c === '"') inStr = false
			i++; continue
		}
		if (c === '"') { inStr = true; out += c; i++; continue }
		if (c === "/" && n === "/") { inLine = true; i += 2; continue }
		if (c === "/" && n === "*") { inBlock = true; i += 2; continue }
		out += c; i++
	}
	// Drop trailing commas before } or ]
	return out.replace(/,(\s*[}\]])/g, "$1")
}

function readJsonc(path) {
	try { return JSON.parse(stripJsonc(readFileSync(path, "utf8"))) } catch { return null }
}

function isFileSafe(p) {
	try { return statSync(p).isFile() } catch { return false }
}

function isDirSafe(p) {
	try { return statSync(p).isDirectory() } catch { return false }
}

/* ------------------------------------------------------------------ *
 * Pattern matching                                                    *
 * ------------------------------------------------------------------ */

// Sort paths keys by TS specificity:
//   - Exact (non-wildcard) keys beat wildcard keys.
//   - Among wildcard keys, longer literal prefix wins (star appears later).
//   - Among exact keys, longer string wins.
function sortedPatternKeys(paths) {
	return Object.keys(paths).sort((a, b) => {
		const aw = a.includes("*"), bw = b.includes("*")
		if (aw !== bw) return aw ? 1 : -1
		if (!aw) return b.length - a.length
		return b.indexOf("*") - a.indexOf("*")
	})
}

// Match a single key against a specifier. Returns the wildcard capture (or ""
// for an exact match). Returns null if no match.
function matchPattern(key, spec) {
	if (!key.includes("*")) return key === spec ? "" : null
	const star = key.indexOf("*")
	const prefix = key.slice(0, star)
	const suffix = key.slice(star + 1)
	if (spec.length < prefix.length + suffix.length) return null
	if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) return null
	return spec.slice(prefix.length, spec.length - suffix.length)
}

/* ------------------------------------------------------------------ *
 * tsconfig loading (with `extends` chain)                             *
 * ------------------------------------------------------------------ */

// Resolve an `extends` specifier to an absolute .json path, or null.
function resolveExtends(ext, fromDir) {
	if (ext.startsWith(".") || isAbsolute(ext)) {
		let p = isAbsolute(ext) ? ext : pathResolve(fromDir, ext)
		if (!p.endsWith(".json")) p = p + ".json"
		return isFileSafe(p) ? p : null
	}
	// Bare: walk up node_modules for <pkg>[/subpath].
	let cur = fromDir
	while (true) {
		const candidate = join(cur, "node_modules", ext)
		let p = candidate
		if (!p.endsWith(".json")) p = p + ".json"
		if (isFileSafe(p)) return p
		if (isDirSafe(candidate)) {
			const pkg = readJsonc(join(candidate, "package.json"))
			if (pkg && typeof pkg.tsconfig === "string") {
				const pp = pathResolve(candidate, pkg.tsconfig)
				if (isFileSafe(pp)) return pp
			}
			const dflt = join(candidate, "tsconfig.json")
			if (isFileSafe(dflt)) return dflt
		}
		const parent = dirname(cur)
		if (parent === cur) return null
		cur = parent
	}
}

// Load a config with `extends` chain resolved. Returns
// { baseUrl, baseUrlDir, paths, pathsDir } (each *Dir is the dir of the
// config that last defined that field, so multi-extends inherits fields
// independently) or null if nothing path-related was set. Cached by
// absolute config path.
function loadConfig(configPath, cache, stack = new Set()) {
	if (cache.has(configPath)) return cache.get(configPath)
	if (stack.has(configPath)) return null
	stack.add(configPath)

	const raw = readJsonc(configPath)
	const configDir = dirname(configPath)
	let merged = { baseUrl: null, baseUrlDir: null, paths: null, pathsDir: null }

	const applyExtends = ext => {
		const parent = resolveExtends(ext, configDir)
		if (!parent) return
		const parentCfg = loadConfig(parent, cache, stack)
		if (!parentCfg) return
		// Field-by-field merge: inherited fields survive when a later extends
		// only defines other fields. Wholesale replacement would lose them.
		if (parentCfg.baseUrl != null) {
			merged = { ...merged, baseUrl: parentCfg.baseUrl, baseUrlDir: parentCfg.baseUrlDir }
		}
		if (parentCfg.paths != null) {
			merged = { ...merged, paths: parentCfg.paths, pathsDir: parentCfg.pathsDir }
		}
	}
	if (raw) {
		if (typeof raw.extends === "string") applyExtends(raw.extends)
		else if (Array.isArray(raw.extends)) {
			for (const e of raw.extends) if (typeof e === "string") applyExtends(e)
		}
	}

	const co = raw && raw.compilerOptions
	if (co) {
		if (typeof co.baseUrl === "string") {
			merged = { ...merged, baseUrl: co.baseUrl, baseUrlDir: configDir }
		}
		if (co.paths && typeof co.paths === "object") {
			merged = { ...merged, paths: co.paths, pathsDir: configDir }
		}
	}

	const result = (merged.paths || merged.baseUrl != null) ? merged : null
	cache.set(configPath, result)
	return result
}

// Walk up from `dir` to find the nearest tsconfig.json or jsconfig.json.
function findNearestConfig(dir, nearestByDir) {
	if (nearestByDir.has(dir)) return nearestByDir.get(dir)
	let cur = dir
	let found = null
	while (true) {
		for (const name of CONFIG_FILENAMES) {
			const p = join(cur, name)
			if (isFileSafe(p)) { found = p; break }
		}
		if (found) break
		const parent = dirname(cur)
		if (parent === cur) break
		cur = parent
	}
	nearestByDir.set(dir, found)
	return found
}

/* ------------------------------------------------------------------ *
 * Default probe (extension + index fallback)                          *
 * ------------------------------------------------------------------ */

const DEFAULT_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]

/**
 * Resolve an absolute base path to a file on disk, trying a list of
 * extensions and index.<ext> for directories. Returns the absolute path that
 * exists, or null.
 */
export function defaultProbe(absPath, extensions = DEFAULT_EXTS) {
	if (isFileSafe(absPath)) return absPath
	for (const ext of extensions) {
		if (isFileSafe(absPath + ext)) return absPath + ext
	}
	if (isDirSafe(absPath)) {
		for (const ext of extensions) {
			const idx = join(absPath, "index" + ext)
			if (isFileSafe(idx)) return idx
		}
	}
	return null
}

/* ------------------------------------------------------------------ *
 * Public resolver                                                     *
 * ------------------------------------------------------------------ */

/**
 * Build a resolver bound to a probe function. `probe(absPath)` is expected to
 * return the resolved absolute file path (after extension probing, etc.), or
 * null if nothing exists at that location.
 *
 * Returns `{ resolve(specifier, fromDir), clearCache() }`.
 */
export function createTsconfigPathsResolver({ probe } = {}) {
	const tryPath = probe || (p => defaultProbe(p))

	const configCache = new Map()
	const nearestByDir = new Map()

	function resolve(specifier, fromDir) {
		// Only bare specifiers (TS spec).
		if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || isAbsolute(specifier)) return null
		const configPath = findNearestConfig(fromDir, nearestByDir)
		if (!configPath) return null
		const cfg = loadConfig(configPath, configCache)
		if (!cfg) return null

		// If baseUrl is set anywhere in the chain, paths targets are anchored
		// at the absolute baseUrl (resolved against the dir of the config that
		// defined it). Otherwise paths are anchored at the dir of the config
		// that defined `paths`.
		const baseUrlAbs = cfg.baseUrl != null ? join(cfg.baseUrlDir, cfg.baseUrl) : null
		const pathsAnchor = baseUrlAbs || cfg.pathsDir

		const candidates = []
		if (cfg.paths && pathsAnchor) {
			for (const key of sortedPatternKeys(cfg.paths)) {
				const captured = matchPattern(key, specifier)
				if (captured === null) continue
				const targets = cfg.paths[key]
				if (!Array.isArray(targets)) break
				for (const tgt of targets) {
					if (typeof tgt !== "string") continue
					const substituted = key.includes("*") ? tgt.replace("*", captured) : tgt
					candidates.push(join(pathsAnchor, substituted))
				}
				break // best-matching key wins; don't try others
			}
		}
		// baseUrl-only fallback: treat bare specifier as path under baseUrl.
		if (baseUrlAbs) candidates.push(join(baseUrlAbs, specifier))

		for (const cand of candidates) {
			const hit = tryPath(cand)
			if (hit) return hit
		}
		return null
	}

	function clearCache() {
		configCache.clear()
		nearestByDir.clear()
	}

	return { resolve, clearCache }
}

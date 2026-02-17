/**
 * Shared utilities for bootstrap files (qn and qx)
 */

import * as os from "os"
import { resolve } from "node:path"
import * as std from "std"

/** Check if a path is a directory */
export function isDirectory(path) {
	const [stat, err] = os.stat(path)
	return err === 0 && (stat.mode & os.S_IFMT) === os.S_IFDIR
}

/**
 * Resolve a directory to its entry point file.
 * Matches Node.js behavior:
 * 1. If directory contains package.json with "main" field, use that
 * 2. Otherwise, fall back to index.js
 */
export function resolveDirectoryEntry(dirPath) {
	const pkgJsonPath = resolve(dirPath, 'package.json')

	try {
		const pkgJson = std.loadFile(pkgJsonPath)
		const pkg = JSON.parse(pkgJson)
		if (pkg.main) {
			return resolve(dirPath, pkg.main)
		}
	} catch {
		// No package.json or invalid JSON - fall through to index.js
	}

	return resolve(dirPath, 'index.js')
}

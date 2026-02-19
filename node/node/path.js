/**
 * Node.js path module shim for QuickJS
 * Implements POSIX path operations
 */

// Note: process.cwd() / process.chdir() come from node:process (node-globals)

export const sep = '/'
export const delimiter = ':'

/**
 * Normalize a path by resolving '.' and '..' segments and removing duplicate separators
 * @param {string} path
 * @returns {string}
 */
export function normalize(path) {
	if (typeof path !== 'string') {
		throw new TypeError('Path must be a string')
	}
	if (path.length === 0) return '.'

	const isAbsolutePath = path.charCodeAt(0) === 47 // '/'
	const trailingSlash = path.charCodeAt(path.length - 1) === 47 // '/'

	const segments = path.split('/')
	const result = []

	for (const segment of segments) {
		if (segment === '' || segment === '.') {
			continue
		}
		if (segment === '..') {
			if (result.length > 0 && result[result.length - 1] !== '..') {
				result.pop()
			} else if (!isAbsolutePath) {
				result.push('..')
			}
		} else {
			result.push(segment)
		}
	}

	let normalized = result.join('/')

	if (isAbsolutePath) {
		normalized = '/' + normalized
	}

	if (trailingSlash && normalized.length > 0 && normalized !== '/') {
		normalized += '/'
	}

	return normalized || '.'
}

/**
 * Join path segments together and normalize the result
 * @param {...string} paths
 * @returns {string}
 */
export function join(...paths) {
	if (paths.length === 0) return '.'

	let joined = ''
	for (const path of paths) {
		if (typeof path !== 'string') {
			throw new TypeError('Path must be a string')
		}
		if (path.length > 0) {
			if (joined.length === 0) {
				joined = path
			} else {
				joined += '/' + path
			}
		}
	}

	if (joined.length === 0) return '.'
	return normalize(joined)
}

/**
 * Check if a path is absolute
 * @param {string} path
 * @returns {boolean}
 */
export function isAbsolute(path) {
	if (typeof path !== 'string') {
		throw new TypeError('Path must be a string')
	}
	return path.length > 0 && path.charCodeAt(0) === 47 // '/'
}

/**
 * Resolve a sequence of paths to an absolute path
 * @param {...string} paths
 * @returns {string}
 */
export function resolve(...paths) {
	let resolvedPath = ''
	let resolvedAbsolute = false

	for (let i = paths.length - 1; i >= -1 && !resolvedAbsolute; i--) {
		let path
		if (i >= 0) {
			path = paths[i]
			if (typeof path !== 'string') {
				throw new TypeError('Path must be a string')
			}
		} else {
			// Use cwd as fallback
			path = getCwd()
		}

		if (path.length === 0) continue

		if (resolvedPath.length > 0) {
			resolvedPath = path + '/' + resolvedPath
		} else {
			resolvedPath = path
		}
		resolvedAbsolute = path.charCodeAt(0) === 47 // '/'
	}

	// Normalize and remove trailing slashes (except for root)
	resolvedPath = normalizeNoTrailing(resolvedPath)

	if (resolvedAbsolute) {
		return resolvedPath.length > 0 ? resolvedPath : '/'
	}

	return resolvedPath.length > 0 ? resolvedPath : '.'
}

/**
 * Normalize a path without preserving trailing slashes
 * @param {string} path
 * @returns {string}
 */
function normalizeNoTrailing(path) {
	const normalized = normalize(path)
	// Remove trailing slash unless it's the root
	if (normalized.length > 1 && normalized.charCodeAt(normalized.length - 1) === 47) {
		return normalized.slice(0, -1)
	}
	return normalized
}

/**
 * Get current working directory
 * @returns {string}
 */
function getCwd() {
	return process.cwd()
}

/**
 * Get the directory name of a path
 * @param {string} path
 * @returns {string}
 */
export function dirname(path) {
	if (typeof path !== 'string') {
		throw new TypeError('Path must be a string')
	}
	if (path.length === 0) return '.'

	const hasRoot = path.charCodeAt(0) === 47 // '/'
	let end = -1
	let matchedSlash = true

	for (let i = path.length - 1; i >= 1; --i) {
		if (path.charCodeAt(i) === 47) { // '/'
			if (!matchedSlash) {
				end = i
				break
			}
		} else {
			matchedSlash = false
		}
	}

	if (end === -1) {
		return hasRoot ? '/' : '.'
	}
	if (hasRoot && end === 1) {
		return '/'
	}
	return path.slice(0, end)
}

/**
 * Get the last portion of a path (file name)
 * @param {string} path
 * @param {string} [suffix]
 * @returns {string}
 */
export function basename(path, suffix) {
	if (typeof path !== 'string') {
		throw new TypeError('Path must be a string')
	}
	if (suffix !== undefined && typeof suffix !== 'string') {
		throw new TypeError('suffix must be a string')
	}

	let start = 0
	let end = -1
	let matchedSlash = true

	for (let i = path.length - 1; i >= 0; --i) {
		if (path.charCodeAt(i) === 47) { // '/'
			if (!matchedSlash) {
				start = i + 1
				break
			}
		} else if (end === -1) {
			matchedSlash = false
			end = i + 1
		}
	}

	if (end === -1) return ''

	let base = path.slice(start, end)

	if (suffix && base.endsWith(suffix)) {
		base = base.slice(0, base.length - suffix.length)
	}

	return base
}

/**
 * Get the extension of a path
 * @param {string} path
 * @returns {string}
 */
export function extname(path) {
	if (typeof path !== 'string') {
		throw new TypeError('Path must be a string')
	}

	let startDot = -1
	let startPart = 0
	let end = -1
	let matchedSlash = true
	let preDotState = 0

	for (let i = path.length - 1; i >= 0; --i) {
		const code = path.charCodeAt(i)
		if (code === 47) { // '/'
			if (!matchedSlash) {
				startPart = i + 1
				break
			}
			continue
		}
		if (end === -1) {
			matchedSlash = false
			end = i + 1
		}
		if (code === 46) { // '.'
			if (startDot === -1) {
				startDot = i
			} else if (preDotState !== 1) {
				preDotState = 1
			}
		} else if (startDot !== -1) {
			preDotState = -1
		}
	}

	if (startDot === -1 ||
		end === -1 ||
		preDotState === 0 ||
		(preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
		return ''
	}

	return path.slice(startDot, end)
}

/**
 * Parse a path into its components
 * @param {string} path
 * @returns {{ root: string, dir: string, base: string, ext: string, name: string }}
 */
export function parse(path) {
	if (typeof path !== 'string') {
		throw new TypeError('Path must be a string')
	}

	const ret = { root: '', dir: '', base: '', ext: '', name: '' }
	if (path.length === 0) return ret

	const isAbsolutePath = path.charCodeAt(0) === 47 // '/'
	let start = 0

	if (isAbsolutePath) {
		ret.root = '/'
		start = 1
	}

	let startDot = -1
	let startPart = start
	let end = -1
	let matchedSlash = true
	let i = path.length - 1
	let preDotState = 0

	for (; i >= start; --i) {
		const code = path.charCodeAt(i)
		if (code === 47) { // '/'
			if (!matchedSlash) {
				startPart = i + 1
				break
			}
			continue
		}
		if (end === -1) {
			matchedSlash = false
			end = i + 1
		}
		if (code === 46) { // '.'
			if (startDot === -1) {
				startDot = i
			} else if (preDotState !== 1) {
				preDotState = 1
			}
		} else if (startDot !== -1) {
			preDotState = -1
		}
	}

	if (end !== -1) {
		const partStart = startPart === 0 && isAbsolutePath ? 1 : startPart
		if (startDot === -1 ||
			preDotState === 0 ||
			(preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
			ret.base = path.slice(partStart, end)
			ret.name = ret.base
		} else {
			ret.name = path.slice(partStart, startDot)
			ret.base = path.slice(partStart, end)
			ret.ext = path.slice(startDot, end)
		}
	}

	if (startPart > 0) {
		ret.dir = path.slice(0, startPart - 1)
		// For paths like "/", dir should be "/" not ""
		if (ret.dir === '' && isAbsolutePath) {
			ret.dir = '/'
		}
	} else if (isAbsolutePath) {
		ret.dir = '/'
	}

	return ret
}

/**
 * Format a path object into a path string
 * @param {{ dir?: string, root?: string, base?: string, name?: string, ext?: string }} pathObject
 * @returns {string}
 */
export function format(pathObject) {
	if (pathObject === null || typeof pathObject !== 'object') {
		throw new TypeError('Parameter must be an object')
	}

	const dir = pathObject.dir || pathObject.root || ''
	const base = pathObject.base || (pathObject.name || '') + (pathObject.ext || '')

	if (!dir) {
		return base
	}

	if (dir === pathObject.root) {
		return dir + base
	}

	return dir + '/' + base
}

/**
 * Get the relative path from `from` to `to`
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function relative(from, to) {
	if (typeof from !== 'string') {
		throw new TypeError('from must be a string')
	}
	if (typeof to !== 'string') {
		throw new TypeError('to must be a string')
	}

	if (from === to) return ''

	from = resolve(from)
	to = resolve(to)

	if (from === to) return ''

	const fromStart = 1
	const fromEnd = from.length
	const fromLen = fromEnd - fromStart
	const toStart = 1
	const toLen = to.length - toStart

	const length = fromLen < toLen ? fromLen : toLen
	let lastCommonSep = -1
	let i = 0

	for (; i < length; i++) {
		const fromCode = from.charCodeAt(fromStart + i)
		if (fromCode !== to.charCodeAt(toStart + i)) {
			break
		} else if (fromCode === 47) { // '/'
			lastCommonSep = i
		}
	}

	if (i === length) {
		if (toLen > length) {
			if (to.charCodeAt(toStart + i) === 47) { // '/'
				return to.slice(toStart + i + 1)
			}
			if (i === 0) {
				return to.slice(toStart + i)
			}
		} else if (fromLen > length) {
			if (from.charCodeAt(fromStart + i) === 47) { // '/'
				lastCommonSep = i
			} else if (i === 0) {
				lastCommonSep = 0
			}
		}
	}

	let out = ''

	for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
		if (i === fromEnd || from.charCodeAt(i) === 47) { // '/'
			out += out.length === 0 ? '..' : '/..'
		}
	}

	return out + to.slice(toStart + lastCommonSep)
}

// POSIX-specific module (same as default on Unix systems)
export const posix = {
	sep,
	delimiter,
	normalize,
	join,
	isAbsolute,
	resolve,
	dirname,
	basename,
	extname,
	parse,
	format,
	relative,
}

// win32 module is not implemented (always use POSIX on QuickJS)
export const win32 = posix

// Default export
export default {
	sep,
	delimiter,
	normalize,
	join,
	isAbsolute,
	resolve,
	dirname,
	basename,
	extname,
	parse,
	format,
	relative,
	posix,
	win32,
}

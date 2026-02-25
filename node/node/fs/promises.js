/*
 * node:fs/promises - Async filesystem operations via libuv
 *
 * High-level operations (readFile, writeFile) are composed from
 * low-level fd primitives exposed by qn_uv_fs.
 */

import * as uv_fs from 'qn/uv-fs'
import { Buffer } from 'node:buffer'
import {
	rmSync,
	cpSync,
	constants,
} from 'node:fs'

function wrapSync(fn) {
	return (...args) => {
		try {
			return Promise.resolve(fn(...args))
		} catch (e) {
			return Promise.reject(e)
		}
	}
}

/* S_IFMT and type constants */
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFBLK = 0o060000
const S_IFCHR = 0o020000
const S_IFLNK = 0o120000
const S_IFIFO = 0o010000
const S_IFSOCK = 0o140000

function addStatMethods(obj) {
	obj.atime = new Date(obj.atimeMs)
	obj.mtime = new Date(obj.mtimeMs)
	obj.ctime = new Date(obj.ctimeMs)
	obj.birthtime = new Date(obj.birthtimeMs)
	obj.isDirectory = function() { return (this.mode & S_IFMT) === S_IFDIR }
	obj.isFile = function() { return (this.mode & S_IFMT) === S_IFREG }
	obj.isBlockDevice = function() { return (this.mode & S_IFMT) === S_IFBLK }
	obj.isCharacterDevice = function() { return (this.mode & S_IFMT) === S_IFCHR }
	obj.isSymbolicLink = function() { return (this.mode & S_IFMT) === S_IFLNK }
	obj.isFIFO = function() { return (this.mode & S_IFMT) === S_IFIFO }
	obj.isSocket = function() { return (this.mode & S_IFMT) === S_IFSOCK }
	return obj
}

/* ==== readFile/writeFile composed from fd primitives ==== */

export async function readFile(path, options) {
	let encoding = null
	let flag = 'r'
	if (typeof options === 'string') {
		encoding = options
	} else if (options) {
		if (options.encoding) encoding = options.encoding
		if (options.flag) flag = options.flag
	}

	if (encoding != null && encoding !== 'utf8' && encoding !== 'utf-8') {
		throw new Error(`readFile: encoding '${encoding}' is not supported, only 'utf8' is supported`)
	}
	const useUtf8 = encoding === 'utf8' || encoding === 'utf-8'

	const p = String(path)
	const fd = await uv_fs.open(p, flag)
	try {
		const st = await uv_fs.fstat(fd)
		const size = st.size
		if (size === 0) {
			/* Special files (e.g. /proc/*) report size 0 but have content.
			 * Read in chunks until EOF. */
			const chunks = []
			let total = 0
			for (;;) {
				const chunk = new Uint8Array(8192)
				const n = await uv_fs.read(fd, chunk, -1)
				if (n === 0) break
				chunks.push(n === chunk.length ? chunk : chunk.subarray(0, n))
				total += n
			}
			if (chunks.length === 0) {
				return useUtf8 ? '' : Buffer.alloc(0)
			}
			const result = new Uint8Array(total)
			let offset = 0
			for (const c of chunks) {
				result.set(c, offset)
				offset += c.length
			}
			if (useUtf8) {
				return new TextDecoder().decode(result)
			}
			return Buffer.from(result)
		}
		const buf = new Uint8Array(size)
		await uv_fs.read(fd, buf, 0)
		if (useUtf8) {
			return new TextDecoder().decode(buf)
		}
		return Buffer.from(buf)
	} finally {
		await uv_fs.close(fd)
	}
}

export async function writeFile(path, data, options) {
	let flag = 'w'
	let mode = 0o666
	if (typeof options === 'object' && options) {
		if (options.encoding != null && options.encoding !== 'utf8' && options.encoding !== 'utf-8') {
			throw new Error(`writeFile: encoding '${options.encoding}' is not supported, only 'utf8' is supported`)
		}
		if (options.flag) flag = options.flag
		if (options.mode != null) mode = options.mode
	} else if (typeof options === 'string') {
		if (options !== 'utf8' && options !== 'utf-8') {
			throw new Error(`writeFile: encoding '${options}' is not supported, only 'utf8' is supported`)
		}
	}

	const p = String(path)
	let buf
	if (typeof data === 'string') {
		buf = new TextEncoder().encode(data)
	} else if (data instanceof ArrayBuffer) {
		buf = new Uint8Array(data)
	} else if (ArrayBuffer.isView(data)) {
		buf = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
	} else {
		throw new TypeError('writeFile: data must be string, ArrayBuffer, or TypedArray')
	}
	const fd = await uv_fs.open(p, flag, mode)
	try {
		await uv_fs.write(fd, buf, -1)
	} finally {
		await uv_fs.close(fd)
	}
}

export async function appendFile(path, data, options) {
	const opts = typeof options === 'string' ? { encoding: options } : (options || {})
	return writeFile(path, data, { ...opts, flag: opts.flag || 'a' })
}

/* ==== Path operations (thin wrappers) ==== */

export function stat(path) {
	return uv_fs.stat(String(path)).then(addStatMethods)
}

export function lstat(path) {
	return uv_fs.lstat(String(path)).then(addStatMethods)
}

export async function readdir(path, options) {
	if (options && options.recursive) {
		throw new Error("readdir: 'recursive' option is not supported")
	}
	const p = String(path)
	const entries = await uv_fs.readdir(p)
	if (options && options.withFileTypes) {
		const results = []
		for (const name of entries) {
			const s = await uv_fs.lstat(p + '/' + name)
			results.push({
				name,
				parentPath: p,
				path: p,
				_mode: s.mode,
				isDirectory() { return (this._mode & S_IFMT) === S_IFDIR },
				isFile() { return (this._mode & S_IFMT) === S_IFREG },
				isSymbolicLink() { return (this._mode & S_IFMT) === S_IFLNK },
				isBlockDevice() { return (this._mode & S_IFMT) === S_IFBLK },
				isCharacterDevice() { return (this._mode & S_IFMT) === S_IFCHR },
				isFIFO() { return (this._mode & S_IFMT) === S_IFIFO },
				isSocket() { return (this._mode & S_IFMT) === S_IFSOCK },
			})
		}
		return results
	}
	return entries
}

export async function mkdir(path, options) {
	let mode = 0o777
	let recursive = false
	if (typeof options === 'object' && options) {
		if (options.mode != null) mode = options.mode
		if (options.recursive) recursive = true
	} else if (typeof options === 'number') {
		mode = options
	}

	const p = String(path)
	if (!recursive) return uv_fs.mkdir(p, mode)

	const parts = p.split('/').filter(s => s.length > 0)
	let current = p.startsWith('/') ? '/' : ''

	for (const part of parts) {
		current = current === '/' ? `/${part}` : `${current}/${part}`
		try {
			const st = await uv_fs.stat(current)
			if ((st.mode & S_IFMT) !== S_IFDIR) {
				throw new Error(`ENOTDIR: not a directory, mkdir '${current}'`)
			}
		} catch (e) {
			if (e.errno !== -2) throw e
			try {
				await uv_fs.mkdir(current, mode)
			} catch (e2) {
				// Race: another process may have created it
				try {
					const st = await uv_fs.stat(current)
					if ((st.mode & S_IFMT) !== S_IFDIR) throw e2
				} catch {
					throw e2
				}
			}
		}
	}
}

export function unlink(path) {
	return uv_fs.unlink(String(path))
}

export function rename(oldPath, newPath) {
	return uv_fs.rename(String(oldPath), String(newPath))
}

export function symlink(target, path, type) {
	// type param is only meaningful on Windows; accept but ignore on POSIX
	return uv_fs.symlink(String(target), String(path))
}

export function readlink(path) {
	return uv_fs.readlink(String(path))
}

export function realpath(path) {
	return uv_fs.realpath(String(path))
}

export function access(path, mode) {
	return uv_fs.access(String(path), mode ?? 0)
}

export function chmod(path, mode) {
	return uv_fs.chmod(String(path), mode)
}

export function utimes(path, atime, mtime) {
	const toSec = (t) => {
		if (t instanceof Date) return t.getTime() / 1000
		if (typeof t === 'string') return new Date(t).getTime() / 1000
		return Number(t)
	}
	return uv_fs.utimes(String(path), toSec(atime), toSec(mtime))
}

export function chown(path, uid, gid) {
	return uv_fs.chown(String(path), uid, gid)
}

export function lchown(path, uid, gid) {
	return uv_fs.lchown(String(path), uid, gid)
}

export function rmdir(path) {
	return uv_fs.rmdir(String(path))
}

export function copyFile(src, dest, mode) {
	if (mode !== undefined && mode !== 0) {
		throw new Error("copyFile: mode flags are not supported")
	}
	return uv_fs.copyfile(String(src), String(dest))
}

export function mkdtemp(prefix) {
	return uv_fs.mkdtemp(String(prefix) + 'XXXXXX')
}

export function link(existingPath, newPath) {
	return uv_fs.link(String(existingPath), String(newPath))
}

/* Fallbacks (no native async implementation yet) */

export const rm = wrapSync(rmSync)
export const cp = wrapSync(cpSync)

export { constants }

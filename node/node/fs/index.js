import * as std from 'std'
import { Buffer } from 'node:buffer'
import {
	statSync as native_stat, lstatSync as native_lstat,
	readdirSync as native_readdir, mkdirSync as native_mkdir,
	unlinkSync as native_unlink, rmdirSync as native_rmdir,
	renameSync as native_rename, symlinkSync as native_symlink,
	linkSync as native_link, readlinkSync as native_readlink,
	realpathSync as native_realpath, accessSync as native_access,
	chmodSync as native_chmod, chownSync as native_chown,
	lchownSync as native_lchown, utimesSync as native_utimes,
	copyfileSync as native_copyfile, mkdtempSync as native_mkdtemp,
	openSync as native_open, closeSync as native_close,
	S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFBLK, S_IFCHR, S_IFIFO, S_IFSOCK,
	O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND,
} from 'qn:uv-fs'

// Re-export glob functions from separate module
export { globSync, glob } from './glob.js'

/**
 * Dirent class for directory entries (used by readdirSync with withFileTypes)
 */
export class Dirent {
	constructor(name, parentPath, mode) {
		this.name = name
		this.parentPath = parentPath
		this.path = parentPath // Alias for compatibility
		this._mode = mode
	}

	isDirectory() {
		return (this._mode & S_IFMT) === S_IFDIR
	}

	isFile() {
		return (this._mode & S_IFMT) === S_IFREG
	}

	isSymbolicLink() {
		return (this._mode & S_IFMT) === S_IFLNK
	}

	isBlockDevice() {
		return (this._mode & S_IFMT) === S_IFBLK
	}

	isCharacterDevice() {
		return (this._mode & S_IFMT) === S_IFCHR
	}

	isFIFO() {
		return (this._mode & S_IFMT) === S_IFIFO
	}

	isSocket() {
		return (this._mode & S_IFMT) === S_IFSOCK
	}
}


export const writeFileSync = (path, data, options) => {
	options = typeof options === 'string' ? { encoding: options } : (options || {})

	const flag = options.flag || 'w'

	if (options.encoding != null && options.encoding !== 'utf8' && options.encoding !== 'utf-8') {
		throw new Error(`Unsupported encoding: ${options.encoding}. Only utf8 is supported.`)
	}

	const isBinary = data instanceof ArrayBuffer || ArrayBuffer.isView(data)

	const file = std.open(path, flag + (isBinary ? 'b' : ''))
	if (!file) {
		const err = new Error(`ENOENT: no such file or directory, open '${path}'`)
		err.code = 'ENOENT'
		err.path = path
		err.syscall = 'open'
		throw err
	}
	try {
		if (isBinary) {
			const buffer = data instanceof ArrayBuffer ? data : data.buffer
			const offset = ArrayBuffer.isView(data) ? data.byteOffset : 0
			const length = ArrayBuffer.isView(data) ? data.byteLength : data.byteLength
			file.write(buffer, offset, length)
		} else if (typeof data === 'string') {
			file.puts(data)
		} else {
			throw new TypeError('Data must be a string, ArrayBuffer, or TypedArray.')
		}
	} finally {
		file.close()
	}
}


export const appendFileSync = (path, data, options) => {
	options = typeof options === 'string' ? { encoding: options } : (options || {})

	if (options.encoding != null && options.encoding !== 'utf8' && options.encoding !== 'utf-8') {
		throw new Error(`Unsupported encoding: ${options.encoding}. Only utf8 is supported.`)
	}

	const isBinary = data instanceof ArrayBuffer || ArrayBuffer.isView(data)

	const file = std.open(path, 'a' + (isBinary ? 'b' : ''))
	if (!file) {
		const err = new Error(`ENOENT: no such file or directory, open '${path}'`)
		err.code = 'ENOENT'
		err.path = path
		err.syscall = 'open'
		throw err
	}
	try {
		if (isBinary) {
			const buffer = data instanceof ArrayBuffer ? data : data.buffer
			const offset = ArrayBuffer.isView(data) ? data.byteOffset : 0
			const length = ArrayBuffer.isView(data) ? data.byteLength : data.byteLength
			file.write(buffer, offset, length)
		} else if (typeof data === 'string') {
			file.puts(data)
		} else {
			throw new TypeError('Data must be a string, ArrayBuffer, or TypedArray.')
		}
	} finally {
		file.close()
	}
}


export const readFileSync = (path, options) => {
	options = typeof options === 'string' ? { encoding: options } : (options || {})

	const encoding = options.encoding
	const flag = options.flag || 'r'

	if (encoding != null && encoding !== 'utf8' && encoding !== 'utf-8') {
		throw new Error(`Unsupported encoding: ${encoding}. Only utf8 is supported.`)
	}

	const file = std.open(path, flag + 'b')
	if (!file) {
		const err = new Error(`ENOENT: no such file or directory, open '${path}'`)
		err.code = 'ENOENT'
		err.path = path
		err.syscall = 'open'
		throw err
	}

	try {
		if (encoding == null) {
			file.seek(0, std.SEEK_END)
			const size = file.tell()
			file.seek(0, std.SEEK_SET)
			const buffer = new ArrayBuffer(size)
			file.read(buffer, 0, size)
			return Buffer.from(buffer)
		} else {
			return file.readAsString()
		}
	} finally {
		file.close()
	}
}

export const readdirSync = (path, options = {}) => {
	const withFileTypes = options?.withFileTypes || false

	const files = native_readdir(path)

	if (!withFileTypes) {
		return files
	}

	return files.map(name => {
		const fullPath = path.endsWith('/') ? `${path}${name}` : `${path}/${name}`
		const st = native_lstat(fullPath)
		return new Dirent(name, path, st.mode)
	})
}

export const mkdirSync = (path, { mode = 0o777, recursive = false } = {}) => {

	if (!recursive) {
		native_mkdir(path, mode)
		return
	}

	const parts = path.split('/').filter(p => p.length > 0)
	let currentPath = path.startsWith('/') ? '/' : ''

	for (const part of parts) {
		currentPath = currentPath === '/' ? `/${part}` : `${currentPath}/${part}`

		try {
			const st = native_stat(currentPath)
			if ((st.mode & S_IFMT) !== S_IFDIR) {
				throw new Error(`Path exists but is not a directory: ${currentPath}`)
			}
			continue
		} catch (e) {
			if (e.errno !== -2 /* ENOENT */) throw e
		}

		try {
			native_mkdir(currentPath, mode)
		} catch (e) {
			// Re-check: another process may have created it concurrently (EEXIST race)
			try {
				const st = native_stat(currentPath)
				if ((st.mode & S_IFMT) !== S_IFDIR) {
					throw new Error(`Failed to create directory: ${currentPath}`)
				}
			} catch {
				throw new Error(`Failed to create directory: ${currentPath}`)
			}
		}
	}
}



// Helper function to create a Stats object from libuv stat result
function createStatsObject(statResult) {
	const { dev, ino, mode, nlink, uid, gid, rdev, size, blocks, blksize,
	        atimeMs, mtimeMs, ctimeMs, birthtimeMs } = statResult
	return {
		dev,
		ino,
		mode,
		nlink,
		uid,
		gid,
		rdev,
		size,
		blocks,
		blksize,
		atimeMs,
		mtimeMs,
		ctimeMs,
		birthtimeMs,
		atime: new Date(atimeMs),
		mtime: new Date(mtimeMs),
		ctime: new Date(ctimeMs),
		birthtime: new Date(birthtimeMs),
		isDirectory: function() { return (this.mode & S_IFMT) === S_IFDIR },
		isFile: function() { return (this.mode & S_IFMT) === S_IFREG },
		isBlockDevice: function() { return (this.mode & S_IFMT) === S_IFBLK },
		isCharacterDevice: function() { return (this.mode & S_IFMT) === S_IFCHR },
		isSymbolicLink: function() { return (this.mode & S_IFMT) === S_IFLNK },
		isFIFO: function() { return (this.mode & S_IFMT) === S_IFIFO },
		isSocket: function() { return (this.mode & S_IFMT) === S_IFSOCK },
	}
}

export const statSync = (path) => {
	return createStatsObject(native_stat(path))
}

export const lstatSync = (path) => {
	return createStatsObject(native_lstat(path))
}


export function existsSync(path) {
	try {
		native_stat(path)
		return true
	} catch {
		return false
	}
}

export function openSync(path, flags) {
	return native_open(path, flags)
}

export function closeSync(fd) {
	native_close(fd)
}

export function unlinkSync(path) {
	native_unlink(path)
}

export function linkSync(existingPath, newPath) {
	native_link(existingPath, newPath)
}

export function symlinkSync(target, path) {
	native_symlink(target, path)
}

export function renameSync(oldPath, newPath) {
	native_rename(oldPath, newPath)
}

export function chmodSync(path, mode) {
	native_chmod(path, mode)
}

export function copyFileSync(src, dest, mode) {
	if (mode !== undefined) {
		throw new Error('copyFileSync mode argument is not supported')
	}
	native_copyfile(src, dest)
}

export function cpSync(src, dest, options = {}) {
	const { recursive = false, force = false } = options

	const srcStat = native_lstat(src)

	const srcIsDir = (srcStat.mode & S_IFMT) === S_IFDIR
	const srcIsSymlink = (srcStat.mode & S_IFMT) === S_IFLNK

	if (srcIsDir && !recursive) {
		throw new Error(`Source is a directory, use recursive option: ${src}`)
	}

	if (srcIsSymlink) {
		const target = native_readlink(src)
		let destExists = true
		try { native_lstat(dest) } catch { destExists = false }
		if (destExists) {
			if (force) {
				native_unlink(dest)
			} else {
				throw new Error(`Destination already exists: ${dest}`)
			}
		}
		native_symlink(target, dest)
		return
	}

	if (srcIsDir) {
		let destExists = true
		try { native_stat(dest) } catch { destExists = false }
		if (!destExists) {
			native_mkdir(dest, srcStat.mode & 0o777)
		}

		const entries = native_readdir(src)

		for (const entry of entries) {
			cpSync(`${src}/${entry}`, `${dest}/${entry}`, options)
		}
	} else {
		const data = readFileSync(src)
		writeFileSync(dest, data)
		native_chmod(dest, srcStat.mode & 0o777)
	}
}

export function realpathSync(path) {
	return native_realpath(path)
}

export function readlinkSync(path) {
	return native_readlink(path)
}

export function rmSync(path, options = {}) {
	const recursive = options.recursive || false
	const force = options.force || false

	// Use lstat to handle symlinks without following them
	let stat
	try {
		stat = native_lstat(path)
	} catch (e) {
		if (force) return
		throw e
	}

	const isDir = (stat.mode & S_IFMT) === S_IFDIR

	if (isDir && !recursive) {
		try {
			const files = readdirSync(path)
			if (files.length > 0) {
				throw new Error(`Directory not empty: ${path}`)
			}
		} catch (err) {
			if (!force) throw err
			return
		}
	}

	if (isDir && recursive) {
		try {
			const files = readdirSync(path)
			for (const file of files) {
				const fullPath = `${path}/${file}`
				rmSync(fullPath, { recursive: true, force })
			}
		} catch (err) {
			if (!force) throw err
			return
		}
	}

	try {
		if (isDir) {
			native_rmdir(path)
		} else {
			native_unlink(path)
		}
	} catch (e) {
		if (force) {
			// force only suppresses ENOENT
			try { native_lstat(path) } catch { return }
		}
		throw e
	}
}

export function mkdtempSync(prefix) {
	return native_mkdtemp(prefix + 'XXXXXX')
}

export function accessSync(path, mode) {
	if (mode === undefined) mode = constants.F_OK
	native_access(path, mode)
}

export function utimesSync(path, atime, mtime) {
	// uv_fs_utime takes seconds (double), not milliseconds
	const atimeSec = atime instanceof Date ? atime.getTime() / 1000 : (typeof atime === 'number' ? atime : atime)
	const mtimeSec = mtime instanceof Date ? mtime.getTime() / 1000 : (typeof mtime === 'number' ? mtime : mtime)
	native_utimes(path, atimeSec, mtimeSec)
}

export function chownSync(path, uid, gid) {
	native_chown(path, uid, gid)
}

export function lchownSync(path, uid, gid) {
	native_lchown(path, uid, gid)
}

export { createReadStream, createWriteStream } from './streams.js'

export const constants = {
	F_OK: 0,
	R_OK: 4,
	W_OK: 2,
	X_OK: 1,
	COPYFILE_EXCL: 1,
	COPYFILE_FICLONE: 2,
	COPYFILE_FICLONE_FORCE: 4,
	O_RDONLY,
	O_WRONLY,
	O_RDWR,
	O_CREAT,
	O_TRUNC,
	O_APPEND,
	S_IFMT,
	S_IFREG,
	S_IFDIR,
	S_IFLNK,
}

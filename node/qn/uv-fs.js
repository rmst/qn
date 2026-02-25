/*
 * qn:uv-fs - Typed JS wrappers over the single-dispatch C _fsop/_fssync functions.
 *
 * This module is the JS-side API for qn_uv_fs. It provides named functions
 * that call _fsop(opcode, ...args) for async and _fssync(opcode, ...args) for sync.
 * Open flags parsing lives here in JS.
 */

import {
	_fsop, _fssync,
	OPEN, CLOSE, READ, WRITE, FSTAT, FTRUNCATE, FSYNC, FDATASYNC,
	FCHMOD, FCHOWN, FUTIME, STAT, LSTAT, READDIR, MKDIR, UNLINK, RMDIR,
	RENAME, SYMLINK, LINK, READLINK, REALPATH, ACCESS, CHMOD, UTIMES,
	CHOWN, LCHOWN, COPYFILE, MKDTEMP,
	O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL,
	S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFBLK, S_IFCHR, S_IFIFO, S_IFSOCK,
	EAGAIN as UV_EAGAIN,
	setNonBlock, getpgid,
} from 'qn_uv_fs'

/* Open flags parser (moved from C — uses platform constants) */
function parseOpenFlags(str) {
	if (typeof str === 'number') return str
	let flags = 0, rd = 0, wr = 0
	for (let i = 0; i < str.length; i++) {
		switch (str[i]) {
			case 'r': rd = 1; break
			case 'w': wr = 1; flags |= O_CREAT | O_TRUNC; break
			case 'a': wr = 1; flags |= O_CREAT | O_APPEND; break
			case '+': rd = 1; wr = 1; break
			case 'x': flags |= O_EXCL; break
		}
	}
	flags |= rd ? (wr ? O_RDWR : O_RDONLY) : (wr ? O_WRONLY : 0)
	return flags
}

/* ---- Async (promise-returning) ---- */

/* fd primitives */
export const open      = (path, flags, mode) => _fsop(OPEN, parseOpenFlags(flags), mode ?? 0o666, path)
export const close     = (fd) => _fsop(CLOSE, fd)
export const read      = (fd, buf, pos) => _fsop(READ, fd, buf, pos)
export const write     = (fd, buf, pos) => _fsop(WRITE, fd, buf, pos)
export const fstat     = (fd) => _fsop(FSTAT, fd)
export const ftruncate = (fd, len) => _fsop(FTRUNCATE, fd, len)
export const fsync     = (fd) => _fsop(FSYNC, fd)
export const fdatasync = (fd) => _fsop(FDATASYNC, fd)
export const fchmod    = (fd, mode) => _fsop(FCHMOD, fd, mode)
export const fchown    = (fd, uid, gid) => _fsop(FCHOWN, fd, uid, gid)
export const futime    = (fd, atime, mtime) => _fsop(FUTIME, fd, atime, mtime)

/* path operations */
export const stat      = (path) => _fsop(STAT, path)
export const lstat     = (path) => _fsop(LSTAT, path)
export const readdir   = (path) => _fsop(READDIR, path)
export const mkdir     = (path, mode) => _fsop(MKDIR, path, mode)
export const unlink    = (path) => _fsop(UNLINK, path)
export const rmdir     = (path) => _fsop(RMDIR, path)
export const rename    = (oldPath, newPath) => _fsop(RENAME, oldPath, newPath)
export const symlink   = (target, path) => _fsop(SYMLINK, target, path)
export const link      = (path, newPath) => _fsop(LINK, path, newPath)
export const readlink  = (path) => _fsop(READLINK, path)
export const realpath  = (path) => _fsop(REALPATH, path)
export const access    = (path, mode) => _fsop(ACCESS, path, mode)
export const chmod     = (path, mode) => _fsop(CHMOD, path, mode)
export const utimes    = (path, atime, mtime) => _fsop(UTIMES, path, atime, mtime)
export const chown     = (path, uid, gid) => _fsop(CHOWN, path, uid, gid)
export const lchown    = (path, uid, gid) => _fsop(LCHOWN, path, uid, gid)
export const copyfile  = (src, dst, flags) => _fsop(COPYFILE, src, dst, flags)
export const mkdtemp   = (template) => _fsop(MKDTEMP, template)

/* ---- Synchronous ---- */

export const openSync      = (path, flags, mode) => _fssync(OPEN, parseOpenFlags(flags), mode ?? 0o666, path)
export const closeSync     = (fd) => _fssync(CLOSE, fd)
export const readSync      = (fd, buf, pos) => _fssync(READ, fd, buf, pos)
export const writeSync     = (fd, buf, pos) => _fssync(WRITE, fd, buf, pos)
export const statSync      = (path) => _fssync(STAT, path)
export const lstatSync     = (path) => _fssync(LSTAT, path)
export const fstatSync     = (fd) => _fssync(FSTAT, fd)
export const readdirSync   = (path) => _fssync(READDIR, path)
export const mkdirSync     = (path, mode) => _fssync(MKDIR, path, mode)
export const unlinkSync    = (path) => _fssync(UNLINK, path)
export const rmdirSync     = (path) => _fssync(RMDIR, path)
export const renameSync    = (oldPath, newPath) => _fssync(RENAME, oldPath, newPath)
export const symlinkSync   = (target, path) => _fssync(SYMLINK, target, path)
export const linkSync      = (path, newPath) => _fssync(LINK, path, newPath)
export const readlinkSync  = (path) => _fssync(READLINK, path)
export const realpathSync  = (path) => _fssync(REALPATH, path)
export const accessSync    = (path, mode) => _fssync(ACCESS, path, mode)
export const chmodSync     = (path, mode) => _fssync(CHMOD, path, mode)
export const utimesSync    = (path, atime, mtime) => _fssync(UTIMES, path, atime, mtime)
export const chownSync     = (path, uid, gid) => _fssync(CHOWN, path, uid, gid)
export const lchownSync    = (path, uid, gid) => _fssync(LCHOWN, path, uid, gid)
export const copyfileSync  = (src, dst, flags) => _fssync(COPYFILE, src, dst, flags)
export const mkdtempSync   = (template) => _fssync(MKDTEMP, template)
export const ftruncateSync = (fd, len) => _fssync(FTRUNCATE, fd, len)
export const fchmodSync    = (fd, mode) => _fssync(FCHMOD, fd, mode)
export const fchownSync    = (fd, uid, gid) => _fssync(FCHOWN, fd, uid, gid)
export const futimeSync    = (fd, atime, mtime) => _fssync(FUTIME, fd, atime, mtime)
export const fsyncSync     = (fd) => _fssync(FSYNC, fd)
export const fdatasyncSync = (fd) => _fssync(FDATASYNC, fd)

/* Re-export constants and utilities */
export { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL }
export { S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFBLK, S_IFCHR, S_IFIFO, S_IFSOCK }
export { setNonBlock, getpgid, parseOpenFlags }
export { UV_EAGAIN }

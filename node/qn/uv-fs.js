/*
 * qn:uv-fs - Typed JS wrappers over the single-dispatch C _fsop function.
 *
 * This module is the JS-side API for qn_uv_fs. It provides named functions
 * that call _fsop(opcode, ...args). Open flags parsing lives here in JS.
 */

import {
	_fsop, _fssync,
	OPEN, CLOSE, READ, WRITE, FSTAT, FTRUNCATE, FSYNC, FDATASYNC,
	FCHMOD, FCHOWN, FUTIME, STAT, LSTAT, READDIR, MKDIR, UNLINK, RMDIR,
	RENAME, SYMLINK, LINK, READLINK, REALPATH, ACCESS, CHMOD, UTIMES,
	CHOWN, LCHOWN, COPYFILE, MKDTEMP,
	O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL,
	setNonBlock, getpgid,
} from 'qn_uv_fs'

/* Open flags parser (moved from C — uses platform constants) */
function parseOpenFlags(str) {
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
export const copyfile  = (src, dst) => _fsop(COPYFILE, src, dst)
export const mkdtemp   = (template) => _fsop(MKDTEMP, template)

/* Synchronous variants for chmodSync/chownSync/lchownSync */
export const chmodSync  = (path, mode) => _fssync(CHMOD, path, mode)
export const chownSync  = (path, uid, gid) => _fssync(CHOWN, path, uid, gid)
export const lchownSync = (path, uid, gid) => _fssync(LCHOWN, path, uid, gid)

/* Re-export utilities */
export { setNonBlock, getpgid }

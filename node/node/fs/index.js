import * as std from 'std';
import * as os from 'os';
import { Buffer } from 'node:buffer';
import { chmod as native_chmod, chown as native_chown, lchown as native_lchown } from 'qn_native';

// Re-export glob functions from separate module
export { globSync, glob } from './glob.js';

const ERRNO_CODES = { 1: 'EPERM', 2: 'ENOENT', 13: 'EACCES', 17: 'EEXIST', 20: 'ENOTDIR', 21: 'EISDIR', 28: 'ENOSPC' }

function throwFileError(path, syscall) {
	const [, errno] = os.stat(path)
	const code = ERRNO_CODES[errno] || 'EIO'
	const err = new Error(`${code}: ${syscall} '${path}'`)
	err.code = code
	err.path = path
	err.syscall = syscall
	throw err
}


/**
 * Dirent class for directory entries (used by readdirSync with withFileTypes)
 */
export class Dirent {
	constructor(name, parentPath, mode) {
		this.name = name;
		this.parentPath = parentPath;
		this.path = parentPath; // Alias for compatibility
		this._mode = mode;
	}

	isDirectory() {
		return (this._mode & os.S_IFMT) === os.S_IFDIR;
	}

	isFile() {
		return (this._mode & os.S_IFMT) === os.S_IFREG;
	}

	isSymbolicLink() {
		return (this._mode & os.S_IFMT) === os.S_IFLNK;
	}

	isBlockDevice() {
		return (this._mode & os.S_IFMT) === os.S_IFBLK;
	}

	isCharacterDevice() {
		return (this._mode & os.S_IFMT) === os.S_IFCHR;
	}

	isFIFO() {
		return (this._mode & os.S_IFMT) === os.S_IFIFO;
	}

	isSocket() {
		return (this._mode & os.S_IFMT) === os.S_IFSOCK;
	}
}


export const writeFileSync = (path, data, options) => {
  options = typeof options === 'string' ? { encoding: options } : (options || {});

  const flag = options.flag || 'w';

  if (options.encoding != null && options.encoding !== 'utf8' && options.encoding !== 'utf-8') {
    throw new Error(`Unsupported encoding: ${options.encoding}. Only utf8 is supported.`);
  }

  const isBinary = data instanceof ArrayBuffer || ArrayBuffer.isView(data);

  const file = std.open(path, flag + (isBinary ? 'b' : ''));
  if (!file) throwFileError(path, 'open')
  try {
    if (isBinary) {
      const buffer = data instanceof ArrayBuffer ? data : data.buffer;
      const offset = ArrayBuffer.isView(data) ? data.byteOffset : 0;
      const length = ArrayBuffer.isView(data) ? data.byteLength : data.byteLength;
      file.write(buffer, offset, length);
    } else if (typeof data === 'string') {
      file.puts(data);
    } else {
      throw new TypeError('Data must be a string, ArrayBuffer, or TypedArray.');
    }
  } finally {
    file.close();
  }
}


export const appendFileSync = (path, data, options) => {
  options = typeof options === 'string' ? { encoding: options } : (options || {});

  if (options.encoding != null && options.encoding !== 'utf8' && options.encoding !== 'utf-8') {
    throw new Error(`Unsupported encoding: ${options.encoding}. Only utf8 is supported.`);
  }

  const isBinary = data instanceof ArrayBuffer || ArrayBuffer.isView(data);

  const file = std.open(path, 'a' + (isBinary ? 'b' : ''));
  if (!file) throwFileError(path, 'open')
  try {
    if (isBinary) {
      const buffer = data instanceof ArrayBuffer ? data : data.buffer;
      const offset = ArrayBuffer.isView(data) ? data.byteOffset : 0;
      const length = ArrayBuffer.isView(data) ? data.byteLength : data.byteLength;
      file.write(buffer, offset, length);
    } else if (typeof data === 'string') {
      file.puts(data);
    } else {
      throw new TypeError('Data must be a string, ArrayBuffer, or TypedArray.');
    }
  } finally {
    file.close();
  }
}


export const readFileSync = (path, options) => {
  options = typeof options === 'string' ? { encoding: options } : (options || {});

  const encoding = options.encoding;
  const flag = options.flag || 'r';

  if (encoding != null && encoding !== 'utf8' && encoding !== 'utf-8') {
    throw new Error(`Unsupported encoding: ${encoding}. Only utf8 is supported.`);
  }

  const file = std.open(path, flag + 'b');
  if (!file) {
    throwFileError(path, 'open')
  }

  try {
    if (encoding == null) {
      file.seek(0, std.SEEK_END);
      const size = file.tell();
      file.seek(0, std.SEEK_SET);
      const buffer = new ArrayBuffer(size);
      file.read(buffer, 0, size);
      return Buffer.from(buffer);
    } else {
      return file.readAsString();
    }
  } finally {
    file.close();
  }
}

export const readdirSync = (path, options = {}) => {
  const withFileTypes = options?.withFileTypes || false;

  const [files, error] = os.readdir(path);
  if (error !== 0) {
    throw new Error(`Failed to read directory: ${path}`);
  }

  const filtered = files.filter(name => name !== '.' && name !== '..');

  if (!withFileTypes) {
    return filtered;
  }

  return filtered.map(name => {
    const fullPath = path.endsWith('/') ? `${path}${name}` : `${path}/${name}`;
    const [statResult, statErr] = os.lstat(fullPath);
    if (statErr !== 0) {
      throw new Error(`Failed to stat: ${fullPath}`);
    }
    return new Dirent(name, path, statResult.mode);
  });
}

export const mkdirSync = (path, { mode = 0o777, recursive = false } = {}) => {

  if (!recursive) {
    const result = os.mkdir(path, mode);
    if (result !== 0) {
      throw new Error(`Failed to create directory: ${path}`);
    }
    return;
  }

  const parts = path.split('/').filter(p => p.length > 0);
  let currentPath = path.startsWith('/') ? '/' : '';

  for (const part of parts) {
    currentPath = currentPath === '/' ? `/${part}` : `${currentPath}/${part}`;

    const [statResult, err] = os.stat(currentPath);
    if (err === 0) {
      if ((statResult.mode & os.S_IFMT) !== os.S_IFDIR) {
        throw new Error(`Path exists but is not a directory: ${currentPath}`);
      }
      continue;
    }

    const result = os.mkdir(currentPath, mode);
    if (result !== 0) {
      // Re-check: another process may have created it concurrently (EEXIST race)
      const [recheckStat, recheckErr] = os.stat(currentPath);
      if (recheckErr !== 0 || (recheckStat.mode & os.S_IFMT) !== os.S_IFDIR) {
        throw new Error(`Failed to create directory: ${currentPath}`);
      }
    }
  }
}



// Helper function to create a Stats object from stat or lstat results
function createStatsObject(statResult) {
  const { dev, ino, mode, nlink, uid, gid, rdev, size, atime, mtime, ctime } = statResult;
  return {
    dev,
    ino,
    mode,
    nlink,
    uid,
    gid,
    rdev,
    size,
    // Assuming blocks and blksize are not directly available, omit or set to undefined
    blocks: undefined,
    blksize: undefined,
    atimeMs: atime,
    mtimeMs: mtime,
    ctimeMs: ctime,
    // birthtime is not provided by QuickJS os.stat, so we'll use ctime as a fallback
    birthtimeMs: ctime,
    atime: new Date(atime),
    mtime: new Date(mtime),
    ctime: new Date(ctime),
    birthtime: new Date(ctime),
    isDirectory: function() { return (this.mode & os.S_IFMT) === os.S_IFDIR; },
    isFile: function() { return (this.mode & os.S_IFMT) === os.S_IFREG; },
    isBlockDevice: function() { return (this.mode & os.S_IFMT) === os.S_IFBLK; },
    isCharacterDevice: function() { return (this.mode & os.S_IFMT) === os.S_IFCHR; },
    isSymbolicLink: function() { return (this.mode & os.S_IFMT) === os.S_IFLNK; },
    isFIFO: function() { return (this.mode & os.S_IFMT) === os.S_IFIFO; },
    isSocket: function() { return (this.mode & os.S_IFMT) === os.S_IFSOCK; },
  };
}

export const statSync = (path) => {
  const [statResult, err] = os.stat(path);
  if (err !== 0) {
    throw new Error(`Failed to stat file: ${path}`);
  }
  return createStatsObject(statResult);
}

export const lstatSync = (path) => {
  const [statResult, err] = os.lstat(path);
  if (err !== 0) {
    throw new Error(`Failed to lstat file: ${path}`);
  }
  return createStatsObject(statResult);
}


export function existsSync(path) {
	const [_, err] = os.stat(path);
	return err === 0;
}

export function openSync(path, flags) {
	const osFlags = flags === 'r' ? os.O_RDONLY : os.O_WRONLY | os.O_CREAT | os.O_TRUNC;
	const fd = os.open(path, osFlags);
	if (fd < 0) {
		throw new Error(`Failed to open file: ${path}`);
	}
	return fd;
}

export function closeSync(fd) {
	const result = os.close(fd);
	if (result < 0) {
		throw new Error(`Failed to close file descriptor: ${fd}`);
	}
}

export function unlinkSync(path) {
	const result = os.remove(path);
	if (result !== 0) {
		throw new Error(`Failed to unlink file: ${path}`);
	}
}

export function linkSync(existingPath, newPath) {
	throw new Error('Hard links are not supported');
}

export function symlinkSync(target, path) {
	const result = os.symlink(target, path);
	if (result !== 0) {
		throw new Error(`Failed to create symlink from ${target} to ${path}`);
	}
}

export function renameSync(oldPath, newPath) {
	const result = os.rename(oldPath, newPath);
	if (result !== 0) {
		throw new Error(`Failed to rename ${oldPath} to ${newPath}`);
	}
}

export function chmodSync(path, mode) {
	const result = native_chmod(path, mode);
	if (result !== 0) {
		throw new Error(`Failed to chmod ${path}: error ${-result}`);
	}
}

export function copyFileSync(src, dest, mode) {
	if (mode !== undefined) {
		throw new Error('copyFileSync mode argument is not supported');
	}
	const data = readFileSync(src);
	writeFileSync(dest, data);
}

export function cpSync(src, dest, options = {}) {
	const { recursive = false, force = false } = options;

	const [srcStat, srcErr] = os.lstat(src);
	if (srcErr !== 0) {
		throw new Error(`Failed to stat source: ${src}`);
	}

	const srcIsDir = (srcStat.mode & os.S_IFMT) === os.S_IFDIR;
	const srcIsSymlink = (srcStat.mode & os.S_IFMT) === os.S_IFLNK;

	if (srcIsDir && !recursive) {
		throw new Error(`Source is a directory, use recursive option: ${src}`);
	}

	if (srcIsSymlink) {
		const [target, err] = os.readlink(src);
		if (err !== 0) {
			throw new Error(`Failed to read symlink: ${src}`);
		}
		const [, destErr] = os.lstat(dest);
		if (destErr === 0) {
			if (force) {
				os.remove(dest);
			} else {
				throw new Error(`Destination already exists: ${dest}`);
			}
		}
		const result = os.symlink(target, dest);
		if (result !== 0) {
			throw new Error(`Failed to create symlink: ${dest}`);
		}
		return;
	}

	if (srcIsDir) {
		const [, destErr] = os.stat(dest);
		if (destErr !== 0) {
			const mkResult = os.mkdir(dest, srcStat.mode & 0o777);
			if (mkResult !== 0) {
				throw new Error(`Failed to create directory: ${dest}`);
			}
		}

		const [entries, readErr] = os.readdir(src);
		if (readErr !== 0) {
			throw new Error(`Failed to read directory: ${src}`);
		}

		for (const entry of entries) {
			if (entry === '.' || entry === '..') continue;
			cpSync(`${src}/${entry}`, `${dest}/${entry}`, options);
		}
	} else {
		const data = readFileSync(src);
		writeFileSync(dest, data);
		native_chmod(dest, srcStat.mode & 0o777);
	}
}

export function realpathSync(path) {
	const [resolved, err] = os.realpath(path);
	if (err !== 0) {
		throw new Error(`Failed to resolve path: ${path}`);
	}
	return resolved;
}

export function readlinkSync(path) {
	const [target, err] = os.readlink(path);
	if (err !== 0) {
		throw new Error(`Failed to read symlink: ${path}`);
	}
	return target;
}

export function rmSync(path, options = {}) {
	const recursive = options.recursive || false;
	const force = options.force || false;

	// Use lstat to handle symlinks without following them
	const [stat, statErr] = os.lstat(path);

	if (statErr !== 0) {
		if (force) {
			return;
		}
		throw new Error(`Failed to stat path: ${path}`);
	}

	const isDir = (stat.mode & os.S_IFMT) === os.S_IFDIR;

	if (isDir && !recursive) {
		try {
			const files = readdirSync(path);
			if (files.length > 0) {
				throw new Error(`Directory not empty: ${path}`);
			}
		} catch (err) {
			if (!force) throw err;
			return;
		}
	}

	if (isDir && recursive) {
		try {
			const files = readdirSync(path);
			for (const file of files) {
				const fullPath = `${path}/${file}`;
				rmSync(fullPath, { recursive: true, force });
			}
		} catch (err) {
			if (!force) throw err;
			return;
		}
	}

	const result = os.remove(path);
	if (result !== 0) {
		if (force) {
			// force only suppresses ENOENT - check if file still exists
			const [, checkErr] = os.lstat(path);
			if (checkErr !== 0) {
				// File doesn't exist anymore, so removal "succeeded"
				return;
			}
		}
		throw new Error(`Failed to remove: ${path}`);
	}
}

export function mkdtempSync(prefix) {
	const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
	for (let attempt = 0; attempt < 3; attempt++) {
		let suffix = ''
		for (let i = 0; i < 6; i++) {
			suffix += chars[Math.floor(Math.random() * chars.length)]
		}
		const path = prefix + suffix
		const result = os.mkdir(path, 0o700)
		if (result === 0) return path
	}
	// Final attempt with PID to guarantee uniqueness across parallel processes
	let suffix = ''
	for (let i = 0; i < 6; i++) {
		suffix += chars[Math.floor(Math.random() * chars.length)]
	}
	const path = prefix + os.getpid() + '_' + suffix
	const result = os.mkdir(path, 0o700)
	if (result !== 0) {
		throw new Error(`Failed to create temp directory: ${path}`)
	}
	return path
}

export function accessSync(path, mode) {
	if (mode === undefined) mode = constants.F_OK;
	if (mode !== constants.F_OK) {
		throw new Error('accessSync: only F_OK mode is supported (use existsSync for existence checks)')
	}
	const [, err] = os.stat(path);
	if (err !== 0) {
		const error = new Error(`ENOENT: no such file or directory, access '${path}'`);
		error.code = 'ENOENT';
		throw error;
	}
}

export function utimesSync(path, atime, mtime) {
	// Convert Date objects or seconds to milliseconds for os.utimes
	const atimeMs = atime instanceof Date ? atime.getTime() : (typeof atime === 'number' ? atime * 1000 : atime);
	const mtimeMs = mtime instanceof Date ? mtime.getTime() : (typeof mtime === 'number' ? mtime * 1000 : mtime);
	const result = os.utimes(path, atimeMs, mtimeMs);
	if (result < 0) {
		throw new Error(`Failed to set timestamps on ${path}: error ${-result}`);
	}
}

export function chownSync(path, uid, gid) {
	const result = native_chown(path, uid, gid);
	if (result !== 0) {
		throw new Error(`Failed to chown ${path}: error ${-result}`);
	}
}

export function lchownSync(path, uid, gid) {
	const result = native_lchown(path, uid, gid);
	if (result !== 0) {
		throw new Error(`Failed to lchown ${path}: error ${-result}`);
	}
}

export { createReadStream, createWriteStream } from './streams.js';

export const constants = {
	F_OK: 0,
	R_OK: 4,
	W_OK: 2,
	X_OK: 1,
	COPYFILE_EXCL: 1,
	COPYFILE_FICLONE: 2,
	COPYFILE_FICLONE_FORCE: 4,
	O_RDONLY: os.O_RDONLY,
	O_WRONLY: os.O_WRONLY,
	O_RDWR: os.O_RDWR,
	O_CREAT: os.O_CREAT,
	O_TRUNC: os.O_TRUNC,
	O_APPEND: os.O_APPEND,
	S_IFMT: os.S_IFMT,
	S_IFREG: os.S_IFREG,
	S_IFDIR: os.S_IFDIR,
	S_IFLNK: os.S_IFLNK,
}
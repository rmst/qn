import * as std from 'std';
import * as os from 'os';
import { Buffer } from 'node:buffer';
import picomatch from './glob/index.js';


export const writeFileSync = (path, data, options) => {
  options = typeof options === 'string' ? { encoding: options } : (options || {});

  const flag = options.flag || 'w';

  if (options.encoding != null && options.encoding !== 'utf8' && options.encoding !== 'utf-8') {
    throw new Error(`Unsupported encoding: ${options.encoding}. Only utf8 is supported.`);
  }

  const isBinary = data instanceof ArrayBuffer || ArrayBuffer.isView(data);

  const file = std.open(path, flag + (isBinary ? 'b' : ''));
  if (!file) {
    throw new Error(`Failed to open file: ${path}`);
  }
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
    throw new Error(`Failed to open file: ${path}`);
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

export const readdirSync = (path) => {
  const [files, error] = os.readdir(path);
  if (error !== 0) {
    throw new Error(`Failed to read directory: ${path}`);
  }
  return files.filter(name => name !== '.' && name !== '..')
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
	const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let suffix = '';
	for (let i = 0; i < 6; i++) {
		suffix += chars[Math.floor(Math.random() * chars.length)];
	}
	const path = prefix + suffix;
	const result = os.mkdir(path, 0o700);
	if (result !== 0) {
		throw new Error(`Failed to create temp directory: ${path}`);
	}
	return path;
}


/**
 * Recursively match files against glob patterns.
 * @param {string|string[]} pattern - Glob pattern(s) to match
 * @param {Object} [options] - Options
 * @param {string} [options.cwd] - Current working directory (default: process.cwd())
 * @param {Function} [options.exclude] - Function to exclude paths, receives path as dirent-like object
 * @param {boolean} [options.withFileTypes] - Return Dirent objects instead of strings
 * @returns {string[]|Dirent[]} Array of matching paths
 */
export function globSync(pattern, options = {}) {
	const cwd = options.cwd || (typeof process !== 'undefined' ? process.cwd() : os.getcwd()[0]);
	const exclude = options.exclude;
	const withFileTypes = options.withFileTypes || false;

	// Normalize patterns to array
	const patterns = Array.isArray(pattern) ? pattern : [pattern];

	// Separate negation patterns from positive patterns
	const positivePatterns = [];
	const negativePatterns = [];

	for (const p of patterns) {
		if (p.startsWith('!') && !p.startsWith('!(')) {
			negativePatterns.push(p.slice(1));
		} else {
			positivePatterns.push(p);
		}
	}

	// Create matchers
	const positiveMatcher = positivePatterns.length > 0
		? picomatch(positivePatterns, { dot: options.dot })
		: () => false;
	const negativeMatcher = negativePatterns.length > 0
		? picomatch(negativePatterns, { dot: options.dot })
		: () => false;

	const results = [];
	const seen = new Set();

	// Analyze patterns to find the base directory to start searching from
	function getBaseDir(pattern) {
		const scanned = picomatch.scan(pattern);
		return scanned.base || '.';
	}

	// Get unique base directories to search
	const baseDirs = new Set();
	for (const p of positivePatterns) {
		baseDirs.add(getBaseDir(p));
	}

	// Check if pattern needs recursive search
	function needsRecursive(pattern) {
		return pattern.includes('**') || pattern.includes('/');
	}

	const recursive = positivePatterns.some(needsRecursive);

	// Walk directory and collect matches
	function walk(dir, relativePath = '') {
		let entries;
		try {
			entries = readdirSync(dir);
		} catch (e) {
			return; // Skip directories we can't read
		}

		for (const name of entries) {
			const fullPath = dir === '.' ? name : `${dir}/${name}`;
			const relPath = relativePath ? `${relativePath}/${name}` : name;

			let stat;
			try {
				stat = lstatSync(fullPath);
			} catch (e) {
				continue; // Skip entries we can't stat
			}

			const isDir = stat.isDirectory();

			// Create dirent-like object for exclude function
			const dirent = {
				name,
				path: fullPath,
				parentPath: dir,
				isDirectory: () => isDir,
				isFile: () => stat.isFile(),
				isSymbolicLink: () => stat.isSymbolicLink(),
			};

			// Check exclude function
			if (exclude && exclude(dirent)) {
				continue;
			}

			// Test against patterns
			if (positiveMatcher(relPath) && !negativeMatcher(relPath)) {
				if (!seen.has(relPath)) {
					seen.add(relPath);
					if (withFileTypes) {
						results.push(dirent);
					} else {
						results.push(relPath);
					}
				}
			}

			// Recurse into directories
			if (isDir && recursive) {
				walk(fullPath, relPath);
			}
		}
	}

	// Start walking from each base directory
	const originalCwd = os.getcwd()[0];
	try {
		os.chdir(cwd);

		for (const baseDir of baseDirs) {
			const startDir = baseDir === '' ? '.' : baseDir;
			// Check if base directory exists before walking
			const [, err] = os.stat(startDir);
			if (err === 0) {
				if (baseDir && baseDir !== '.') {
					// Start walking from base, but include base in relative path
					walk(startDir, baseDir);
				} else {
					walk(startDir, '');
				}
			}
		}
	} finally {
		os.chdir(originalCwd);
	}

	return results;
}


/**
 * Async glob - returns an async iterable.
 * Since QuickJS doesn't have true async I/O, this is a thin wrapper over globSync.
 * @param {string|string[]} pattern - Glob pattern(s) to match
 * @param {Object} [options] - Options
 * @returns {AsyncIterable<string|Dirent>}
 */
export async function* glob(pattern, options = {}) {
	const results = globSync(pattern, options);
	for (const result of results) {
		yield result;
	}
}
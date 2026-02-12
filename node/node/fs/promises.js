/*
 * node:fs/promises - Async wrappers around sync fs functions
 *
 * Since QuickJS uses a synchronous I/O model, these functions
 * wrap the sync implementations in resolved Promises.
 */

import {
	readFileSync,
	writeFileSync,
	realpathSync,
	statSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	cpSync,
	symlinkSync,
	readlinkSync,
	accessSync,
	chmodSync,
	utimesSync,
	chownSync,
	lchownSync,
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

export const readFile = wrapSync(readFileSync)
export const writeFile = wrapSync(writeFileSync)
export const realpath = wrapSync(realpathSync)
export const stat = wrapSync(statSync)
export const lstat = wrapSync(lstatSync)
export const mkdir = wrapSync(mkdirSync)
export const readdir = wrapSync(readdirSync)
export const rename = wrapSync(renameSync)
export const rm = wrapSync(rmSync)
export const cp = wrapSync(cpSync)
export const symlink = wrapSync(symlinkSync)
export const readlink = wrapSync(readlinkSync)
export const access = wrapSync(accessSync)
export const chmod = wrapSync(chmodSync)
export const utimes = wrapSync(utimesSync)
export const chown = wrapSync(chownSync)
export const lchown = wrapSync(lchownSync)

export { constants }

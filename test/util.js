import { test as nodetest } from 'node:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), '/')))

/**
 * @overload
 * @param {TemplateStringsArray} strings
 * @param {...any} values
 * @returns {string}
 */
/**
 * @overload
 * @param {import('child_process').ExecSyncOptions} opts
 * @returns {(strings: TemplateStringsArray, ...values: any[]) => string}
 */
/**
 * @param {TemplateStringsArray | import('child_process').ExecSyncOptions} strings
 * @param {...any} values
 */
export const $ = (strings, ...values) => {
	if (typeof strings === 'string' || /** @type {TemplateStringsArray} */ (strings).raw === undefined) {
		const opts = /** @type {import('child_process').ExecSyncOptions} */ (strings)
		return (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => {
			const cmd = String.raw({ raw: strings }, ...values)
			return execSync(cmd, { encoding: 'utf8', ...opts })
		}
	}
	const cmd = String.raw({ raw: strings }, ...values)
	return execSync(cmd, { encoding: 'utf8' })
}

/**
 * Run a test with a fresh temporary directory.
 * @param {string} name - Test name
 * @param {(ctx: { dir: string }) => void} fn - Test function receiving { dir }
 */
export const test = (name, fn) => {
	nodetest(name, () => {
		const dir = mktempdir()
		try {
			return fn({ dir })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
}

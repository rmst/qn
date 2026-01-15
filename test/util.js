import { test as nodetest } from 'node:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir, platform } from 'node:os'

export const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), '/')))



const QNODE = resolve(`./bin/${platform()}/qnode`)

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
	// NO_COLOR disables ANSI color codes in Node.js console output
	const { FORCE_COLOR, ...env } = process.env
	const defaultOpts = { encoding: 'utf8', env: { ...env, NO_COLOR: '1' } }
	if (typeof strings === 'string' || /** @type {TemplateStringsArray} */ (strings).raw === undefined) {
		const opts = /** @type {import('child_process').ExecSyncOptions} */ (strings)
		return (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => {
			const cmd = String.raw({ raw: strings }, ...values)
			return execSync(cmd, { ...defaultOpts, ...opts }).trim()
		}
	}
	const cmd = String.raw({ raw: strings }, ...values)
	return execSync(cmd, defaultOpts).trim()
}

/**
 * Run a test twice: once with Node.js, once with qnode.
 * Both runs must produce identical output.
 * @param {string} name - Test name
 * @param {(ctx: { bin: string, dir: string }) => void} fn - Test function receiving { bin, dir }
 */
export const test = (name, fn) => {
	for (const bin of ['node', QNODE]) {
		const label = bin === 'node' ? 'node' : 'qnode'
		const testFn = () => {
			const dir = mktempdir()
			try {
				return fn({ bin, dir })
			} catch (err) {
				// relative paths preferred
				if (err.stack) {
					const cwd = process.cwd()
					err.stack = err.stack.replaceAll(`file://${cwd}`, '.')
				}
				throw err

			} finally {
				rmSync(dir, { recursive: true })
			}
		}
		nodetest(`${name} [${label}]`, testFn)
	}
}

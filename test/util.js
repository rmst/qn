import { test as nodetest } from 'node:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir, platform } from 'node:os'

export const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), '/')))

const QJSX_NODE = resolve(`./bin/${platform()}/qjsx-node`)

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
			return execSync(cmd, { encoding: 'utf8', ...opts }).trim()
		}
	}
	const cmd = String.raw({ raw: strings }, ...values)
	return execSync(cmd, { encoding: 'utf8' }).trim()
}

/**
 * Run a test twice: once with Node.js, once with qjsx-node.
 * Both runs must produce identical output.
 * @param {string} name - Test name
 * @param {(ctx: { bin: string, dir: string }) => void} fn - Test function receiving { bin, dir }
 */
export const test = (name, fn) => {
	for (const bin of ['node', QJSX_NODE]) {
		const label = bin === 'node' ? 'node' : 'qjsx-node'
		nodetest(`${name} [${label}]`, () => {
			const dir = mktempdir()
			try {
				return fn({ bin, dir })
			} finally {
				rmSync(dir, { recursive: true })
			}
		})
	}
}

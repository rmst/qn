import { test as nodetest } from 'node:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execSync, spawn } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { tmpdir, platform } from 'node:os'

export const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), '/')))

const ROOT = resolve(dirname(import.meta.filename), '..')
const BIN = join(ROOT, 'bin', platform())

export const QJSX = () => join(BIN, 'qjsx')
export const QN = () => join(BIN, 'qn')
export const QJSXC = () => join(BIN, 'qjsxc')
export const QX = () => join(BIN, 'qx')

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
	const { FORCE_COLOR, NODE_OPTIONS, ...env } = process.env
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
 * Async command execution using spawn (works when execSync hangs due to event loop issues)
 * @param {string} cmd - Command to run
 * @param {string[]} args - Arguments
 * @param {object} [opts] - Options
 * @returns {Promise<string>} - stdout trimmed
 */
export const execAsync = (cmd, args, opts = {}) => {
	return new Promise((resolve, reject) => {
		const { FORCE_COLOR, NODE_OPTIONS, ...env } = process.env
		const child = spawn(cmd, args, {
			env: { ...env, NO_COLOR: '1', ...opts.env },
			cwd: opts.cwd,
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', d => stdout += d)
		child.stderr.on('data', d => stderr += d)
		child.on('error', reject)
		child.on('close', code => {
			if (code !== 0) {
				const err = new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`)
				err.code = code
				err.stderr = stderr
				reject(err)
			} else {
				resolve(stdout.trim())
			}
		})
	})
}

/**
 * Run a test twice: once with Node.js, once with qn.
 * Both runs must produce identical output.
 * @param {string} name - Test name
 * @param {(ctx: { bin: string, dir: string }) => void} fn - Test function receiving { bin, dir }
 */
export const test = (name, fn) => {
	const bins = process.env.NO_NODEJS_TESTS ? [QN()] : ['node', QN()]
	for (const bin of bins) {
		const label = bin === 'node' ? 'node' : 'qn'
		const testFn = async () => {
			const dir = mktempdir()
			// Write package.json to enable ESM for .js files
			writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
			try {
				return await fn({ bin, dir })
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

/**
 * Run a test only with qn (not Node.js).
 * Use this for testing qn-specific behavior that differs from Node.js.
 * @param {string} name - Test name
 * @param {(ctx: { bin: string, dir: string }) => void} fn - Test function receiving { bin, dir }
 */
export const testQnOnly = (name, fn) => {
	const testFn = async () => {
		const dir = mktempdir()
		try {
			return await fn({ bin: QN(), dir })
		} catch (err) {
			if (err.stack) {
				const cwd = process.cwd()
				err.stack = err.stack.replaceAll(`file://${cwd}`, '.')
			}
			throw err
		} finally {
			rmSync(dir, { recursive: true })
		}
	}
	nodetest(`${name} [qn]`, testFn)
}

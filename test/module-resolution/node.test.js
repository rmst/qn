import { describe, test as nodetest } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir, platform } from 'node:os'
import { mkdtempSync, realpathSync } from 'node:fs'

const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), 'module-res-node-test-')))
const QJSX = resolve(`./bin/${platform()}/qjsx`)

const $ = (strings, ...values) => {
	const cmd = String.raw({ raw: strings }, ...values)
	return execSync(cmd, { encoding: 'utf8', timeout: 30000 }).trim()
}

/**
 * Run a test twice: once with Node.js, once with qjsx in node mode.
 * Both runs must produce identical output.
 */
const test = (name, fn) => {
	for (const runtime of ['node', 'qjsx']) {
		const bin = runtime === 'node' ? 'node' : QJSX
		const env = runtime === 'qjsx' ? 'QJSX_MODULE_RESOLUTION=node' : ''
		nodetest(`${name} [${runtime}]`, () => {
			const dir = mktempdir()
			try {
				fn({ bin, env, dir })
			} finally {
				rmSync(dir, { recursive: true })
			}
		})
	}
}

describe('Node Mode (matches Node.js ESM)', () => {
	test('explicit .js extension works', ({ bin, env, dir }) => {
		writeFileSync(`${dir}/utils.js`, `export const add = (a,b) => a+b;`)
		writeFileSync(`${dir}/main.js`, `
			import { add } from './utils.js';
			console.log(add(1, 2));
		`)
		const output = $`${env} ${bin} ${dir}/main.js`
		assert.strictEqual(output, '3')
	})

	test('explicit index.js path works', ({ bin, env, dir }) => {
		mkdirSync(`${dir}/mylib`)
		writeFileSync(`${dir}/mylib/index.js`, `export const msg = "from index";`)
		writeFileSync(`${dir}/main.js`, `
			import { msg } from './mylib/index.js';
			console.log(msg);
		`)
		const output = $`${env} ${bin} ${dir}/main.js`
		assert.strictEqual(output, 'from index')
	})

	test('relative path with .js works', ({ bin, env, dir }) => {
		mkdirSync(`${dir}/lib`)
		writeFileSync(`${dir}/lib/helper.js`, `export const helper = x => x * 2;`)
		writeFileSync(`${dir}/main.js`, `
			import { helper } from './lib/helper.js';
			console.log(helper(21));
		`)
		const output = $`${env} ${bin} ${dir}/main.js`
		assert.strictEqual(output, '42')
	})

	test('dynamic import with explicit extension', ({ bin, env, dir }) => {
		writeFileSync(`${dir}/dynmod.js`, `export const dynamicValue = "loaded";`)
		writeFileSync(`${dir}/main.js`, `
			async function main() {
				const mod = await import('./dynmod.js');
				console.log(mod.dynamicValue);
			}
			main();
		`)
		const output = $`${env} ${bin} ${dir}/main.js`
		assert.strictEqual(output, 'loaded')
	})

	test('nested relative imports', ({ bin, env, dir }) => {
		mkdirSync(`${dir}/a`)
		mkdirSync(`${dir}/a/b`)
		writeFileSync(`${dir}/a/b/deep.js`, `export const deep = "nested";`)
		writeFileSync(`${dir}/a/mid.js`, `export { deep } from './b/deep.js';`)
		writeFileSync(`${dir}/main.js`, `
			import { deep } from './a/mid.js';
			console.log(deep);
		`)
		const output = $`${env} ${bin} ${dir}/main.js`
		assert.strictEqual(output, 'nested')
	})

	test('parent directory imports', ({ bin, env, dir }) => {
		mkdirSync(`${dir}/src`)
		writeFileSync(`${dir}/shared.js`, `export const shared = "from parent";`)
		writeFileSync(`${dir}/src/main.js`, `
			import { shared } from '../shared.js';
			console.log(shared);
		`)
		const output = $`${env} ${bin} ${dir}/src/main.js`
		assert.strictEqual(output, 'from parent')
	})
})

describe('Node Mode Failures (should fail in both node and qjsx)', () => {
	test('missing .js extension fails', ({ bin, env, dir }) => {
		writeFileSync(`${dir}/utils.js`, `export const add = (a,b) => a+b;`)
		writeFileSync(`${dir}/main.js`, `
			import { add } from './utils';
			console.log(add(1, 2));
		`)
		let threw = false
		try {
			$`${env} ${bin} ${dir}/main.js 2>&1`
		} catch {
			threw = true
		}
		assert.strictEqual(threw, true, 'Should fail without .js extension')
	})

	test('directory import without index.js fails', ({ bin, env, dir }) => {
		mkdirSync(`${dir}/mylib`)
		writeFileSync(`${dir}/mylib/index.js`, `export const msg = "from index";`)
		writeFileSync(`${dir}/main.js`, `
			import { msg } from './mylib';
			console.log(msg);
		`)
		let threw = false
		try {
			$`${env} ${bin} ${dir}/main.js 2>&1`
		} catch {
			threw = true
		}
		assert.strictEqual(threw, true, 'Should fail without explicit index.js')
	})
})

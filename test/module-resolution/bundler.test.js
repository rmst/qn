import { describe, test as nodetest } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir, platform } from 'node:os'
import { mkdtempSync, realpathSync } from 'node:fs'

const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), 'module-res-test-')))
const QJSX = resolve(`./bin/${platform()}/qjsx`)
const QJSXC = resolve(`./bin/${platform()}/qjsxc`)
const QJSX_NODE = resolve(`./bin/${platform()}/qjsx-node`)

const $ = (strings, ...values) => {
	const cmd = String.raw({ raw: strings }, ...values)
	return execSync(cmd, { encoding: 'utf8', timeout: 30000 }).trim()
}

const test = (name, fn) => nodetest(name, () => {
	const dir = mktempdir()
	try {
		fn({ dir })
	} finally {
		rmSync(dir, { recursive: true })
	}
})

describe('Bundler Mode (default)', () => {
	test('.js extension fallback', ({ dir }) => {
		writeFileSync(`${dir}/utils.js`, `export const add = (a,b) => a+b;`)
		writeFileSync(`${dir}/main.js`, `
			import { add } from './utils';
			console.log(add(1, 2));
		`)
		const output = $`${QJSX} ${dir}/main.js`
		assert.strictEqual(output, '3')
	})

	test('index.js resolution', ({ dir }) => {
		mkdirSync(`${dir}/mylib`)
		writeFileSync(`${dir}/mylib/index.js`, `export const msg = "from index";`)
		writeFileSync(`${dir}/main.js`, `
			import { msg } from './mylib';
			console.log(msg);
		`)
		const output = $`${QJSX} ${dir}/main.js`
		assert.strictEqual(output, 'from index')
	})

	test('colon-to-slash translation', ({ dir }) => {
		mkdirSync(`${dir}/node`)
		writeFileSync(`${dir}/node/test.js`, `export const value = 42;`)
		writeFileSync(`${dir}/main.js`, `
			import { value } from 'node:test';
			console.log(value);
		`)
		const output = $`QJSXPATH=${dir} ${QJSX} ${dir}/main.js`
		assert.strictEqual(output, '42')
	})

	test('QJSXPATH bare imports', ({ dir }) => {
		mkdirSync(`${dir}/modules`)
		writeFileSync(`${dir}/modules/myutil.js`, `export const val = "bare import works";`)
		writeFileSync(`${dir}/main.js`, `
			import { val } from 'myutil';
			console.log(val);
		`)
		const output = $`QJSXPATH=${dir}/modules ${QJSX} ${dir}/main.js`
		assert.strictEqual(output, 'bare import works')
	})

	test('QJSXPATH multiple paths', ({ dir }) => {
		mkdirSync(`${dir}/lib1`)
		mkdirSync(`${dir}/lib2`)
		writeFileSync(`${dir}/lib1/foo.js`, `export const x = 1;`)
		writeFileSync(`${dir}/lib2/bar.js`, `export const y = 2;`)
		writeFileSync(`${dir}/main.js`, `
			import { x } from 'foo';
			import { y } from 'bar';
			console.log(x + y);
		`)
		const output = $`QJSXPATH=${dir}/lib1:${dir}/lib2 ${QJSX} ${dir}/main.js`
		assert.strictEqual(output, '3')
	})

	test('dynamic import with fallback', ({ dir }) => {
		writeFileSync(`${dir}/dynmod.js`, `export const dynamicValue = "loaded dynamically";`)
		writeFileSync(`${dir}/main.js`, `
			async function main() {
				const mod = await import('./dynmod');
				console.log(mod.dynamicValue);
			}
			main();
		`)
		const output = $`${QJSX} ${dir}/main.js`
		assert.strictEqual(output, 'loaded dynamically')
	})

	test('dynamic import with colon-to-slash', ({ dir }) => {
		mkdirSync(`${dir}/myns`)
		writeFileSync(`${dir}/myns/dynlib.js`, `export const nsValue = "from namespace";`)
		writeFileSync(`${dir}/main.js`, `
			async function main() {
				const mod = await import('myns:dynlib');
				console.log(mod.nsValue);
			}
			main();
		`)
		const output = $`QJSXPATH=${dir} ${QJSX} ${dir}/main.js`
		assert.strictEqual(output, 'from namespace')
	})

	test('qjsx-node imports with node:* protocol', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { existsSync } from 'node:fs';
			import { cwd } from 'node:process';
			console.log(typeof existsSync, typeof cwd);
		`)
		const output = $`${QJSX_NODE} ${dir}/test.js`
		assert.strictEqual(output, 'function function')
	})

	test('circular deps with cross-package imports', ({ dir }) => {
		// Minimal reproduction: two packages that import each other using ../
		// This causes stack overflow when the module normalizer is active.
		mkdirSync(`${dir}/pkg-a`)
		mkdirSync(`${dir}/pkg-b`)

		writeFileSync(`${dir}/pkg-a/index.js`, `
			import { getB } from '../pkg-b/index.js'
			export const getA = () => 'A'
			export const getAB = () => getA() + getB()
		`)
		writeFileSync(`${dir}/pkg-b/index.js`, `
			import { getA } from '../pkg-a/index.js'
			export const getB = () => 'B'
			export const getBA = () => getB() + getA()
		`)
		writeFileSync(`${dir}/main.js`, `
			import { getAB } from './pkg-a/index.js'
			console.log(getAB())
		`)

		const output = $`${QJSX} ${dir}/main.js`
		assert.strictEqual(output, 'AB')
	})
})

describe('Bundler Mode Compilation', () => {
	test('colon-to-slash in compiled binary', ({ dir }) => {
		mkdirSync(`${dir}/node`)
		writeFileSync(`${dir}/node/mymod.js`, `export const greet = () => "hello";`)
		writeFileSync(`${dir}/main.js`, `
			import { greet } from 'node:mymod';
			console.log(greet());
		`)
		$`QJSXPATH=${dir} ${QJSXC} -o ${dir}/app ${dir}/main.js`
		const output = $`${dir}/app`
		assert.strictEqual(output, 'hello')
	})

	test('dynamic import of embedded modules', ({ dir }) => {
		mkdirSync(`${dir}/mylibs`)
		writeFileSync(`${dir}/mylibs/dynamic.js`, `export const dynval = 99;`)
		writeFileSync(`${dir}/main.js`, `
			async function main() {
				const mod = await import('mylibs:dynamic');
				console.log(mod.dynval);
			}
			main();
		`)
		$`QJSXPATH=${dir} ${QJSXC} -D mylibs:dynamic -o ${dir}/app ${dir}/main.js`
		const output = $`${dir}/app`
		assert.strictEqual(output, '99')
	})

	test('relative imports in compiled binary', ({ dir }) => {
		mkdirSync(`${dir}/lib`)
		writeFileSync(`${dir}/lib/helper.js`, `export const helper = x => x * 2;`)
		writeFileSync(`${dir}/main.js`, `
			import { helper } from './lib/helper.js';
			console.log(helper(21));
		`)
		$`${QJSXC} -o ${dir}/app ${dir}/main.js`
		const output = $`${dir}/app`
		assert.strictEqual(output, '42')
	})

	test('QJSXPATH bare imports in compiled binary', ({ dir }) => {
		mkdirSync(`${dir}/modules`)
		writeFileSync(`${dir}/modules/myutil.js`, `export const val = "bare import works";`)
		writeFileSync(`${dir}/main.js`, `
			import { val } from 'myutil';
			console.log(val);
		`)
		$`QJSXPATH=${dir}/modules ${QJSXC} -o ${dir}/app ${dir}/main.js`
		const output = $`${dir}/app`
		assert.strictEqual(output, 'bare import works')
	})
})

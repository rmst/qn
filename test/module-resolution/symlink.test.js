import { describe, test as nodetest } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, realpathSync } from 'node:fs'
import { QN, QJSXC } from '../util.js'

const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), 'symlink-test-')))

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

describe('Symlink Resolution', () => {
	test('relative import from symlinked file resolves against real path', ({ dir }) => {
		// Create real directory structure
		mkdirSync(`${dir}/real`)
		writeFileSync(`${dir}/real/helper.js`, `export const msg = "from real helper";`)
		writeFileSync(`${dir}/real/main.js`, `
			import { msg } from './helper.js';
			console.log(msg);
		`)

		// Create symlink to main.js in a different directory
		mkdirSync(`${dir}/linked`)
		symlinkSync(`${dir}/real/main.js`, `${dir}/linked/main.js`)

		// Running via symlink should still find helper.js in the real directory
		const output = $`${QN()} ${dir}/linked/main.js`
		assert.strictEqual(output, 'from real helper')
	})

	test('relative import from symlinked directory resolves against real path', ({ dir }) => {
		// Create real directory structure
		mkdirSync(`${dir}/real/src`, { recursive: true })
		writeFileSync(`${dir}/real/src/helper.js`, `export const value = 42;`)
		writeFileSync(`${dir}/real/src/main.js`, `
			import { value } from './helper.js';
			console.log(value);
		`)

		// Create symlink to directory
		symlinkSync(`${dir}/real/src`, `${dir}/linked-src`)

		// Running via symlinked directory should work
		const output = $`${QN()} ${dir}/linked-src/main.js`
		assert.strictEqual(output, '42')
	})

	test('parent directory import from symlinked file resolves correctly', ({ dir }) => {
		// Create real directory structure with nested modules
		mkdirSync(`${dir}/real/lib`, { recursive: true })
		writeFileSync(`${dir}/real/utils.js`, `export const util = "utility";`)
		writeFileSync(`${dir}/real/lib/consumer.js`, `
			import { util } from '../utils.js';
			console.log(util);
		`)

		// Create symlink to the lib directory
		symlinkSync(`${dir}/real/lib`, `${dir}/linked-lib`)

		// Running via symlinked directory should find ../utils.js in the real parent
		const output = $`${QN()} ${dir}/linked-lib/consumer.js`
		assert.strictEqual(output, 'utility')
	})

	test('absolute import through symlink resolves via realpath', ({ dir }) => {
		// Create real file
		mkdirSync(`${dir}/real`)
		writeFileSync(`${dir}/real/module.js`, `export const x = "real";`)

		// Create symlink
		symlinkSync(`${dir}/real/module.js`, `${dir}/link-module.js`)

		// Import via absolute symlink path should resolve to real path
		writeFileSync(`${dir}/main.js`, `
			import { x } from '${dir}/link-module.js';
			console.log(x);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'real')
	})

	test('same module imported via symlink and real path has same identity', ({ dir }) => {
		// Create real module that tracks import count
		mkdirSync(`${dir}/real`)
		writeFileSync(`${dir}/real/singleton.js`, `
			let count = 0;
			export const getCount = () => ++count;
		`)

		// Create symlink
		symlinkSync(`${dir}/real/singleton.js`, `${dir}/link-singleton.js`)

		// Import same module via both paths - should be cached as one module
		writeFileSync(`${dir}/main.js`, `
			import { getCount as c1 } from '${dir}/real/singleton.js';
			import { getCount as c2 } from '${dir}/link-singleton.js';
			console.log(c1(), c2());
		`)
		const output = $`${QN()} ${dir}/main.js`
		// If properly canonicalized, both imports reference the same module
		// so count increments only once per call: "1 2"
		// If NOT canonicalized, each would be separate: "1 1"
		assert.strictEqual(output, '1 2')
	})

	test('circular import through symlinked directory resolves correctly', ({ dir }) => {
		// Two modules import each other through a symlink
		mkdirSync(`${dir}/pkg`)
		writeFileSync(`${dir}/pkg/a.js`, `
			import { getB } from '../link/b.js'
			export const a = 'a-value'
			export function getA() { return 'a got b: ' + getB() }
		`)
		writeFileSync(`${dir}/pkg/b.js`, `
			import { a } from '../link/a.js'
			export function getB() { return 'b (a=' + a + ')' }
		`)
		symlinkSync(`${dir}/pkg`, `${dir}/link`)

		writeFileSync(`${dir}/main.js`, `
			import { getA } from './pkg/a.js'
			console.log(getA())
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'a got b: b (a=a-value)')
	})

	test('module identity preserved through symlinked circular imports', ({ dir }) => {
		// Same module reached via different paths (real and symlink) should be one module
		mkdirSync(`${dir}/pkg`)
		writeFileSync(`${dir}/pkg/counter.js`, `
			let n = 0
			export const inc = () => ++n
		`)
		writeFileSync(`${dir}/pkg/a.js`, `
			import { inc as incViaLink } from '../link/counter.js'
			import { inc as incDirect } from './counter.js'
			console.log(incViaLink(), incDirect())
		`)
		symlinkSync(`${dir}/pkg`, `${dir}/link`)

		const output = $`${QN()} ${dir}/pkg/a.js`
		// Same module identity → shared counter: "1 2"
		assert.strictEqual(output, '1 2')
	})

	test('extension probing works through symlinks', ({ dir }) => {
		// Create real file
		mkdirSync(`${dir}/real`)
		writeFileSync(`${dir}/real/noext.js`, `export const y = "found";`)

		// Create symlink to directory
		symlinkSync(`${dir}/real`, `${dir}/linked`)

		// Import without extension through symlink
		writeFileSync(`${dir}/main.js`, `
			import { y } from '${dir}/linked/noext';
			console.log(y);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'found')
	})

	test('index.js resolution works through symlinks', ({ dir }) => {
		// Create real directory with index.js
		mkdirSync(`${dir}/real/mypackage`, { recursive: true })
		writeFileSync(`${dir}/real/mypackage/index.js`, `export const pkg = "package";`)

		// Create symlink to parent directory
		symlinkSync(`${dir}/real`, `${dir}/linked`)

		// Import directory through symlink
		writeFileSync(`${dir}/main.js`, `
			import { pkg } from '${dir}/linked/mypackage';
			console.log(pkg);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'package')
	})
})

describe('Symlink Resolution with qn (embedded modules)', () => {
	// qn has embedded modules which changes the module normalizer path.
	// These tests verify symlink resolution works correctly when
	// embedded_modules is non-NULL.

	test('module identity preserved through symlinks with qn', ({ dir }) => {
		mkdirSync(`${dir}/real`)
		writeFileSync(`${dir}/real/singleton.js`, `
			let count = 0;
			export const getCount = () => ++count;
		`)
		symlinkSync(`${dir}/real/singleton.js`, `${dir}/link-singleton.js`)

		writeFileSync(`${dir}/main.js`, `
			import { getCount as c1 } from '${dir}/real/singleton.js';
			import { getCount as c2 } from '${dir}/link-singleton.js';
			console.log(c1(), c2());
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, '1 2')
	})

	test('circular import through symlinked directory with qn', ({ dir }) => {
		mkdirSync(`${dir}/pkg`)
		writeFileSync(`${dir}/pkg/a.js`, `
			import { getB } from '../link/b.js'
			export const a = 'a-value'
			export function getA() { return 'a got b: ' + getB() }
		`)
		writeFileSync(`${dir}/pkg/b.js`, `
			import { a } from '../link/a.js'
			export function getB() { return 'b (a=' + a + ')' }
		`)
		symlinkSync(`${dir}/pkg`, `${dir}/link`)

		writeFileSync(`${dir}/main.js`, `
			import { getA } from './pkg/a.js'
			console.log(getA())
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'a got b: b (a=a-value)')
	})

	test('module loaded only once through symlink with qn', ({ dir }) => {
		mkdirSync(`${dir}/pkg`)
		writeFileSync(`${dir}/pkg/mod.js`, `
			import { getB } from '../link/b.js'
			globalThis.__loadCount = (globalThis.__loadCount || 0) + 1
			export const loadCount = () => globalThis.__loadCount
		`)
		writeFileSync(`${dir}/pkg/b.js`, `
			import { loadCount } from '../link/mod.js'
			export function getB() { return 'count=' + loadCount() }
		`)
		symlinkSync(`${dir}/pkg`, `${dir}/link`)

		writeFileSync(`${dir}/main.js`, `
			import { loadCount } from './pkg/mod.js'
			console.log(loadCount())
		`)
		// Module should be loaded exactly once
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, '1')
	})
})

describe('Symlink Resolution with bare imports', () => {
	// Tests for cycle detection when a symlink causes a bare import
	// (via NODE_PATH or node_modules) to resolve back to an already-loaded module.

	test('circular import through node_modules symlink with qn', ({ dir }) => {
		// a.js -> ./lib/b.js -> ./c.js -> self/a.js (via node_modules symlink)
		mkdirSync(`${dir}/lib`)
		mkdirSync(`${dir}/node_modules`)
		writeFileSync(`${dir}/a.js`, `
			import { b } from './lib/b.js'
			export const a = 'a-value'
			console.log('a:', b)
		`)
		writeFileSync(`${dir}/lib/b.js`, `
			import { c } from './c.js'
			export const b = 'b-value'
		`)
		writeFileSync(`${dir}/lib/c.js`, `
			import { a } from 'self/a.js'
			export const c = 'c-value'
		`)
		symlinkSync(dir, `${dir}/node_modules/self`)

		const output = $`${QN()} ${dir}/a.js`
		assert.strictEqual(output, 'a: b-value')
	})

	test('circular import through node_modules symlink with qn', ({ dir }) => {
		mkdirSync(`${dir}/lib`)
		mkdirSync(`${dir}/node_modules`)
		writeFileSync(`${dir}/a.js`, `
			import { b } from './lib/b.js'
			export const a = 'a-value'
			console.log('a:', b)
		`)
		writeFileSync(`${dir}/lib/b.js`, `
			import { c } from './c.js'
			export const b = 'b-value'
		`)
		writeFileSync(`${dir}/lib/c.js`, `
			import { a } from 'self/a.js'
			export const c = 'c-value'
		`)
		symlinkSync(dir, `${dir}/node_modules/self`)

		const output = $`${QN()} ${dir}/a.js`
		assert.strictEqual(output, 'a: b-value')
	})

	test('circular import through NODE_PATH symlink with qn', ({ dir }) => {
		// Same pattern but using NODE_PATH instead of node_modules
		mkdirSync(`${dir}/lib`)
		mkdirSync(`${dir}/pkg`)
		writeFileSync(`${dir}/a.js`, `
			import { b } from './lib/b.js'
			export const a = 'a-value'
			console.log('a:', b)
		`)
		writeFileSync(`${dir}/lib/b.js`, `
			import { c } from './c.js'
			export const b = 'b-value'
		`)
		writeFileSync(`${dir}/lib/c.js`, `
			import { a } from 'self/a.js'
			export const c = 'c-value'
		`)
		symlinkSync(dir, `${dir}/pkg/self`)

		const output = $`NODE_PATH=${dir}/pkg ${QN()} ${dir}/a.js`
		assert.strictEqual(output, 'a: b-value')
	})

	test('circular import through NODE_PATH symlink with qn', ({ dir }) => {
		mkdirSync(`${dir}/lib`)
		mkdirSync(`${dir}/pkg`)
		writeFileSync(`${dir}/a.js`, `
			import { b } from './lib/b.js'
			export const a = 'a-value'
			console.log('a:', b)
		`)
		writeFileSync(`${dir}/lib/b.js`, `
			import { c } from './c.js'
			export const b = 'b-value'
		`)
		writeFileSync(`${dir}/lib/c.js`, `
			import { a } from 'self/a.js'
			export const c = 'c-value'
		`)
		symlinkSync(dir, `${dir}/pkg/self`)

		const output = $`NODE_PATH=${dir}/pkg ${QN()} ${dir}/a.js`
		assert.strictEqual(output, 'a: b-value')
	})

	test('module identity preserved through node_modules symlink', ({ dir }) => {
		// Verify the same module loaded via direct path and via node_modules symlink
		// is the same instance (shared state)
		mkdirSync(`${dir}/node_modules`)
		writeFileSync(`${dir}/counter.js`, `
			let n = 0
			export const inc = () => ++n
		`)
		writeFileSync(`${dir}/main.js`, `
			import { inc as directInc } from './counter.js'
			import { inc as nmInc } from 'self/counter.js'
			console.log(directInc(), nmInc())
		`)
		symlinkSync(dir, `${dir}/node_modules/self`)

		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, '1 2')
	})

	test('module identity preserved through NODE_PATH symlink', ({ dir }) => {
		mkdirSync(`${dir}/pkg`)
		writeFileSync(`${dir}/counter.js`, `
			let n = 0
			export const inc = () => ++n
		`)
		writeFileSync(`${dir}/main.js`, `
			import { inc as directInc } from './counter.js'
			import { inc as npInc } from 'self/counter.js'
			console.log(directInc(), npInc())
		`)
		symlinkSync(dir, `${dir}/pkg/self`)

		const output = $`NODE_PATH=${dir}/pkg ${QN()} ${dir}/main.js`
		assert.strictEqual(output, '1 2')
	})
})

describe('Symlink Resolution with Compilation', () => {
	test('compiled binary with symlinked source works', ({ dir }) => {
		// Create real directory structure
		mkdirSync(`${dir}/real`)
		writeFileSync(`${dir}/real/helper.js`, `export const compiled = "yes";`)
		writeFileSync(`${dir}/real/main.js`, `
			import { compiled } from './helper.js';
			console.log(compiled);
		`)

		// Create symlink
		mkdirSync(`${dir}/linked`)
		symlinkSync(`${dir}/real/main.js`, `${dir}/linked/main.js`)

		// Compile via symlink path
		$`${QJSXC()} -o ${dir}/app ${dir}/linked/main.js`

		// Run compiled binary
		const output = $`${dir}/app`
		assert.strictEqual(output, 'yes')
	})
})

import { describe, test as nodetest } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, realpathSync } from 'node:fs'
import { QN, QNC } from '../util.js'

const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), 'module-res-test-')))

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
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, '3')
	})

	test('index.js resolution', ({ dir }) => {
		mkdirSync(`${dir}/mylib`)
		writeFileSync(`${dir}/mylib/index.js`, `export const msg = "from index";`)
		writeFileSync(`${dir}/main.js`, `
			import { msg } from './mylib';
			console.log(msg);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'from index')
	})

	test('colon-to-slash translation', ({ dir }) => {
		mkdirSync(`${dir}/myns`)
		writeFileSync(`${dir}/myns/lib.js`, `export const value = 42;`)
		writeFileSync(`${dir}/main.js`, `
			import { value } from 'myns:lib';
			console.log(value);
		`)
		const output = $`NODE_PATH=${dir} ${QN()} ${dir}/main.js`
		assert.strictEqual(output, '42')
	})

	test('NODE_PATH bare imports', ({ dir }) => {
		mkdirSync(`${dir}/modules`)
		writeFileSync(`${dir}/modules/myutil.js`, `export const val = "bare import works";`)
		writeFileSync(`${dir}/main.js`, `
			import { val } from 'myutil';
			console.log(val);
		`)
		const output = $`NODE_PATH=${dir}/modules ${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'bare import works')
	})

	test('NODE_PATH multiple paths', ({ dir }) => {
		mkdirSync(`${dir}/lib1`)
		mkdirSync(`${dir}/lib2`)
		writeFileSync(`${dir}/lib1/foo.js`, `export const x = 1;`)
		writeFileSync(`${dir}/lib2/bar.js`, `export const y = 2;`)
		writeFileSync(`${dir}/main.js`, `
			import { x } from 'foo';
			import { y } from 'bar';
			console.log(x + y);
		`)
		const output = $`NODE_PATH=${dir}/lib1:${dir}/lib2 ${QN()} ${dir}/main.js`
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
		const output = $`${QN()} ${dir}/main.js`
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
		const output = $`NODE_PATH=${dir} ${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'from namespace')
	})

	test('qn imports with node:* protocol', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { existsSync } from 'node:fs';
			import { cwd } from 'node:process';
			console.log(typeof existsSync, typeof cwd);
		`)
		const output = $`${QN()} ${dir}/test.js`
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

		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'AB')
	})
})

describe('node_modules resolution', () => {
	test('resolves via package.json exports', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/mypkg/dist`, { recursive: true })
		writeFileSync(`${dir}/node_modules/mypkg/package.json`, JSON.stringify({
			name: "mypkg",
			exports: { ".": { "import": "./dist/index.js" }, "./utils": { "import": "./dist/utils.js" } }
		}))
		writeFileSync(`${dir}/node_modules/mypkg/dist/index.js`, `export const hello = "from mypkg";`)
		writeFileSync(`${dir}/node_modules/mypkg/dist/utils.js`, `export const greet = name => "hi " + name;`)
		writeFileSync(`${dir}/main.js`, `
			import { hello } from 'mypkg';
			import { greet } from 'mypkg/utils';
			console.log(hello, greet("world"));
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'from mypkg hi world')
	})

	test('resolves via package.json main field', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/oldpkg/lib`, { recursive: true })
		writeFileSync(`${dir}/node_modules/oldpkg/package.json`, JSON.stringify({
			name: "oldpkg", main: "./lib/main.js"
		}))
		writeFileSync(`${dir}/node_modules/oldpkg/lib/main.js`, `export const val = 42;`)
		writeFileSync(`${dir}/main.js`, `
			import { val } from 'oldpkg';
			console.log(val);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, '42')
	})

	test('resolves scoped packages', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/@scope/pkg`, { recursive: true })
		writeFileSync(`${dir}/node_modules/@scope/pkg/package.json`, JSON.stringify({
			name: "@scope/pkg", exports: { ".": "./index.js" }
		}))
		writeFileSync(`${dir}/node_modules/@scope/pkg/index.js`, `export const scoped = "works";`)
		writeFileSync(`${dir}/main.js`, `
			import { scoped } from '@scope/pkg';
			console.log(scoped);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'works')
	})

	test('walks up directory tree', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/uppkg`, { recursive: true })
		writeFileSync(`${dir}/node_modules/uppkg/index.js`, `export const found = "walked up";`)
		mkdirSync(`${dir}/sub/deep`, { recursive: true })
		writeFileSync(`${dir}/sub/deep/main.js`, `
			import { found } from 'uppkg';
			console.log(found);
		`)
		const output = $`${QN()} ${dir}/sub/deep/main.js`
		assert.strictEqual(output, 'walked up')
	})

	test('NODE_PATH takes precedence over node_modules', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/dualpkg`, { recursive: true })
		writeFileSync(`${dir}/node_modules/dualpkg/index.js`, `export const src = "node_modules";`)
		mkdirSync(`${dir}/mylibs`)
		writeFileSync(`${dir}/mylibs/dualpkg.js`, `export const src = "NODE_PATH";`)
		writeFileSync(`${dir}/main.js`, `
			import { src } from 'dualpkg';
			console.log(src);
		`)
		const output = $`NODE_PATH=${dir}/mylibs ${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'NODE_PATH')
	})

	test('exports as direct string', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/simplepkg`, { recursive: true })
		writeFileSync(`${dir}/node_modules/simplepkg/package.json`, JSON.stringify({
			name: "simplepkg", exports: "./entry.js"
		}))
		writeFileSync(`${dir}/node_modules/simplepkg/entry.js`, `export const v = "direct string";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'simplepkg';
			console.log(v);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'direct string')
	})

	test('exports with "default" condition fallback', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/defpkg/dist`, { recursive: true })
		writeFileSync(`${dir}/node_modules/defpkg/package.json`, JSON.stringify({
			name: "defpkg", exports: { ".": { "default": "./dist/main.js" } }
		}))
		writeFileSync(`${dir}/node_modules/defpkg/dist/main.js`, `export const v = "from default";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'defpkg';
			console.log(v);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'from default')
	})

	test('package with no package.json falls back to index.js', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/nopkgjson`, { recursive: true })
		writeFileSync(`${dir}/node_modules/nopkgjson/index.js`, `export const v = "no pkg json";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'nopkgjson';
			console.log(v);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'no pkg json')
	})

	test('scoped package with subpath exports', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/@myorg/lib/dist`, { recursive: true })
		writeFileSync(`${dir}/node_modules/@myorg/lib/package.json`, JSON.stringify({
			name: "@myorg/lib",
			exports: { ".": "./dist/index.js", "./utils": "./dist/utils.js" }
		}))
		writeFileSync(`${dir}/node_modules/@myorg/lib/dist/index.js`, `export const root = "root";`)
		writeFileSync(`${dir}/node_modules/@myorg/lib/dist/utils.js`, `export const util = "util";`)
		writeFileSync(`${dir}/main.js`, `
			import { root } from '@myorg/lib';
			import { util } from '@myorg/lib/utils';
			console.log(root, util);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'root util')
	})

	test('unmatched subpath falls back to direct file resolution', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/loosepkg`, { recursive: true })
		writeFileSync(`${dir}/node_modules/loosepkg/package.json`, JSON.stringify({
			name: "loosepkg",
			exports: { ".": "./index.js" }
		}))
		writeFileSync(`${dir}/node_modules/loosepkg/index.js`, `export const v = 1;`)
		writeFileSync(`${dir}/node_modules/loosepkg/extra.js`, `export const v = 2;`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'loosepkg/extra';
			console.log(v);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, '2')
	})

	test('unsupported exports patterns are silently skipped', ({ dir }) => {
		// Array targets and wildcard patterns are not supported;
		// resolution falls back to index.js
		mkdirSync(`${dir}/node_modules/fancypkg`, { recursive: true })
		writeFileSync(`${dir}/node_modules/fancypkg/package.json`, JSON.stringify({
			name: "fancypkg",
			exports: { ".": ["./not-supported.js"], "./*": "./src/*.js" }
		}))
		writeFileSync(`${dir}/node_modules/fancypkg/index.js`, `export const v = "fallback";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'fancypkg';
			console.log(v);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'fallback')
	})

	test('malformed package.json is gracefully ignored', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/badpkg`, { recursive: true })
		writeFileSync(`${dir}/node_modules/badpkg/package.json`, `{not valid json!!!`)
		writeFileSync(`${dir}/node_modules/badpkg/index.js`, `export const v = "survived";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'badpkg';
			console.log(v);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'survived')
	})

	test('nested node_modules (dependency of dependency)', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/outer`, { recursive: true })
		mkdirSync(`${dir}/node_modules/outer/node_modules/inner`, { recursive: true })
		mkdirSync(`${dir}/node_modules/inner`, { recursive: true })
		writeFileSync(`${dir}/node_modules/inner/index.js`, `export const v = "top-level";`)
		writeFileSync(`${dir}/node_modules/outer/node_modules/inner/index.js`, `export const v = "nested";`)
		writeFileSync(`${dir}/node_modules/outer/index.js`, `
			import { v } from 'inner';
			export const result = v;
		`)
		writeFileSync(`${dir}/main.js`, `
			import { result } from 'outer';
			console.log(result);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'nested')
	})

})

describe('node_modules resolution with qn', () => {
	// qn has embedded modules which changes module resolution paths.
	// Verify node_modules walking still works for non-embedded user packages.

	test('resolves via package.json exports with qn', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/mypkg/dist`, { recursive: true })
		writeFileSync(`${dir}/node_modules/mypkg/package.json`, JSON.stringify({
			name: "mypkg",
			exports: { ".": { "import": "./dist/index.js" } }
		}))
		writeFileSync(`${dir}/node_modules/mypkg/dist/index.js`, `export const hello = "from mypkg";`)
		writeFileSync(`${dir}/main.js`, `
			import { hello } from 'mypkg';
			console.log(hello);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'from mypkg')
	})

	test('resolves index.js fallback with qn', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/simplepkg`, { recursive: true })
		writeFileSync(`${dir}/node_modules/simplepkg/index.js`, `export const v = "simple";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'simplepkg';
			console.log(v);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'simple')
	})

	test('walks up directory tree with qn', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/uppkg`, { recursive: true })
		writeFileSync(`${dir}/node_modules/uppkg/index.js`, `export const found = "walked up";`)
		mkdirSync(`${dir}/sub/deep`, { recursive: true })
		writeFileSync(`${dir}/sub/deep/main.js`, `
			import { found } from 'uppkg';
			console.log(found);
		`)
		const output = $`${QN()} ${dir}/sub/deep/main.js`
		assert.strictEqual(output, 'walked up')
	})

	test('nested node_modules with qn', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/outer/node_modules/inner`, { recursive: true })
		mkdirSync(`${dir}/node_modules/inner`, { recursive: true })
		writeFileSync(`${dir}/node_modules/inner/index.js`, `export const v = "top-level";`)
		writeFileSync(`${dir}/node_modules/outer/node_modules/inner/index.js`, `export const v = "nested";`)
		writeFileSync(`${dir}/node_modules/outer/index.js`, `
			import { v } from 'inner';
			export const result = v;
		`)
		writeFileSync(`${dir}/main.js`, `
			import { result } from 'outer';
			console.log(result);
		`)
		const output = $`${QN()} ${dir}/main.js`
		assert.strictEqual(output, 'nested')
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
		$`NODE_PATH=${dir} ${QNC()} -o ${dir}/app ${dir}/main.js`
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
		$`NODE_PATH=${dir} ${QNC()} -D mylibs:dynamic -o ${dir}/app ${dir}/main.js`
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
		$`${QNC()} -o ${dir}/app ${dir}/main.js`
		const output = $`${dir}/app`
		assert.strictEqual(output, '42')
	})

	test('NODE_PATH bare imports in compiled binary', ({ dir }) => {
		mkdirSync(`${dir}/modules`)
		writeFileSync(`${dir}/modules/myutil.js`, `export const val = "bare import works";`)
		writeFileSync(`${dir}/main.js`, `
			import { val } from 'myutil';
			console.log(val);
		`)
		$`NODE_PATH=${dir}/modules ${QNC()} -o ${dir}/app ${dir}/main.js`
		const output = $`${dir}/app`
		assert.strictEqual(output, 'bare import works')
	})

	test('node_modules in compiled binary', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/mypkg`, { recursive: true })
		writeFileSync(`${dir}/node_modules/mypkg/package.json`, JSON.stringify({
			name: "mypkg", exports: { ".": "./index.js" }
		}))
		writeFileSync(`${dir}/node_modules/mypkg/index.js`, `export const v = "compiled nm";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'mypkg';
			console.log(v);
		`)
		$`${QNC()} -o ${dir}/app ${dir}/main.js`
		const output = $`${dir}/app`
		assert.strictEqual(output, 'compiled nm')
	})

	test('node_modules with subpath exports in compiled binary', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/pkg/dist`, { recursive: true })
		writeFileSync(`${dir}/node_modules/pkg/package.json`, JSON.stringify({
			name: "pkg",
			exports: { ".": "./dist/index.js", "./utils": "./dist/utils.js" }
		}))
		writeFileSync(`${dir}/node_modules/pkg/dist/index.js`, `export const root = "root";`)
		writeFileSync(`${dir}/node_modules/pkg/dist/utils.js`, `export const util = "util";`)
		writeFileSync(`${dir}/main.js`, `
			import { root } from 'pkg';
			import { util } from 'pkg/utils';
			console.log(root, util);
		`)
		$`${QNC()} -o ${dir}/app ${dir}/main.js`
		const output = $`${dir}/app`
		assert.strictEqual(output, 'root util')
	})

	test('node_modules through symlink in compiled binary', ({ dir }) => {
		// Package directory is a symlink to the real location
		mkdirSync(`${dir}/real-pkg`)
		writeFileSync(`${dir}/real-pkg/index.js`, `export const v = "symlinked pkg";`)
		mkdirSync(`${dir}/node_modules`)
		symlinkSync(`${dir}/real-pkg`, `${dir}/node_modules/linkpkg`)

		writeFileSync(`${dir}/main.js`, `
			import { v } from 'linkpkg';
			console.log(v);
		`)
		$`${QNC()} -o ${dir}/app ${dir}/main.js`
		const output = $`${dir}/app`
		assert.strictEqual(output, 'symlinked pkg')
	})

	test('node_modules with nested dependencies in compiled binary', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/outer/node_modules/inner`, { recursive: true })
		writeFileSync(`${dir}/node_modules/outer/index.js`, `
			import { v } from 'inner';
			export const result = 'outer+' + v;
		`)
		writeFileSync(`${dir}/node_modules/outer/node_modules/inner/index.js`,
			`export const v = "inner";`)
		writeFileSync(`${dir}/main.js`, `
			import { result } from 'outer';
			console.log(result);
		`)
		$`${QNC()} -o ${dir}/app ${dir}/main.js`
		const output = $`${dir}/app`
		assert.strictEqual(output, 'outer+inner')
	})
})

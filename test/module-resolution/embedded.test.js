import { describe, test as nodetest } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, realpathSync } from 'node:fs'
import { QN, QNC } from '../util.js'

const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), 'embedded-test-')))

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

describe('Standalone compiled binaries (source tree deleted after compilation)', () => {

	test('static relative imports', ({ dir }) => {
		mkdirSync(`${dir}/src/lib`, { recursive: true })
		writeFileSync(`${dir}/src/lib/utils.js`, `export const double = x => x * 2;`)
		writeFileSync(`${dir}/src/main.js`, `
			import { double } from './lib/utils.js';
			console.log(double(21));
		`)
		$`${QNC()} -o ${dir}/app ${dir}/src/main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, '42')
	})

	test('NODE_PATH bare imports', ({ dir }) => {
		mkdirSync(`${dir}/src/modules`, { recursive: true })
		writeFileSync(`${dir}/src/modules/mylib.js`, `export const v = "from NODE_PATH";`)
		writeFileSync(`${dir}/src/main.js`, `
			import { v } from 'mylib';
			console.log(v);
		`)
		$`NODE_PATH=${dir}/src/modules ${QNC()} -o ${dir}/app ${dir}/src/main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, 'from NODE_PATH')
	})

	test('dynamic imports of embedded modules', ({ dir }) => {
		mkdirSync(`${dir}/src/modules`, { recursive: true })
		writeFileSync(`${dir}/src/modules/dynmod.js`, `export const v = "dynamic embedded";`)
		writeFileSync(`${dir}/src/main.js`, `
			async function main() {
				const mod = await import('dynmod');
				console.log(mod.v);
			}
			main();
		`)
		$`NODE_PATH=${dir}/src/modules ${QNC()} -D dynmod -o ${dir}/app ${dir}/src/main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, 'dynamic embedded')
	})

	test('node_modules with package.json exports', ({ dir }) => {
		mkdirSync(`${dir}/src/node_modules/mypkg/dist`, { recursive: true })
		writeFileSync(`${dir}/src/node_modules/mypkg/package.json`, JSON.stringify({
			name: "mypkg", exports: { ".": "./dist/index.js" }
		}))
		writeFileSync(`${dir}/src/node_modules/mypkg/dist/index.js`, `export const v = "standalone exports";`)
		writeFileSync(`${dir}/src/main.js`, `
			import { v } from 'mypkg';
			console.log(v);
		`)
		$`${QNC()} -o ${dir}/app ${dir}/src/main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, 'standalone exports')
	})

	test('node_modules with index.js fallback', ({ dir }) => {
		mkdirSync(`${dir}/src/node_modules/simplepkg`, { recursive: true })
		writeFileSync(`${dir}/src/node_modules/simplepkg/index.js`, `export const v = "standalone index";`)
		writeFileSync(`${dir}/src/main.js`, `
			import { v } from 'simplepkg';
			console.log(v);
		`)
		$`${QNC()} -o ${dir}/app ${dir}/src/main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, 'standalone index')
	})

	test('node_modules with subpath exports', ({ dir }) => {
		mkdirSync(`${dir}/src/node_modules/pkg/dist`, { recursive: true })
		writeFileSync(`${dir}/src/node_modules/pkg/package.json`, JSON.stringify({
			name: "pkg",
			exports: { ".": "./dist/index.js", "./utils": "./dist/utils.js" }
		}))
		writeFileSync(`${dir}/src/node_modules/pkg/dist/index.js`, `export const root = "root";`)
		writeFileSync(`${dir}/src/node_modules/pkg/dist/utils.js`, `export const util = "util";`)
		writeFileSync(`${dir}/src/main.js`, `
			import { root } from 'pkg';
			import { util } from 'pkg/utils';
			console.log(root, util);
		`)
		$`${QNC()} -o ${dir}/app ${dir}/src/main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, 'root util')
	})

	test('nested node_modules (dependency of dependency)', ({ dir }) => {
		mkdirSync(`${dir}/src/node_modules/outer/node_modules/inner`, { recursive: true })
		mkdirSync(`${dir}/src/node_modules/inner`, { recursive: true })
		writeFileSync(`${dir}/src/node_modules/inner/index.js`, `export const v = "top-level";`)
		writeFileSync(`${dir}/src/node_modules/outer/node_modules/inner/index.js`, `export const v = "nested";`)
		writeFileSync(`${dir}/src/node_modules/outer/index.js`, `
			import { v } from 'inner';
			export const result = 'outer+' + v;
		`)
		writeFileSync(`${dir}/src/main.js`, `
			import { result } from 'outer';
			import { v } from 'inner';
			console.log(result, v);
		`)
		$`${QNC()} -o ${dir}/app ${dir}/src/main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, 'outer+nested top-level')
	})

	test('package-internal relative imports', ({ dir }) => {
		mkdirSync(`${dir}/src/node_modules/mypkg/lib`, { recursive: true })
		writeFileSync(`${dir}/src/node_modules/mypkg/package.json`, JSON.stringify({
			name: "mypkg", exports: { ".": "./index.js" }
		}))
		writeFileSync(`${dir}/src/node_modules/mypkg/lib/utils.js`, `export const helper = x => x + 1;`)
		writeFileSync(`${dir}/src/node_modules/mypkg/index.js`, `
			import { helper } from './lib/utils.js';
			export const inc = helper;
		`)
		writeFileSync(`${dir}/src/main.js`, `
			import { inc } from 'mypkg';
			console.log(inc(41));
		`)
		$`${QNC()} -o ${dir}/app ${dir}/src/main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, '42')
	})

	test('scoped packages', ({ dir }) => {
		mkdirSync(`${dir}/src/node_modules/@myorg/pkg`, { recursive: true })
		writeFileSync(`${dir}/src/node_modules/@myorg/pkg/package.json`, JSON.stringify({
			name: "@myorg/pkg", exports: { ".": "./index.js" }
		}))
		writeFileSync(`${dir}/src/node_modules/@myorg/pkg/index.js`, `export const v = "scoped standalone";`)
		writeFileSync(`${dir}/src/main.js`, `
			import { v } from '@myorg/pkg';
			console.log(v);
		`)
		$`${QNC()} -o ${dir}/app ${dir}/src/main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, 'scoped standalone')
	})

	test('mixed NODE_PATH and node_modules', ({ dir }) => {
		mkdirSync(`${dir}/src/libs`, { recursive: true })
		mkdirSync(`${dir}/src/node_modules/nmpkg`, { recursive: true })
		writeFileSync(`${dir}/src/libs/pathmod.js`, `export const src = "NODE_PATH";`)
		writeFileSync(`${dir}/src/node_modules/nmpkg/index.js`, `export const src = "node_modules";`)
		writeFileSync(`${dir}/src/main.js`, `
			import { src as s1 } from 'pathmod';
			import { src as s2 } from 'nmpkg';
			console.log(s1, s2);
		`)
		$`NODE_PATH=${dir}/src/libs ${QNC()} -o ${dir}/app ${dir}/src/main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, 'NODE_PATH node_modules')
	})

	test('node_modules package importing another package via bare import', ({ dir }) => {
		mkdirSync(`${dir}/src/node_modules/pkg-a`, { recursive: true })
		mkdirSync(`${dir}/src/node_modules/pkg-b`, { recursive: true })
		writeFileSync(`${dir}/src/node_modules/pkg-b/index.js`, `export const b = "from-b";`)
		writeFileSync(`${dir}/src/node_modules/pkg-a/index.js`, `
			import { b } from 'pkg-b';
			export const a = "from-a+" + b;
		`)
		writeFileSync(`${dir}/src/main.js`, `
			import { a } from 'pkg-a';
			console.log(a);
		`)
		$`${QNC()} -o ${dir}/app ${dir}/src/main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, 'from-a+from-b')
	})

	test('deeply nested node_modules (three levels)', ({ dir }) => {
		// main -> pkg-a -> pkg-b (nested in pkg-a) -> pkg-c (nested in pkg-b)
		mkdirSync(`${dir}/src/node_modules/pkg-a/node_modules/pkg-b/node_modules/pkg-c`, { recursive: true })
		writeFileSync(`${dir}/src/node_modules/pkg-a/node_modules/pkg-b/node_modules/pkg-c/index.js`,
			`export const v = "deep";`)
		writeFileSync(`${dir}/src/node_modules/pkg-a/node_modules/pkg-b/index.js`, `
			import { v } from 'pkg-c';
			export const bv = "b+" + v;
		`)
		writeFileSync(`${dir}/src/node_modules/pkg-a/index.js`, `
			import { bv } from 'pkg-b';
			export const av = "a+" + bv;
		`)
		writeFileSync(`${dir}/src/main.js`, `
			import { av } from 'pkg-a';
			console.log(av);
		`)
		$`${QNC()} -o ${dir}/app ${dir}/src/main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, 'a+b+deep')
	})

	test('bare import resolved via .js extension probing (not NODE_PATH)', ({ dir }) => {
		// Reproduces the qx/core bug: a bare import like "mylib/core" where
		// mylib/core.js exists relative to cwd but is NOT in NODE_PATH or node_modules.
		// The compile-time normalizer must try extension probing to find it.
		mkdirSync(`${dir}/src/mylib`, { recursive: true })
		writeFileSync(`${dir}/src/mylib/core.js`, `export const v = "from core";`)
		writeFileSync(`${dir}/src/mylib/index.js`, `
			import { v } from 'mylib/core';
			export const result = v + " via index";
		`)
		writeFileSync(`${dir}/src/main.js`, `
			import { result } from 'mylib';
			console.log(result);
		`)
		$`cd ${dir}/src && NODE_PATH=. ${QNC()} -o ${dir}/app main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, 'from core via index')
	})

	test('NODE_PATH module with internal relative imports', ({ dir }) => {
		mkdirSync(`${dir}/src/modules/mylib`, { recursive: true })
		writeFileSync(`${dir}/src/modules/mylib/helper.js`, `export const h = 10;`)
		writeFileSync(`${dir}/src/modules/mylib/index.js`, `
			import { h } from './helper.js';
			export const v = h * 2;
		`)
		writeFileSync(`${dir}/src/main.js`, `
			import { v } from 'mylib';
			console.log(v);
		`)
		$`NODE_PATH=${dir}/src/modules ${QNC()} -o ${dir}/app ${dir}/src/main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, '20')
	})

	test('same module via absolute and relative path shares identity', ({ dir }) => {
		mkdirSync(`${dir}/src`, { recursive: true })
		writeFileSync(`${dir}/src/counter.js`, `
			let n = 0;
			export const inc = () => ++n;
		`)
		writeFileSync(`${dir}/src/via-abs.js`, `
			import { inc } from '${dir}/src/counter.js';
			export const absInc = inc;
		`)
		writeFileSync(`${dir}/src/main.js`, `
			import { inc } from './counter.js';
			import { absInc } from './via-abs.js';
			console.log(inc(), absInc());
		`)
		$`cd ${dir}/src && ${QNC()} -o ${dir}/app main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, '1 2')
	})

	test('two bare modules import same file via relative and absolute path', ({ dir }) => {
		mkdirSync(`${dir}/src/libs/pkg-a`, { recursive: true })
		mkdirSync(`${dir}/src/libs/pkg-b`, { recursive: true })
		writeFileSync(`${dir}/src/libs/shared.js`, `
			let n = 0;
			export const inc = () => ++n;
		`)
		writeFileSync(`${dir}/src/libs/pkg-a/index.js`, `
			import { inc } from '../shared.js';
			export const aInc = inc;
		`)
		writeFileSync(`${dir}/src/libs/pkg-b/index.js`, `
			import { inc } from '${dir}/src/libs/shared.js';
			export const bInc = inc;
		`)
		writeFileSync(`${dir}/src/main.js`, `
			import { aInc } from 'pkg-a';
			import { bInc } from 'pkg-b';
			console.log(aInc(), bInc());
		`)
		$`cd ${dir}/src && NODE_PATH=libs ${QNC()} -o ${dir}/app main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, '1 2')
	})

	test('parent directory import via ../', ({ dir }) => {
		mkdirSync(`${dir}/src/sub`, { recursive: true })
		writeFileSync(`${dir}/src/shared.js`, `export const v = "from parent";`)
		writeFileSync(`${dir}/src/sub/main.js`, `
			import { v } from '../shared.js';
			console.log(v);
		`)
		$`cd ${dir}/src && ${QNC()} -o ${dir}/app sub/main.js`
		rmSync(`${dir}/src`, { recursive: true })
		assert.strictEqual($`${dir}/app`, 'from parent')
	})
})

describe('Namespace separation (qn runtime)', () => {

	test('user bare import resolves to embedded node module', ({ dir }) => {
		writeFileSync(`${dir}/main.js`, `
			import { existsSync } from 'node:fs';
			import { join } from 'node:path';
			console.log(typeof existsSync, typeof join);
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'function function')
	})

	test('user node_modules work alongside embedded modules', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/mypkg`, { recursive: true })
		writeFileSync(`${dir}/node_modules/mypkg/index.js`, `
			import { existsSync } from 'node:fs';
			export const v = typeof existsSync;
		`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from 'mypkg';
			import { join } from 'node:path';
			console.log(v, typeof join);
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'function function')
	})

	test('local relative import with name similar to embedded module does not conflict', ({ dir }) => {
		// User has a local ./node/path.js but also imports 'node:path' (embedded)
		mkdirSync(`${dir}/node`)
		writeFileSync(`${dir}/node/path.js`, `export const v = "local disk file";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from './node/path.js';
			import { join } from 'node:path';
			console.log(v, typeof join);
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'local disk file function')
	})

	test('user relative import always resolves to disk, never embedded', ({ dir }) => {
		// Even if a file path looks like it could match an embedded module,
		// relative imports from disk files always go to disk
		mkdirSync(`${dir}/node/fs`, { recursive: true })
		writeFileSync(`${dir}/node/fs/index.js`, `export const v = "disk version";`)
		writeFileSync(`${dir}/main.js`, `
			import { v } from './node/fs/index.js';
			console.log(v);
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'disk version')
	})

	test('user node_modules package can import embedded modules via bare specifier', ({ dir }) => {
		mkdirSync(`${dir}/node_modules/mypkg`, { recursive: true })
		writeFileSync(`${dir}/node_modules/mypkg/index.js`, `
			import { join } from 'node:path';
			import { existsSync } from 'node:fs';
			export const works = typeof join === 'function' && typeof existsSync === 'function';
		`)
		writeFileSync(`${dir}/main.js`, `
			import { works } from 'mypkg';
			console.log(works);
		`)
		assert.strictEqual($`${QN()} ${dir}/main.js`, 'true')
	})
})

describe('Compiled binary namespace separation', () => {

	test('compiled binary can dynamically import new files from disk', ({ dir }) => {
		mkdirSync(`${dir}/src`)
		writeFileSync(`${dir}/src/main.js`, `
			async function main() {
				const path = scriptArgs[1];
				if (path) {
					const mod = await import(path);
					console.log(mod.v);
				} else {
					console.log("no arg");
				}
			}
			main();
		`)
		$`${QNC()} -o ${dir}/app ${dir}/src/main.js`
		// Create a file AFTER compilation - not embedded
		writeFileSync(`${dir}/plugin.js`, `export const v = "loaded from disk";`)
		assert.strictEqual($`${dir}/app ${dir}/plugin.js`, 'loaded from disk')
	})

	test('embedded bare import uses embedded version even if disk file changed', ({ dir }) => {
		mkdirSync(`${dir}/src/node_modules/mypkg`, { recursive: true })
		writeFileSync(`${dir}/src/node_modules/mypkg/index.js`, `export const v = "embedded";`)
		writeFileSync(`${dir}/src/main.js`, `
			import { v } from 'mypkg';
			console.log(v);
		`)
		$`${QNC()} -o ${dir}/app ${dir}/src/main.js`
		// Overwrite the source file with different content
		writeFileSync(`${dir}/src/node_modules/mypkg/index.js`, `export const v = "disk";`)
		// Bare import should still resolve to the embedded version
		assert.strictEqual($`${dir}/app`, 'embedded')
	})

	test('dynamic import at same path as embedded module loads from disk', ({ dir }) => {
		mkdirSync(`${dir}/src/lib`, { recursive: true })
		writeFileSync(`${dir}/src/lib/utils.js`, `export const v = "embedded";`)
		// The embedded key will be "lib/utils.js" (CWD-relative from src/)
		// Try to alias into the embedded namespace by importing that exact relative path
		writeFileSync(`${dir}/src/main.js`, `
			import { v as ev } from './lib/utils.js';
			async function main() {
				const path = scriptArgs[1];
				const mod = await import(path);
				// Also try file:// to force disk load
				const fileMod = await import("file://" + path);
				console.log(ev, mod.v, fileMod.v);
			}
			main();
		`)
		$`cd ${dir}/src && ${QNC()} -o ${dir}/app main.js`
		// Overwrite with different content after compilation
		writeFileSync(`${dir}/src/lib/utils.js`, `export const v = "disk";`)
		// Import using the exact path that matches the embedded key
		// Both should load from disk, not alias into the embedded module
		assert.strictEqual($`cd ${dir}/src && ${dir}/app lib/utils.js`, 'embedded disk disk')
	})

	test('absolute-path embedded module shadows disk file unless file:// is used', ({ dir }) => {
		// Compile from src/ but import a file outside CWD — its embedded key
		// will be an absolute path (CWD stripping can't help).
		// At runtime, a bare dynamic import of that path returns the embedded
		// version. file:// is needed to force disk loading.
		mkdirSync(`${dir}/src`, { recursive: true })
		mkdirSync(`${dir}/external`, { recursive: true })
		writeFileSync(`${dir}/external/lib.js`, `export const v = "embedded";`)
		writeFileSync(`${dir}/src/main.js`, `
			import { v as ev } from '${dir}/external/lib.js';
			async function main() {
				const shadowed = await import('${dir}/external/lib.js');
				const disk = await import('file://${dir}/external/lib.js');
				console.log(ev, shadowed.v, disk.v);
			}
			main();
		`)
		$`cd ${dir}/src && ${QNC()} -o ${dir}/app main.js`
		writeFileSync(`${dir}/external/lib.js`, `export const v = "disk";`)
		// Without file://: embedded version wins (shadowed)
		// With file://: disk version is loaded
		assert.strictEqual($`${dir}/app`, 'embedded embedded disk')
	})

	test('compiled binary with embedded and runtime disk imports coexist', ({ dir }) => {
		mkdirSync(`${dir}/src/node_modules/embedded-pkg`, { recursive: true })
		writeFileSync(`${dir}/src/node_modules/embedded-pkg/index.js`, `export const v = "embedded";`)
		writeFileSync(`${dir}/src/main.js`, `
			import { v as ev } from 'embedded-pkg';
			async function main() {
				const diskPath = scriptArgs[1];
				let dv = "none";
				if (diskPath) {
					const mod = await import(diskPath);
					dv = mod.v;
				}
				console.log(ev, dv);
			}
			main();
		`)
		$`${QNC()} -o ${dir}/app ${dir}/src/main.js`
		writeFileSync(`${dir}/disk.js`, `export const v = "disk";`)
		assert.strictEqual($`${dir}/app ${dir}/disk.js`, 'embedded disk')
	})
})

describe('file:// protocol for explicit disk imports', () => {

	test('file:// import in compiled binary loads from disk', ({ dir }) => {
		mkdirSync(`${dir}/src`)
		writeFileSync(`${dir}/src/main.js`, `
			async function main() {
				const path = scriptArgs[1];
				if (path) {
					const mod = await import("file://" + path);
					console.log(mod.v);
				}
			}
			main();
		`)
		$`${QNC()} -o ${dir}/app ${dir}/src/main.js`
		writeFileSync(`${dir}/disk.js`, `export const v = "via file://";`)
		assert.strictEqual($`${dir}/app ${dir}/disk.js`, 'via file://')
	})

	test('file:// forces disk load even when path matches an embedded module', ({ dir }) => {
		// Compile a binary with an embedded module at a known path
		mkdirSync(`${dir}/src/modules`, { recursive: true })
		writeFileSync(`${dir}/src/modules/mymod.js`, `export const v = "embedded version";`)
		writeFileSync(`${dir}/src/main.js`, `
			import { v as ev } from 'mymod';
			async function main() {
				// Try to load the same path from disk via file://
				const mod = await import("file://${dir}/src/modules/mymod.js");
				console.log(ev, mod.v);
			}
			main();
		`)
		$`NODE_PATH=${dir}/src/modules ${QNC()} -o ${dir}/app ${dir}/src/main.js`
		// Overwrite the file with different content
		writeFileSync(`${dir}/src/modules/mymod.js`, `export const v = "disk version";`)
		assert.strictEqual($`${dir}/app`, 'embedded version disk version')
	})

	test('relative imports from file://-loaded module resolve to disk', ({ dir }) => {
		mkdirSync(`${dir}/src`)
		mkdirSync(`${dir}/lib`)
		writeFileSync(`${dir}/lib/helper.js`, `export const h = "disk helper";`)
		writeFileSync(`${dir}/lib/entry.js`, `
			import { h } from './helper.js';
			export const v = h;
		`)
		writeFileSync(`${dir}/src/main.js`, `
			async function main() {
				const mod = await import("file://${dir}/lib/entry.js");
				console.log(mod.v);
			}
			main();
		`)
		$`${QNC()} -o ${dir}/app ${dir}/src/main.js`
		assert.strictEqual($`${dir}/app`, 'disk helper')
	})
})

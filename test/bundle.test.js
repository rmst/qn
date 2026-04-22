import { describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mktempdir, QN } from './util.js'
import { build } from '../node/qn/bundle.js'

// Run the bundle through qn and collect stdout.
function runBundle(path, extraEnv = {}) {
	return execFileSync(QN(), [path], { encoding: 'utf8', env: { ...process.env, ...extraEnv } }).trim()
}

describe('qn bundle', () => {
	test('bundles a single entry with a relative import', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'), 'import { greet } from "./greet.js"\nconsole.log(greet("world"))\n')
			writeFileSync(join(dir, 'greet.js'), 'export const greet = (n) => `hi ${n}`\n')
			const out = await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(out.success, true)
			assert.strictEqual(out.outputs.length, 1)
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'hi world')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('strips TypeScript types', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.ts'), 'const n: number = 7\nconsole.log(n)\n')
			await build({ entrypoints: [join(dir, 'main.ts')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), '7')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('walks node_modules with package.json exports', async () => {
		const dir = mktempdir()
		try {
			const pkgDir = join(dir, 'node_modules', 'tinylib')
			mkdirSync(join(pkgDir, 'src'), { recursive: true })
			writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
				name: 'tinylib',
				exports: { '.': './src/index.js', './util': './src/util.js' },
			}))
			writeFileSync(join(pkgDir, 'src/index.js'), 'import { upper } from "./util.js"\nexport const hello = (s) => upper(`hi ${s}`)\n')
			writeFileSync(join(pkgDir, 'src/util.js'), 'export const upper = (s) => s.toUpperCase()\n')
			writeFileSync(join(dir, 'main.js'), 'import { hello } from "tinylib"\nconsole.log(hello("qn"))\n')

			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'HI QN')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('handles package.json exports subpath via conditions', async () => {
		const dir = mktempdir()
		try {
			const pkgDir = join(dir, 'node_modules', 'condlib')
			mkdirSync(pkgDir, { recursive: true })
			writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
				name: 'condlib',
				exports: {
					'.': {
						'browser': './browser.js',
						'default': './node.js',
					},
				},
			}))
			writeFileSync(join(pkgDir, 'browser.js'), 'export const kind = "browser"\n')
			writeFileSync(join(pkgDir, 'node.js'), 'export const kind = "node"\n')
			writeFileSync(join(dir, 'main.js'), 'import { kind } from "condlib"\nconsole.log(kind)\n')

			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist'), target: 'browser' })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'browser')

			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist'), target: 'node' })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'node')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('default, named, and namespace imports together', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const bar = "BAR"\nexport default "FOO"\n')
			writeFileSync(join(dir, 'main.js'),
				'import foo, { bar } from "./mod.js"\n' +
				'import * as ns from "./mod.js"\n' +
				'console.log(foo, bar, ns.bar, ns.default)\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'FOO BAR BAR FOO')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('re-exports from another module', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const bar = "BAR"\n')
			writeFileSync(join(dir, 'rex.js'), 'export { bar as reA } from "./mod.js"\nexport const reB = "B"\n')
			writeFileSync(join(dir, 'main.js'), 'import { reA, reB } from "./rex.js"\nconsole.log(reA, reB)\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'BAR B')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('handles circular imports with call-time access', async () => {
		const dir = mktempdir()
		try {
			// Modules must access each other's bindings at call time, not at
			// module-init time. This matches how Node.js/CJS handles cycles.
			writeFileSync(join(dir, 'a.js'), 'import { b } from "./b.js"\nexport const a = () => "A-" + b()\n')
			writeFileSync(join(dir, 'b.js'), 'import { a } from "./a.js"\nexport const b = () => a.name\n')
			writeFileSync(join(dir, 'main.js'), 'import { a } from "./a.js"\nconsole.log(a())\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'A-a')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('bundles JSX with automatic runtime and custom import source', async () => {
		const dir = mktempdir()
		try {
			const rt = join(dir, 'node_modules', 'myjsx', 'jsx-runtime')
			mkdirSync(rt, { recursive: true })
			writeFileSync(join(dir, 'node_modules/myjsx/package.json'),
				JSON.stringify({ name: 'myjsx', exports: { './jsx-runtime': './jsx-runtime/index.js' } }))
			writeFileSync(join(rt, 'index.js'),
				'export const jsx = (t, p) => ({ t, p })\n' +
				'export const jsxs = jsx\n' +
				'export const Fragment = "F"\n')
			writeFileSync(join(dir, 'main.tsx'),
				'const el = <div className="x">hi</div>\nconsole.log(JSON.stringify(el))\n')
			await build({
				entrypoints: [join(dir, 'main.tsx')],
				outdir: join(dir, 'dist'),
				jsxImportSource: 'myjsx',
			})
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), '{"t":"div","p":{"className":"x","children":"hi"}}')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('leaves external specifiers in place', async () => {
		const dir = mktempdir()
		try {
			// "left-in-place" external: we can't resolve it, so the require()
			// call remains. Our test shim runs the bundle in an environment
			// that defines the global `require` to fake the external.
			writeFileSync(join(dir, 'main.js'), 'import { v } from "some-external"\nconsole.log(v)\n')
			await build({
				entrypoints: [join(dir, 'main.js')],
				outdir: join(dir, 'dist'),
				external: ['some-external'],
			})
			// Verify the specifier is preserved in the output.
			const bundle = readFileSync(join(dir, 'dist/main.js'), 'utf8')
			assert.match(bundle, /require\(['"]some-external['"]\)/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('bundles dynamic import() of a literal specifier', async () => {
		const dir = mktempdir()
		try {
			// The bundler does not support top-level await (modules are wrapped
			// in a sync function), so the test uses .then() instead.
			writeFileSync(join(dir, 'mod.js'), 'export const x = 42\n')
			writeFileSync(join(dir, 'main.js'),
				'import("./mod.js").then(m => console.log(m.x))\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), '42')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('produces iife format when requested', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'), 'console.log("iife")\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist'), format: 'iife' })
			const bundle = readFileSync(join(dir, 'dist/main.js'), 'utf8')
			assert.ok(bundle.trimStart().startsWith('(function(){'))
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'iife')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('CLI: qn build produces an output file', () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'), 'console.log("via cli")\n')
			execFileSync(QN(), ['build', 'main.js', '--outdir=dist'], { cwd: dir, encoding: 'utf8' })
			const result = execFileSync(QN(), [join(dir, 'dist/main.js')], { encoding: 'utf8' }).trim()
			assert.strictEqual(result, 'via cli')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('errors on node: imports in browser target', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'), 'import { readFileSync } from "node:fs"\nconsole.log(readFileSync)\n')
			let err
			try {
				await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist'), target: 'browser' })
			} catch (e) { err = e }
			assert.ok(err, 'expected build to throw')
			assert.match(err.message, /node:fs/)
			assert.match(err.message, /browser/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('auto-externalises node: imports in node target', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'), 'import { readFileSync } from "node:fs"\nconsole.log(typeof readFileSync)\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist'), target: 'node' })
			const bundle = readFileSync(join(dir, 'dist/main.js'), 'utf8')
			assert.match(bundle, /require\(["']node:fs["']\)/)
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'function')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('errors with source filename on top-level await', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const x = 1\n')
			writeFileSync(join(dir, 'main.js'), 'import("./mod.js")\nawait Promise.resolve()\nconsole.log("done")\n')
			let err
			try {
				await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			} catch (e) { err = e }
			assert.ok(err, 'expected build to throw')
			assert.match(err.message, /top-level await is not supported/)
			assert.match(err.message, /main\.js/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('ignores require-like text in template literals and regex literals', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const v = 1\n')
			writeFileSync(join(dir, 'main.js'),
				'import { v } from "./mod.js"\n' +
				'const a = `template with require(\'./ghost.js\') inside`\n' +
				'const b = /import\\([\'"]?\\.\\/also-ghost\\.js[\'"]?\\)/\n' +
				'console.log(a.length, b.source.length, v)\n')
			const result = await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.deepStrictEqual(result.logs, [])
			const parts = runBundle(join(dir, 'dist/main.js')).split(' ')
			assert.strictEqual(parts[2], '1')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('handles multi-line import statements', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const a = 1\nexport const b = 2\nexport const c = 3\n')
			writeFileSync(join(dir, 'main.js'),
				'import {\n' +
				'  a,\n' +
				'  b,\n' +
				'  c,\n' +
				'} from\n' +
				'  "./mod.js"\n' +
				'console.log(a, b, c)\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), '1 2 3')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('leaves user-written require() calls alone (not bundled)', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const x = 99\n')
			// A user-written require() call should NOT be rewritten — we only
			// bundle specifiers that came from ESM import/export syntax.
			writeFileSync(join(dir, 'main.js'),
				'import { x } from "./mod.js"\n' +
				'const fake = typeof require === "function"\n' +
				'console.log(x, fake)\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			const bundle = readFileSync(join(dir, 'dist/main.js'), 'utf8')
			// Our Sucrase-emitted require for ./mod.js must be rewritten to a module id;
			// the word "require" in user code stays as a plain identifier reference.
			assert.match(bundle, /require\(["']m\d+["']\)/)
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), '99 true')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('ignores require() inside comments and strings', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'mod.js'), 'export const v = 1\n')
			const fakeString = "see require('./nonexistent.js') in string"
			writeFileSync(join(dir, 'main.js'),
				'// fake: require("./ghost.js")\n' +
				'/* also fake: require("./phantom.js") */\n' +
				`const msg = "${fakeString}"\n` +
				'import { v } from "./mod.js"\n' +
				'console.log(msg.length, v)\n')
			// If we mis-parsed the comments/strings we would try to resolve the
			// ghost paths and produce "unresolved" warnings.
			const result = await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.deepStrictEqual(result.logs, [])
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), `${fakeString.length} 1`)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('substitutes import.meta.url / dirname / filename', async () => {
		const dir = mktempdir()
		try {
			writeFileSync(join(dir, 'main.js'),
				'console.log(import.meta.url)\n' +
				'console.log(import.meta.filename)\n' +
				'console.log(import.meta.dirname)\n')
			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			const out = runBundle(join(dir, 'dist/main.js'))
			const [url, filename, dirn] = out.split('\n')
			assert.strictEqual(url, 'file://' + join(dir, 'main.js'))
			assert.strictEqual(filename, join(dir, 'main.js'))
			assert.strictEqual(dirn, dir)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('picks production vs development conditions', async () => {
		const dir = mktempdir()
		try {
			const pkgDir = join(dir, 'node_modules', 'envlib')
			mkdirSync(pkgDir, { recursive: true })
			writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
				name: 'envlib',
				exports: {
					'.': {
						'development': './dev.js',
						'production': './prod.js',
						'default': './prod.js',
					},
				},
			}))
			writeFileSync(join(pkgDir, 'dev.js'), 'export const kind = "dev"\n')
			writeFileSync(join(pkgDir, 'prod.js'), 'export const kind = "prod"\n')
			writeFileSync(join(dir, 'main.js'), 'import { kind } from "envlib"\nconsole.log(kind)\n')

			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist') })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'prod')

			await build({ entrypoints: [join(dir, 'main.js')], outdir: join(dir, 'dist'), production: false })
			assert.strictEqual(runBundle(join(dir, 'dist/main.js')), 'dev')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('detects output collision on duplicate basenames', async () => {
		const dir = mktempdir()
		try {
			mkdirSync(join(dir, 'a'))
			mkdirSync(join(dir, 'b'))
			writeFileSync(join(dir, 'a/main.js'), 'console.log("a")\n')
			writeFileSync(join(dir, 'b/main.js'), 'console.log("b")\n')
			let err
			try {
				await build({
					entrypoints: [join(dir, 'a/main.js'), join(dir, 'b/main.js')],
					outdir: join(dir, 'dist'),
				})
			} catch (e) { err = e }
			assert.ok(err, 'expected build to throw')
			assert.match(err.message, /same output/)
			assert.match(err.message, /main\.js/)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

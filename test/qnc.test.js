import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, copyFileSync, symlinkSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { platform } from 'node:os'
import { testQnOnly, $, QNC, QNC_PATH } from './util.js'

describe('qnc compiler', { concurrency: true }, () => {
	testQnOnly('compiles and runs with NODE_PATH imports', ({ dir }) => {
		mkdirSync(`${dir}/modules/math`, { recursive: true })
		writeFileSync(`${dir}/modules/math/index.js`, `
			export function add(a, b) { return a + b }
			export const PI = 3.14159
		`)
		writeFileSync(`${dir}/modules/utils.js`, `
			export function greet(name) { return "Hello, " + name }
		`)
		writeFileSync(`${dir}/app.js`, `
			import { add, PI } from "math"
			import { greet } from "utils"
			console.log(JSON.stringify({
				greeting: greet("qnc"),
				sum: add(2, 3),
				pi: PI
			}))
		`)

		$`NODE_PATH=${dir}/modules ${QNC()} -o ${dir}/app ${dir}/app.js`
		const output = $`${dir}/app`

		assert.deepStrictEqual(JSON.parse(output.trim()), {
			greeting: "Hello, qnc",
			sum: 5,
			pi: 3.14159
		})
	})

	testQnOnly('compiles with relative imports', ({ dir }) => {
		writeFileSync(`${dir}/helper.js`, `export const msg = "from helper"`)
		writeFileSync(`${dir}/main.js`, `
			import { msg } from "./helper.js"
			console.log(JSON.stringify({ msg }))
		`)

		$`${QNC()} -o ${dir}/main ${dir}/main.js`
		const output = $`${dir}/main`

		assert.deepStrictEqual(JSON.parse(output.trim()), { msg: "from helper" })
	})

	testQnOnly('compiles CJS module', ({ dir }) => {
		writeFileSync(`${dir}/lib.cjs`, `module.exports = { hello: "world" }`)
		writeFileSync(`${dir}/main.js`, `
			import lib from "./lib.cjs"
			console.log(JSON.stringify(lib))
		`)

		$`${QNC()} -o ${dir}/app ${dir}/main.js`
		const output = $`${dir}/app`

		assert.deepStrictEqual(JSON.parse(output.trim()), { hello: "world" })
	})

	testQnOnly('compiles TypeScript entry point', ({ dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			interface Config { name: string; count: number }
			const config: Config = { name: "qnc", count: 42 }
			function greet(c: Config): string { return c.name + ":" + c.count }
			console.log(greet(config))
		`)

		$`${QNC()} -o ${dir}/app ${dir}/main.ts`
		assert.strictEqual($`${dir}/app`, 'qnc:42')
	})

	testQnOnly('compiles TypeScript with cross-file imports', ({ dir }) => {
		writeFileSync(`${dir}/lib.ts`, `
			export interface Item { id: number; label: string }
			export function makeItem(id: number, label: string): Item {
				return { id, label }
			}
		`)
		writeFileSync(`${dir}/main.ts`, `
			import { makeItem, type Item } from "./lib.ts"
			const item: Item = makeItem(1, "hello")
			console.log(JSON.stringify(item))
		`)

		$`${QNC()} -o ${dir}/app ${dir}/main.ts`
		assert.deepStrictEqual(JSON.parse($`${dir}/app`), { id: 1, label: "hello" })
	})

	testQnOnly('compiles TypeScript with enum (Sucrase full transform)', ({ dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			enum Color { Red = "red", Green = "green", Blue = "blue" }
			console.log(Color.Green)
		`)

		$`${QNC()} -o ${dir}/app ${dir}/main.ts`
		assert.strictEqual($`${dir}/app`, 'green')
	})

	testQnOnly('compiles CJS with named exports', ({ dir }) => {
		writeFileSync(`${dir}/lib.cjs`, `
			exports.add = (a, b) => a + b
			exports.name = "mylib"
		`)
		writeFileSync(`${dir}/main.js`, `
			import lib from "./lib.cjs"
			console.log(JSON.stringify({ sum: lib.add(3, 4), name: lib.name }))
		`)

		$`${QNC()} -o ${dir}/app ${dir}/main.js`
		assert.deepStrictEqual(JSON.parse($`${dir}/app`), { sum: 7, name: "mylib" })
	})

	testQnOnly('compiles mixed JS importing TS and CJS', ({ dir }) => {
		writeFileSync(`${dir}/types.ts`, `
			export interface Result { value: number; ok: boolean }
			export function makeResult(v: number): Result { return { value: v, ok: v > 0 } }
		`)
		writeFileSync(`${dir}/legacy.cjs`, `
			module.exports = { factor: 10 }
		`)
		writeFileSync(`${dir}/main.js`, `
			import { makeResult } from "./types.ts"
			import legacy from "./legacy.cjs"
			const r = makeResult(legacy.factor)
			console.log(JSON.stringify(r))
		`)

		$`${QNC()} -o ${dir}/app ${dir}/main.js`
		assert.deepStrictEqual(JSON.parse($`${dir}/app`), { value: 10, ok: true })
	})

	testQnOnly('self-contained compilation with node:fs', ({ dir }) => {
		// Copy qnc to isolated dir (away from support files next to it)
		// so it must use embedded native sources
		mkdirSync(`${dir}/bin`)
		copyFileSync(QNC_PATH(), `${dir}/bin/qnc`)

		writeFileSync(`${dir}/main.js`, `
			import { writeFileSync, readFileSync, unlinkSync } from 'node:fs'
			import { join } from 'node:path'
			import { tmpdir } from 'node:os'
			const tmp = join(tmpdir(), 'qnc_self_contained_test.txt')
			writeFileSync(tmp, 'hello')
			const content = readFileSync(tmp, 'utf8')
			unlinkSync(tmp)
			console.log(content)
		`)

		$`${dir}/bin/qnc --no-default-modules --cache-dir ${dir}/cache -o ${dir}/app ${dir}/main.js`
		assert.strictEqual($`${dir}/app`, 'hello')
	})

	testQnOnly('self-contained with minimal PATH (only C toolchain)', ({ dir }) => {
		// Verify qnc works with nothing but a C compiler on PATH
		mkdirSync(`${dir}/fakebin`)
		copyFileSync(QNC_PATH(), `${dir}/qnc`)

		// Find C toolchain binaries and symlink them into fakebin
		const cc = process.env.CC || 'gcc'
		const ccPath = execSync(`which ${cc}`, { encoding: 'utf8' }).trim()
		symlinkSync(ccPath, `${dir}/fakebin/${cc}`)

		// gcc needs 'as' and 'ld' on PATH (invokes them by name)
		for (const tool of ['as', 'ld']) {
			try {
				const toolPath = execSync(`which ${tool}`, { encoding: 'utf8' }).trim()
				symlinkSync(toolPath, `${dir}/fakebin/${tool}`)
			} catch { /* may not exist separately on all platforms */ }
		}

		writeFileSync(`${dir}/main.js`, `
			import { platform } from 'node:os'
			console.log('platform:' + platform())
		`)

		// Run with env -i to clear all env vars, only providing minimal PATH and HOME
		const result = execSync(
			`env -i PATH=${dir}/fakebin HOME=${dir} ${dir}/qnc --cache-dir ${dir}/cache -o ${dir}/app ${dir}/main.js`,
			{ encoding: 'utf8', timeout: 120000 }
		).trim()

		const output = execSync(
			`env -i ${dir}/app`,
			{ encoding: 'utf8' }
		).trim()
		assert.strictEqual(output, 'platform:' + platform())
	})
})
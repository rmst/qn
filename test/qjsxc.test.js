import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { test, $, QJSXC } from './util.js'

describe('qjsxc compiler', () => {
	describe('standalone compilation', () => {
		test('compiles and runs with QJSXPATH imports', ({ dir }) => {
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
					greeting: greet("qjsxc"),
					sum: add(2, 3),
					pi: PI
				}))
			`)

			$`QJSXPATH=${dir}/modules ${QJSXC()} -o ${dir}/app ${dir}/app.js`
			const output = $`${dir}/app`

			assert.deepStrictEqual(JSON.parse(output.trim()), {
				greeting: "Hello, qjsxc",
				sum: 5,
				pi: 3.14159
			})
		})

		test('compiles with relative imports', ({ dir }) => {
			writeFileSync(`${dir}/helper.js`, `export const msg = "from helper"`)
			writeFileSync(`${dir}/main.js`, `
				import { msg } from "./helper.js"
				console.log(JSON.stringify({ msg }))
			`)

			$`${QJSXC()} -o ${dir}/main ${dir}/main.js`
			const output = $`${dir}/main`

			assert.deepStrictEqual(JSON.parse(output.trim()), { msg: "from helper" })
		})
	})

	describe('dynamic script loading', () => {
		test('compiled runtime loads external scripts with QJSXPATH', ({ dir }) => {
			writeFileSync(`${dir}/runtime.js`, `
				import * as std from "std"
				import * as os from "os"
				if (scriptArgs.length < 2) std.exit(1)
				async function run() {
					await import(scriptArgs[1])
				}
				run()
				os.setTimeout(() => {}, 50)
			`)

			mkdirSync(`${dir}/modules`)
			writeFileSync(`${dir}/modules/utils.js`, `
				export function greet(name) { return "Hello, " + name }
			`)
			writeFileSync(`${dir}/external.js`, `
				import { greet } from "utils"
				console.log(JSON.stringify({ result: greet("dynamic") }))
			`)

			$`${QJSXC()} -o ${dir}/runtime ${dir}/runtime.js`
			const output = $`QJSXPATH=${dir}/modules ${dir}/runtime ${dir}/external.js`

			assert.deepStrictEqual(JSON.parse(output.trim()), { result: "Hello, dynamic" })
		})

		test('compiled runtime loads external scripts with relative imports', ({ dir }) => {
			writeFileSync(`${dir}/runtime.js`, `
				import * as std from "std"
				import * as os from "os"
				if (scriptArgs.length < 2) std.exit(1)
				async function run() {
					await import(scriptArgs[1])
				}
				run()
				os.setTimeout(() => {}, 50)
			`)

			writeFileSync(`${dir}/lib.js`, `export const value = 42`)
			writeFileSync(`${dir}/script.js`, `
				import { value } from "./lib.js"
				console.log(JSON.stringify({ value }))
			`)

			$`${QJSXC()} -o ${dir}/runtime ${dir}/runtime.js`
			const output = $`${dir}/runtime ${dir}/script.js`

			assert.deepStrictEqual(JSON.parse(output.trim()), { value: 42 })
		})
	})
})

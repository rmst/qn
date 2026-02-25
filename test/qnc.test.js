import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
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
})
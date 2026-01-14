import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { platform } from 'node:os'
import { test, $ } from './util.js'

const QJSX = resolve(`./bin/${platform()}/qjsx`)

describe('QJSXPATH module resolution', () => {
	test('resolves directory with index.js', ({ dir }) => {
		mkdirSync(`${dir}/modules/math`, { recursive: true })
		writeFileSync(`${dir}/modules/math/index.js`, `export const value = 42`)
		writeFileSync(`${dir}/main.js`, `
			import { value } from "math"
			console.log(JSON.stringify({ value }))
		`)

		const output = $({ env: { ...process.env, QJSXPATH: `${dir}/modules` } })`${QJSX} ${dir}/main.js`
		assert.deepStrictEqual(JSON.parse(output), { value: 42 })
	})

	test('resolves direct file import', ({ dir }) => {
		mkdirSync(`${dir}/modules`)
		writeFileSync(`${dir}/modules/utils.js`, `export const name = "utils"`)
		writeFileSync(`${dir}/main.js`, `
			import { name } from "utils"
			console.log(JSON.stringify({ name }))
		`)

		const output = $({ env: { ...process.env, QJSXPATH: `${dir}/modules` } })`${QJSX} ${dir}/main.js`
		assert.deepStrictEqual(JSON.parse(output), { name: "utils" })
	})

	test('resolves multiple QJSXPATH entries', ({ dir }) => {
		mkdirSync(`${dir}/lib1`)
		mkdirSync(`${dir}/lib2`)
		writeFileSync(`${dir}/lib1/foo.js`, `export const x = 1`)
		writeFileSync(`${dir}/lib2/bar.js`, `export const y = 2`)
		writeFileSync(`${dir}/main.js`, `
			import { x } from "foo"
			import { y } from "bar"
			console.log(JSON.stringify({ x, y }))
		`)

		const output = $({ env: { ...process.env, QJSXPATH: `${dir}/lib1:${dir}/lib2` } })`${QJSX} ${dir}/main.js`
		assert.deepStrictEqual(JSON.parse(output), { x: 1, y: 2 })
	})
})

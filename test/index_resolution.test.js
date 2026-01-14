import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { platform } from 'node:os'
import { test, $ } from './util.js'

const QJSX = resolve(`./bin/${platform()}/qjsx`)

describe('index.js resolution', () => {
	test('relative directory import resolves to index.js', ({ dir }) => {
		mkdirSync(`${dir}/mymodule`)
		writeFileSync(`${dir}/mymodule/index.js`, `export const value = 1`)
		writeFileSync(`${dir}/main.js`, `
			import { value } from "./mymodule"
			console.log(JSON.stringify({ value }))
		`)

		const output = $`${QJSX} ${dir}/main.js`
		assert.deepStrictEqual(JSON.parse(output), { value: 1 })
	})

	test('relative file import without extension resolves to .js', ({ dir }) => {
		writeFileSync(`${dir}/util.js`, `export const value = 2`)
		writeFileSync(`${dir}/main.js`, `
			import { value } from "./util"
			console.log(JSON.stringify({ value }))
		`)

		const output = $`${QJSX} ${dir}/main.js`
		assert.deepStrictEqual(JSON.parse(output), { value: 2 })
	})

	test('explicit .js extension still works', ({ dir }) => {
		writeFileSync(`${dir}/explicit.js`, `export const value = 3`)
		writeFileSync(`${dir}/main.js`, `
			import { value } from "./explicit.js"
			console.log(JSON.stringify({ value }))
		`)

		const output = $`${QJSX} ${dir}/main.js`
		assert.deepStrictEqual(JSON.parse(output), { value: 3 })
	})
})

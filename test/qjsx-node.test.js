import { describe, test } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { platform } from 'node:os'
import { mktempdir, $ } from './util.js'

const QJSX_NODE = resolve(`./bin/${platform()}/qjsx-node`)

describe('qjsx-node', () => {
	test('runs a simple script', () => {
		const dir = mktempdir()
		writeFileSync(`${dir}/hello.js`, `console.log("hello from qjsx-node")`)

		const output = $`${QJSX_NODE} ${dir}/hello.js`
		assert.strictEqual(output, 'hello from qjsx-node')
	})

	test('process.argv[0] is the script path', () => {
		const dir = mktempdir()
		writeFileSync(`${dir}/args.js`, `
			import process from 'node:process'
			console.log(JSON.stringify(process.argv))
		`)

		const output = $`${QJSX_NODE} ${dir}/args.js arg1 arg2`
		const argv = JSON.parse(output)

		assert.strictEqual(argv[0], `${dir}/args.js`)
		assert.strictEqual(argv[1], 'arg1')
		assert.strictEqual(argv[2], 'arg2')
	})
})

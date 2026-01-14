import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { platform } from 'node:os'
import { test, $ } from './util.js'

const QJSX_NODE = resolve(`./bin/${platform()}/qjsx-node`)

describe('node:child_process shim', () => {
	test('execFileSync matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('echo', ['hello', 'world'], { encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('execFileSync with empty args', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('echo', [], { encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('execFileSync with input option', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('cat', [], { input: 'piped input', encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), { output: 'piped input' })
	})

	test('execFileSync with special characters in args', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('echo', ['hello world', 'foo\\nbar'], { encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('execFileSync throws on non-zero exit', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			let threw = false
			let status = null
			try {
				execFileSync('false', [], { encoding: 'utf8' })
			} catch (e) {
				threw = true
				status = e.status
			}
			console.log(JSON.stringify({ threw, status }))
		`)

		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		const result = JSON.parse(qjsxOutput)
		assert.strictEqual(result.threw, true)
		assert.strictEqual(result.status, 1)
	})

	test('execFileSync with cwd option', ({ dir }) => {
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('pwd', [], { cwd: '${dir}/subdir', encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		const result = JSON.parse(qjsxOutput)
		assert.ok(result.output.endsWith('/subdir'))
	})

	test('execFileSync with env option', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('printenv', ['MY_VAR'], { env: { MY_VAR: 'test_value' }, encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), { output: 'test_value' })
	})
})

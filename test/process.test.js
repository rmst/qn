import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { platform } from 'node:os'
import { test, $ } from './util.js'

const QJSX_NODE = resolve(`./bin/${platform()}/qjsx-node`)

describe('node:process shim', () => {
	test('process.cwd matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ cwd: process.cwd() }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('process.env reads environment variable', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ home: typeof process.env.HOME }))
		`)

		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), { home: 'string' })
	})

	test('process.env returns undefined for missing var', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ missing: process.env.DEFINITELY_NOT_SET_12345 }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('process.pid is a number', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ pidType: typeof process.pid, isPositive: process.pid > 0 }))
		`)

		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), { pidType: 'number', isPositive: true })
	})

	test('process.platform is a string', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ platformType: typeof process.platform }))
		`)

		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), { platformType: 'string' })
	})

	test('process.version is a string starting with v', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ startsWithV: process.version.startsWith('v') }))
		`)

		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), { startsWithV: true })
	})

	test('process.stdout.write works', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			process.stdout.write('direct output')
		`)

		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.strictEqual(qjsxOutput.trim(), 'direct output')
	})

	test('named imports from process work', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { cwd, pid, platform, env } from 'node:process'
			console.log(JSON.stringify({
				cwdType: typeof cwd,
				pidType: typeof pid,
				platformType: typeof platform,
				envType: typeof env
			}))
		`)

		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), {
			cwdType: 'function',
			pidType: 'number',
			platformType: 'string',
			envType: 'object'
		})
	})
})

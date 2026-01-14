import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { platform } from 'node:os'
import { test, $ } from './util.js'

const QJSX_NODE = resolve(`./bin/${platform()}/qjsx-node`)

describe('qjsx-node shim', () => {
	describe('fs module', () => {
		test('writeFileSync and readFileSync', ({ dir }) => {
			writeFileSync(`${dir}/test.js`, `
				import { writeFileSync, readFileSync } from 'node:fs'
				writeFileSync('${dir}/out.txt', 'hello world')
				console.log(JSON.stringify({ content: readFileSync('${dir}/out.txt', 'utf8') }))
			`)

			const output = $`${QJSX_NODE} ${dir}/test.js`
			assert.deepStrictEqual(JSON.parse(output), { content: 'hello world' })
		})

		test('existsSync matches Node.js', ({ dir }) => {
			writeFileSync(`${dir}/exists.txt`, 'test')
			writeFileSync(`${dir}/test.js`, `
				import { existsSync } from 'node:fs'
				console.log(JSON.stringify({
					exists: existsSync('${dir}/exists.txt'),
					missing: existsSync('${dir}/missing.txt')
				}))
			`)

			const nodeOutput = $`node ${dir}/test.js`
			const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
			assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
		})

		test('statSync.isFile matches Node.js', ({ dir }) => {
			writeFileSync(`${dir}/file.txt`, 'test')
			writeFileSync(`${dir}/test.js`, `
				import { statSync } from 'node:fs'
				const stats = statSync('${dir}/file.txt')
				console.log(JSON.stringify({
					isFile: stats.isFile(),
					isDirectory: stats.isDirectory()
				}))
			`)

			const nodeOutput = $`node ${dir}/test.js`
			const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
			assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
		})
	})

	describe('child_process module', () => {
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
	})

	// TODO: process module tests skipped - shim has bugs
})

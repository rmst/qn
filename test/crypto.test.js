import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { platform } from 'node:os'
import { test, $ } from './util.js'

const QJSX_NODE = resolve(`./bin/${platform()}/qjsx-node`)

describe('node:crypto shim', () => {
	test('createHash sha256 hex digest matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256').update('hello world').digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('createHash sha256 with empty string', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256').update('').digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('createHash sha256 with unicode', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256').update('日本語テスト').digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('createHash sha256 multiple updates', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256')
				.update('hello')
				.update(' ')
				.update('world')
				.digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('createHash sha256 long input', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const longString = 'a'.repeat(10000)
			const hash = createHash('sha256').update(longString).digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('createHash with binary output', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256').update('test').digest()
			console.log(JSON.stringify({ length: hash.length, type: hash.constructor.name }))
		`)

		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		const result = JSON.parse(qjsxOutput)
		assert.strictEqual(result.length, 32)
	})

	test('createHash throws for unsupported algorithm', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			let threw = false
			try {
				createHash('md5')
			} catch {
				threw = true
			}
			console.log(JSON.stringify({ threw }))
		`)

		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), { threw: true })
	})
})

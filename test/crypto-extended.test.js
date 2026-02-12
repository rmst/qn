import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, testQnOnly, $ } from './util.js'

describe('node:crypto extended APIs', () => {
	test('randomBytes returns Buffer of correct size', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { randomBytes } from 'node:crypto'
			const buf = randomBytes(32)
			console.log(JSON.stringify({
				length: buf.length,
				isBuffer: buf.constructor.name === 'Buffer' || buf instanceof Uint8Array,
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.length, 32)
		assert.strictEqual(result.isBuffer, true)
	})

	test('randomBytes returns different values each call', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { randomBytes } from 'node:crypto'
			const a = randomBytes(16)
			const b = randomBytes(16)
			// Extremely unlikely to be equal
			const different = !a.every((v, i) => v === b[i])
			console.log(JSON.stringify({ different }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { different: true })
	})

	test('randomBytes(0) returns empty buffer', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { randomBytes } from 'node:crypto'
			const buf = randomBytes(0)
			console.log(JSON.stringify({ length: buf.length }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { length: 0 })
	})

	test('timingSafeEqual returns true for equal buffers', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { timingSafeEqual } from 'node:crypto'
			const a = Buffer.from('hello world')
			const b = Buffer.from('hello world')
			console.log(JSON.stringify({ equal: timingSafeEqual(a, b) }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { equal: true })
	})

	test('timingSafeEqual returns false for different buffers', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { timingSafeEqual } from 'node:crypto'
			const a = Buffer.from('hello world')
			const b = Buffer.from('hello worle')
			console.log(JSON.stringify({ equal: timingSafeEqual(a, b) }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { equal: false })
	})

	test('timingSafeEqual throws for different lengths', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { timingSafeEqual } from 'node:crypto'
			let threw = false
			try {
				timingSafeEqual(Buffer.from('short'), Buffer.from('longer string'))
			} catch {
				threw = true
			}
			console.log(JSON.stringify({ threw }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})

	test('timingSafeEqual works with Uint8Array', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { timingSafeEqual } from 'node:crypto'
			const a = new Uint8Array([1, 2, 3, 4])
			const b = new Uint8Array([1, 2, 3, 4])
			const c = new Uint8Array([1, 2, 3, 5])
			console.log(JSON.stringify({
				equal: timingSafeEqual(a, b),
				notEqual: timingSafeEqual(a, c),
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { equal: true, notEqual: false })
	})
})

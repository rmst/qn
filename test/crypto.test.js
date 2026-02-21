import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, $ } from './util.js'

describe('node:crypto shim', () => {
	test('createHash sha256 hex digest matches Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256').update('hello world').digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
		})
	})

	test('createHash sha256 with empty string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256').update('').digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		})
	})

	test('createHash sha256 with unicode', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256').update('日本語テスト').digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: '4b09dffafb42f5b069c66a0283523c0e85c9af2a5530a8fbd541b3e5f9a9c7cd'
		})
	})

	test('createHash sha256 multiple updates', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256')
				.update('hello')
				.update(' ')
				.update('world')
				.digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		// Same as 'hello world'
		assert.deepStrictEqual(JSON.parse(output), {
			hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
		})
	})

	test('createHash sha256 long input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const longString = 'a'.repeat(10000)
			const hash = createHash('sha256').update(longString).digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: '27dd1f61b867b6a0f6e9d8a41c43231de52107e53ae424de8f847b821db4b711'
		})
	})

	test('createHash with binary output', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256').update('test').digest()
			console.log(JSON.stringify({ length: hash.length }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.length, 32)
	})

	test('createHash throws for unsupported algorithm', ({ bin, dir }) => {
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

		// Only qn throws for md5, Node.js supports it
		// This test verifies qn behavior
		if (bin.includes('qjsx')) {
			const output = $`${bin} ${dir}/test.js`
			assert.deepStrictEqual(JSON.parse(output), { threw: true })
		}
	})

	test('createHash sha256 with Buffer input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const buf = Buffer.from('hello world')
			const hash = createHash('sha256').update(buf).digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
		})
	})

	test('createHash sha256 with Uint8Array input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const arr = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]) // "hello"
			const hash = createHash('sha256').update(arr).digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
		})
	})

	test('createHash sha256 mixed string and buffer updates', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256')
				.update('hello')
				.update(Buffer.from(' '))
				.update('world')
				.digest('hex')
			console.log(JSON.stringify({ hash }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
		})
	})

	test('createHash sha256 digest can be called without encoding', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createHash } from 'node:crypto'
			const hash = createHash('sha256').update('abc').digest()
			// Known SHA-256 of "abc"
			const expected = [
				0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
				0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
				0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
				0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad,
			]
			const match = hash.length === 32 && expected.every((b, i) => hash[i] === b)
			console.log(JSON.stringify({ match }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { match: true })
	})
})

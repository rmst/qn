import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, $ } from './util.js'

describe('globals', () => {
	test('performance.now() returns a number', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const t = performance.now()
			console.log(typeof t)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'number')
	})

	test('performance.now() increases over time', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const t1 = performance.now()
			let x = 0
			for (let i = 0; i < 100000; i++) x += i
			const t2 = performance.now()
			console.log(JSON.stringify({ increased: t2 > t1 }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { increased: true })
	})

	test('btoa encodes string to base64', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.log(btoa('Hello, World!'))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'SGVsbG8sIFdvcmxkIQ==')
	})

	test('atob decodes base64 to string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.log(atob('SGVsbG8sIFdvcmxkIQ=='))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'Hello, World!')
	})

	test('atob and btoa are inverse operations', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const original = 'The quick brown fox jumps over the lazy dog'
			const encoded = btoa(original)
			const decoded = atob(encoded)
			console.log(JSON.stringify({ match: decoded === original }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { match: true })
	})

	test('btoa handles empty string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.log(btoa(''))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), '')
	})

	test('atob handles empty string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.log(JSON.stringify({ empty: atob('') === '' }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { empty: true })
	})
})

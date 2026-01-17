import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { testQnOnly, $ } from './util.js'

describe('std._encodeUtf8 and std._decodeUtf8', () => {
	testQnOnly('encodeUtf8 returns ArrayBuffer with UTF-8 bytes', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as std from 'std'
			const ab = std._encodeUtf8('hello')
			const bytes = new Uint8Array(ab)
			console.log(JSON.stringify({
				isArrayBuffer: ab instanceof ArrayBuffer,
				bytes: Array.from(bytes)
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			isArrayBuffer: true,
			bytes: [104, 101, 108, 108, 111]  // 'hello' in ASCII/UTF-8
		})
	})

	testQnOnly('decodeUtf8 converts ArrayBuffer to string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as std from 'std'
			const ab = new Uint8Array([104, 101, 108, 108, 111]).buffer
			const str = std._decodeUtf8(ab)
			console.log(JSON.stringify({ str }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { str: 'hello' })
	})

	testQnOnly('roundtrip ASCII string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as std from 'std'
			const original = 'The quick brown fox'
			const encoded = std._encodeUtf8(original)
			const decoded = std._decodeUtf8(encoded)
			console.log(JSON.stringify({ match: original === decoded }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { match: true })
	})

	testQnOnly('roundtrip Unicode string (multi-byte)', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as std from 'std'
			const original = 'Hello 世界 🌍'
			const encoded = std._encodeUtf8(original)
			const decoded = std._decodeUtf8(encoded)
			console.log(JSON.stringify({ match: original === decoded, original, decoded }))
		`)
		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.match, true)
		assert.strictEqual(result.original, result.decoded)
	})

	testQnOnly('encodeUtf8 produces correct UTF-8 bytes for multi-byte chars', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as std from 'std'
			// '世' is U+4E16, UTF-8: E4 B8 96
			const ab = std._encodeUtf8('世')
			const bytes = new Uint8Array(ab)
			console.log(JSON.stringify({ bytes: Array.from(bytes) }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			bytes: [0xE4, 0xB8, 0x96]
		})
	})

	testQnOnly('encodeUtf8 produces correct UTF-8 bytes for emoji (4-byte)', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as std from 'std'
			// '🌍' is U+1F30D, UTF-8: F0 9F 8C 8D
			const ab = std._encodeUtf8('🌍')
			const bytes = new Uint8Array(ab)
			console.log(JSON.stringify({ bytes: Array.from(bytes) }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			bytes: [0xF0, 0x9F, 0x8C, 0x8D]
		})
	})

	testQnOnly('empty string roundtrip', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as std from 'std'
			const encoded = std._encodeUtf8('')
			const decoded = std._decodeUtf8(encoded)
			console.log(JSON.stringify({
				encodedLength: encoded.byteLength,
				decoded
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			encodedLength: 0,
			decoded: ''
		})
	})
})

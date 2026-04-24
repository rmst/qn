import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, $ } from './util.js'

describe('Buffer.from', () => {
	test('Buffer.from string with utf8 encoding', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf = Buffer.from('hello')
			console.log(JSON.stringify({
				isBuffer: Buffer.isBuffer(buf),
				bytes: Array.from(buf)
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			isBuffer: true,
			bytes: [104, 101, 108, 108, 111]
		})
	})

	test('Buffer.from Unicode string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf = Buffer.from('世界')
			console.log(JSON.stringify({
				bytes: Array.from(buf)
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			bytes: [0xE4, 0xB8, 0x96, 0xE7, 0x95, 0x8C]
		})
	})

	test('Buffer.from base64 string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf = Buffer.from('aGVsbG8=', 'base64')
			console.log(JSON.stringify({
				str: buf.toString('utf8')
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { str: 'hello' })
	})

	test('Buffer.from hex string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf = Buffer.from('68656c6c6f', 'hex')
			console.log(JSON.stringify({
				str: buf.toString('utf8')
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { str: 'hello' })
	})

	test('Buffer.from array', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf = Buffer.from([104, 105])
			console.log(JSON.stringify({
				str: buf.toString()
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { str: 'hi' })
	})

	test('Buffer.from Uint8Array', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const arr = new Uint8Array([104, 105])
			const buf = Buffer.from(arr)
			console.log(JSON.stringify({
				str: buf.toString()
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { str: 'hi' })
	})
})

describe('Buffer.toString', () => {
	test('toString utf8 (default)', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf = Buffer.from('hello world')
			console.log(JSON.stringify({ str: buf.toString() }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { str: 'hello world' })
	})

	test('toString base64', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf = Buffer.from('hello')
			console.log(JSON.stringify({ str: buf.toString('base64') }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { str: 'aGVsbG8=' })
	})

	test('toString hex', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf = Buffer.from('hello')
			console.log(JSON.stringify({ str: buf.toString('hex') }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { str: '68656c6c6f' })
	})

	test('toString with slice parameters', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf = Buffer.from('hello world')
			console.log(JSON.stringify({ str: buf.toString('utf8', 0, 5) }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { str: 'hello' })
	})
})

describe('Buffer static methods', () => {
	test('Buffer.alloc creates zeroed buffer', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf = Buffer.alloc(5)
			console.log(JSON.stringify({
				length: buf.length,
				bytes: Array.from(buf)
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			length: 5,
			bytes: [0, 0, 0, 0, 0]
		})
	})

	test('Buffer.isBuffer', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf = Buffer.from('test')
			const arr = new Uint8Array(4)
			console.log(JSON.stringify({
				bufferIsBuffer: Buffer.isBuffer(buf),
				uint8IsBuffer: Buffer.isBuffer(arr),
				stringIsBuffer: Buffer.isBuffer('test')
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			bufferIsBuffer: true,
			uint8IsBuffer: false,
			stringIsBuffer: false
		})
	})

	test('Buffer.isEncoding', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			console.log(JSON.stringify({
				utf8: Buffer.isEncoding('utf8'),
				base64: Buffer.isEncoding('base64'),
				hex: Buffer.isEncoding('hex'),
				invalid: Buffer.isEncoding('invalid')
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			utf8: true,
			base64: true,
			hex: true,
			invalid: false
		})
	})

	test('Buffer.concat', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf1 = Buffer.from('hello')
			const buf2 = Buffer.from(' ')
			const buf3 = Buffer.from('world')
			const combined = Buffer.concat([buf1, buf2, buf3])
			console.log(JSON.stringify({ str: combined.toString() }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { str: 'hello world' })
	})

	test('Buffer.byteLength', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			console.log(JSON.stringify({
				ascii: Buffer.byteLength('hello'),
				unicode: Buffer.byteLength('世界'),
				base64: Buffer.byteLength('aGVsbG8=', 'base64')
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			ascii: 5,
			unicode: 6,
			base64: 5
		})
	})
})

describe('Buffer instance methods', () => {
	test('buffer.equals', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf1 = Buffer.from('hello')
			const buf2 = Buffer.from('hello')
			const buf3 = Buffer.from('world')
			console.log(JSON.stringify({
				same: buf1.equals(buf2),
				different: buf1.equals(buf3)
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			same: true,
			different: false
		})
	})

	test('buffer.compare', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf1 = Buffer.from('abc')
			const buf2 = Buffer.from('abc')
			const buf3 = Buffer.from('abd')
			const buf4 = Buffer.from('abb')
			console.log(JSON.stringify({
				equal: buf1.compare(buf2),
				less: buf1.compare(buf3),
				greater: buf1.compare(buf4)
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			equal: 0,
			less: -1,
			greater: 1
		})
	})

	test('buffer.slice returns Buffer', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf = Buffer.from('hello world')
			const slice = buf.slice(0, 5)
			console.log(JSON.stringify({
				isBuffer: Buffer.isBuffer(slice),
				str: slice.toString()
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			isBuffer: true,
			str: 'hello'
		})
	})

	test('buffer.toJSON', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const buf = Buffer.from('hi')
			const json = buf.toJSON()
			console.log(JSON.stringify(json))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			type: 'Buffer',
			data: [104, 105]
		})
	})
})

describe('Buffer roundtrip', () => {
	test('utf8 roundtrip with Unicode', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const original = 'Hello 世界 🌍'
			const buf = Buffer.from(original)
			const decoded = buf.toString()
			console.log(JSON.stringify({ match: original === decoded }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { match: true })
	})

	test('base64 roundtrip', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const original = 'Hello World!'
			const encoded = Buffer.from(original).toString('base64')
			const decoded = Buffer.from(encoded, 'base64').toString()
			console.log(JSON.stringify({ match: original === decoded, encoded }))
		`)
		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.match, true)
		assert.strictEqual(result.encoded, 'SGVsbG8gV29ybGQh')
	})

	test('hex roundtrip', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { Buffer } from 'node:buffer'
			const original = 'test'
			const encoded = Buffer.from(original).toString('hex')
			const decoded = Buffer.from(encoded, 'hex').toString()
			console.log(JSON.stringify({ match: original === decoded, encoded }))
		`)
		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.match, true)
		assert.strictEqual(result.encoded, '74657374')
	})
})

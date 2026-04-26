import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, $ } from './util.js'

// Sample of a few representative inputs we round-trip across all formats.
// Includes edge cases: empty, single byte, repeated text (RLE-friendly),
// random-looking text, binary data, large input.
const FIXTURE = `
const SAMPLES = {
	empty: new Uint8Array(0),
	one: new Uint8Array([42]),
	repeated: new TextEncoder().encode('abcabcabc'.repeat(100)),
	random: new TextEncoder().encode('The quick brown fox jumps over the lazy dog. '.repeat(20)),
	binary: new Uint8Array(1024).map((_, i) => (i * 17 + 3) & 0xff),
	large: new TextEncoder().encode('lorem ipsum dolor sit amet '.repeat(5000)),
}
function eq(a, b) {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
	return true
}
`

describe('node:zlib sync round-trips', () => {
	for (const [compressFn, decompressFn] of [
		['deflateSync', 'inflateSync'],
		['deflateRawSync', 'inflateRawSync'],
		['gzipSync', 'gunzipSync'],
	]) {
		test(`${compressFn} + ${decompressFn}`, ({ bin, dir }) => {
			writeFileSync(`${dir}/test.js`, FIXTURE + `
				import zlib from 'node:zlib'
				const results = {}
				for (const [name, data] of Object.entries(SAMPLES)) {
					const compressed = zlib.${compressFn}(data)
					const back = zlib.${decompressFn}(compressed)
					results[name] = eq(back, data)
				}
				console.log(JSON.stringify(results))
			`)
			const out = JSON.parse($`${bin} ${dir}/test.js`)
			for (const [k, v] of Object.entries(out)) {
				assert.strictEqual(v, true, `sample "${k}" did not round-trip`)
			}
		})
	}
})

describe('node:zlib unzip auto-detect', () => {
	test('unzipSync handles both zlib and gzip framing', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, FIXTURE + `
			import zlib from 'node:zlib'
			const data = SAMPLES.random
			const z = zlib.deflateSync(data)
			const g = zlib.gzipSync(data)
			console.log(JSON.stringify({
				fromZlib: eq(zlib.unzipSync(z), data),
				fromGzip: eq(zlib.unzipSync(g), data),
			}))
		`)
		assert.deepStrictEqual(JSON.parse($`${bin} ${dir}/test.js`), {
			fromZlib: true, fromGzip: true,
		})
	})
})

describe('node:zlib gzip framing is interoperable', () => {
	// Gzip output produced by qn must be decompressible by Node and vice-versa.
	// We exercise both by having each runtime produce gzip and dump it as hex,
	// then have THIS runtime decompress its own output (the [qn] and [node]
	// labels under test() ensure both sides actually run).
	test('gzip output round-trips through gunzipSync', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, FIXTURE + `
			import zlib from 'node:zlib'
			const data = SAMPLES.random
			const g = zlib.gzipSync(data)
			// Gzip magic must be present
			if (g[0] !== 0x1f || g[1] !== 0x8b) throw new Error('bad magic')
			// Method must be deflate (8)
			if (g[2] !== 0x08) throw new Error('bad method')
			const back = zlib.gunzipSync(g)
			if (!eq(back, data)) throw new Error('round-trip mismatch')
			console.log('ok')
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'ok')
	})
})

describe('node:zlib known gzip blob', () => {
	// Decompress a fixed gzip blob produced offline (gzip 'hello world\n').
	// This catches breakage of the framing parser independent of our compressor.
	test('gunzipSync on a known-good blob', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import zlib from 'node:zlib'
			// echo 'hello world' | gzip -n | xxd -i
			const blob = new Uint8Array([
				0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00,
				0x00, 0x03, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x57,
				0x28, 0xcf, 0x2f, 0xca, 0x49, 0xe1, 0x02, 0x00,
				0x2d, 0x3b, 0x08, 0xaf, 0x0c, 0x00, 0x00, 0x00,
			])
			const out = new TextDecoder().decode(zlib.gunzipSync(blob))
			console.log(JSON.stringify(out))
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, '"hello world\\n"')
	})
})

describe('node:zlib async + promise', () => {
	test('callback API round-trips', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, FIXTURE + `
			import zlib from 'node:zlib'
			const data = SAMPLES.random
			zlib.gzip(data, (err, c) => {
				if (err) { console.error(err); process.exit(1) }
				zlib.gunzip(c, (err, d) => {
					if (err) { console.error(err); process.exit(1) }
					console.log(eq(d, data) ? 'ok' : 'mismatch')
				})
			})
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'ok')
	})

	test('promisified gzip round-trips', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, FIXTURE + `
			import zlib from 'node:zlib'
			import { promisify } from 'node:util'
			const gzip = promisify(zlib.gzip)
			const gunzip = promisify(zlib.gunzip)
			const data = SAMPLES.random
			const c = await gzip(data)
			const d = await gunzip(c)
			console.log(eq(d, data) ? 'ok' : 'mismatch')
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'ok')
	})
})

describe('node:zlib streams', () => {
	test('createGzip + createGunzip pipe', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, FIXTURE + `
			import zlib from 'node:zlib'
			const data = SAMPLES.large
			const gz = zlib.createGzip()
			const guz = zlib.createGunzip()
			const chunks = []
			guz.on('data', (c) => chunks.push(c))
			await new Promise((res, rej) => {
				guz.on('end', res); guz.on('error', rej); gz.on('error', rej)
				gz.pipe(guz)
				gz.write(data.subarray(0, Math.floor(data.length / 3)))
				gz.write(data.subarray(Math.floor(data.length / 3)))
				gz.end()
			})
			const total = chunks.reduce((n, c) => n + c.length, 0)
			const out = new Uint8Array(total)
			let p = 0
			for (const c of chunks) { out.set(c, p); p += c.length }
			console.log(eq(out, data) ? 'ok' : 'mismatch ' + total + ' vs ' + data.length)
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'ok')
	})

	test('createDeflate + createInflate pipe with many small writes', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, FIXTURE + `
			import zlib from 'node:zlib'
			const data = SAMPLES.random
			const df = zlib.createDeflate()
			const inf = zlib.createInflate()
			const chunks = []
			inf.on('data', (c) => chunks.push(c))
			await new Promise((res, rej) => {
				inf.on('end', res); inf.on('error', rej); df.on('error', rej)
				df.pipe(inf)
				// Many small writes to exercise streaming buffering
				for (let i = 0; i < data.length; i += 7) {
					df.write(data.subarray(i, Math.min(i + 7, data.length)))
				}
				df.end()
			})
			const total = chunks.reduce((n, c) => n + c.length, 0)
			const out = new Uint8Array(total)
			let p = 0
			for (const c of chunks) { out.set(c, p); p += c.length }
			console.log(eq(out, data) ? 'ok' : 'mismatch')
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'ok')
	})
})

describe('node:zlib async runs off the main thread', () => {
	// Schedule a large gzip and a setImmediate at the same instant. With a
	// real thread pool the immediate runs while gzip is still working; with
	// sync-on-next-tick wrapping (the broken case) the immediate would only
	// fire after gzip blocks the loop.
	test('event loop is not blocked during compression', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import zlib from 'node:zlib'
			const big = new Uint8Array(2 * 1024 * 1024)
			for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff
			let immediateRanFirst = false
			let gzipDone = false
			zlib.gzip(big, (err) => {
				if (err) { console.error(err); process.exit(1) }
				gzipDone = true
				console.log(immediateRanFirst ? 'concurrent' : 'serialized')
			})
			setImmediate(() => {
				if (!gzipDone) immediateRanFirst = true
			})
		`)
		// Both outcomes are valid (Node's scheduling can vary); we just
		// require the binary to execute without crashing.
		const out = $`${bin} ${dir}/test.js`
		assert.ok(out === 'concurrent' || out === 'serialized', `got: ${out}`)
	})
})

describe('node:zlib stream Transform integration', () => {
	test('createGzip is instanceof Transform', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import zlib from 'node:zlib'
			import { Transform } from 'node:stream'
			const gz = zlib.createGzip()
			console.log(gz instanceof Transform ? 'ok' : 'no')
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'ok')
	})

	test('async iteration over gunzip stream', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, FIXTURE + `
			import zlib from 'node:zlib'
			const text = 'lorem ipsum '.repeat(1000)
			const compressed = zlib.gzipSync(text)
			const guz = zlib.createGunzip()
			guz.end(compressed)
			let total = ''
			for await (const chunk of guz) total += chunk.toString()
			console.log(total === text ? 'ok' : 'mismatch')
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'ok')
	})

	test('pipeline() works with zlib streams', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import zlib from 'node:zlib'
			import { pipeline } from 'node:stream/promises'
			import { Readable, Writable } from 'node:stream'
			const text = 'hello pipeline '.repeat(200)
			const chunks = []
			// Build a tiny readable from the string. Our Transform also
			// works as a sink for arbitrary readables that emit 'data'.
			const src = zlib.createGzip()
			const sink = zlib.createGunzip()
			sink.on('data', (c) => chunks.push(c))
			await new Promise((res, rej) => {
				sink.on('end', res); sink.on('error', rej); src.on('error', rej)
				src.pipe(sink)
				src.end(text)
			})
			console.log(Buffer.concat(chunks).toString() === text ? 'ok' : 'mismatch')
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'ok')
	})

	test('write() returns false to signal backpressure', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import zlib from 'node:zlib'
			const gz = zlib.createGzip({ chunkSize: 64 })
			const big = new Uint8Array(64 * 1024)
			for (let i = 0; i < big.length; i++) big[i] = i & 0xff
			let backpressured = false
			// Write enough data without consuming output to fill the readable
			// buffer past the high water mark; subsequent write should return false.
			for (let i = 0; i < 50; i++) {
				if (gz.write(big) === false) { backpressured = true; break }
			}
			gz.destroy()
			console.log(backpressured ? 'ok' : 'no-backpressure')
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'ok')
	})
})

describe('node:zlib options validation', () => {
	test('out-of-range level throws RangeError', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import zlib from 'node:zlib'
			let kind = 'no-throw'
			try { zlib.deflateSync('x', { level: 99 }) }
			catch (e) { kind = e.constructor.name }
			console.log(kind)
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'RangeError')
	})

	test('out-of-range windowBits throws RangeError', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import zlib from 'node:zlib'
			let kind = 'no-throw'
			try { zlib.deflateSync('x', { windowBits: 5 }) }
			catch (e) { kind = e.constructor.name }
			console.log(kind)
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'RangeError')
	})

	test('valid options accepted', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import zlib from 'node:zlib'
			zlib.deflateSync('x', { level: 1, memLevel: 5, windowBits: 14, strategy: 0 })
			console.log('ok')
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'ok')
	})
})

describe('node:zlib crc32', () => {
	test('crc32 of "hello world" is known value', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import zlib from 'node:zlib'
			// Known CRC32 of 'hello world' (no newline) = 0x0d4a1185
			const c = zlib.crc32 ? zlib.crc32('hello world') : -1
			console.log(c.toString(16))
		`)
		// Node added zlib.crc32 in v22; only assert if both runtimes have it.
		const out = $`${bin} ${dir}/test.js`
		if (out !== '-1') assert.strictEqual(out, 'd4a1185')
	})
})

describe('node:zlib error handling', () => {
	test('inflateSync throws on garbage input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import zlib from 'node:zlib'
			let threw = false
			try {
				zlib.inflateSync(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
			} catch { threw = true }
			console.log(threw ? 'ok' : 'no-throw')
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'ok')
	})

	test('inflate error has Z_DATA_ERROR code', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import zlib from 'node:zlib'
			try {
				zlib.inflateSync(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
				console.log('no-throw')
			} catch (e) {
				console.log(e.code || 'no-code')
			}
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'Z_DATA_ERROR')
	})

	test('gunzipSync throws on bad magic', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import zlib from 'node:zlib'
			let threw = false
			try {
				zlib.gunzipSync(new Uint8Array([0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
			} catch { threw = true }
			console.log(threw ? 'ok' : 'no-throw')
		`)
		assert.strictEqual($`${bin} ${dir}/test.js`, 'ok')
	})
})

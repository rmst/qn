import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, testQnOnly, $ } from './util.js'

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

	test('ReadableStream with getReader', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const rs = new ReadableStream({
				start(controller) {
					controller.enqueue("hello ")
					controller.enqueue("world")
					controller.close()
				}
			})
			const reader = rs.getReader()
			let result = ""
			for (;;) {
				const { value, done } = await reader.read()
				if (done) break
				result += value
			}
			console.log(result)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'hello world')
	})

	test('ReadableStream async iteration', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const rs = new ReadableStream({
				start(controller) {
					controller.enqueue("a")
					controller.enqueue("b")
					controller.enqueue("c")
					controller.close()
				}
			})
			const chunks = []
			for await (const chunk of rs) chunks.push(chunk)
			console.log(chunks.join(","))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'a,b,c')
	})

	test('ReadableStream empty stream', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const rs = new ReadableStream({
				start(controller) {
					controller.close()
				}
			})
			const chunks = []
			for await (const chunk of rs) chunks.push(chunk)
			console.log(chunks.length)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, '0')
	})

	testQnOnly('ReadableStream error propagation', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const rs = new ReadableStream({
				start(controller) {
					controller.enqueue("ok")
					controller.error(new Error("boom"))
				}
			})
			const reader = rs.getReader()
			const first = await reader.read()
			console.log(first.value)
			try {
				await reader.read()
				console.log("no error")
			} catch (e) {
				console.log(e.message)
			}
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'ok\nboom')
	})

	testQnOnly('console.time and timeEnd output timing', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.time('test')
			let x = 0
			for (let i = 0; i < 10000; i++) x += i
			console.timeEnd('test')
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.match(output, /^test: \d+\.\d+ms$/)
	})

	testQnOnly('console.time with default label', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.time()
			console.timeEnd()
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.match(output, /^default: \d+\.\d+ms$/)
	})

	testQnOnly('console.timeLog outputs intermediate timing', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.time('myTimer')
			console.timeLog('myTimer')
			console.timeEnd('myTimer')
		`)

		const output = $`${bin} ${dir}/test.js`
		const lines = output.split('\n')
		assert.strictEqual(lines.length, 2)
		assert.match(lines[0], /^myTimer: \d+\.\d+ms$/)
		assert.match(lines[1], /^myTimer: \d+\.\d+ms$/)
	})

	testQnOnly('console.timeEnd warns for non-existent label', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.timeEnd('nonexistent')
		`)

		const output = $({ stdio: ['pipe', 'pipe', 'pipe'] })`${bin} ${dir}/test.js 2>&1`
		assert.match(output, /Warning.*nonexistent/)
	})

	testQnOnly('console.time warns for duplicate label', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.time('dup')
			console.time('dup')
			console.timeEnd('dup')
		`)

		const output = $({ stdio: ['pipe', 'pipe', 'pipe'] })`${bin} ${dir}/test.js 2>&1`
		assert.match(output, /Warning.*dup.*already exists/)
	})

	testQnOnly('console.timeLog with extra data', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.time('data')
			console.timeLog('data', 'extra', 'info')
			console.timeEnd('data')
		`)

		const output = $`${bin} ${dir}/test.js`
		const lines = output.split('\n')
		assert.match(lines[0], /^data: \d+\.\d+ms extra info$/)
	})
})

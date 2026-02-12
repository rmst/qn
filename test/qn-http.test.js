import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { testQnOnly, $, execAsync } from './util.js'

describe('qn:http serve()', () => {
	testQnOnly('basic GET returns text', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, (req) => new Response("hello"))
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`)
			const text = await res.text()
			server.close()
			console.log(JSON.stringify({ status: res.status, text }))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { status: 200, text: "hello" })
	})

	testQnOnly('handler receives method, url, headers', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, (req) => {
				const url = new URL(req.url)
				return new Response(JSON.stringify({
					method: req.method,
					path: url.pathname,
					search: url.search,
					xTest: req.headers.get('x-test'),
				}), { headers: { 'content-type': 'application/json' } })
			})
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/hello?a=1\`, {
				headers: { 'X-Test': 'test-value' },
			})
			const data = await res.json()
			server.close()
			console.log(JSON.stringify(data))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		const data = JSON.parse(output)
		assert.strictEqual(data.method, "GET")
		assert.strictEqual(data.path, "/hello")
		assert.strictEqual(data.search, "?a=1")
		assert.strictEqual(data.xTest, "test-value")
	})

	testQnOnly('POST with body', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, async (req) => {
				const body = await req.text()
				return new Response("echo:" + body)
			})
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/echo\`, {
				method: "POST",
				body: "hello world",
			})
			const text = await res.text()
			server.close()
			console.log(JSON.stringify({ status: res.status, text }))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { status: 200, text: "echo:hello world" })
	})

	testQnOnly('custom status code and headers', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, (req) => {
				return new Response("not found", {
					status: 404,
					headers: { 'x-custom': 'value' },
				})
			})
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/missing\`)
			const text = await res.text()
			server.close()
			console.log(JSON.stringify({
				status: res.status,
				text,
				xCustom: res.headers.get('x-custom'),
			}))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.status, 404)
		assert.strictEqual(result.text, "not found")
		assert.strictEqual(result.xCustom, "value")
	})

	testQnOnly('JSON response', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, (req) => {
				return Response.json({ message: "hello", num: 42 })
			})
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`)
			const data = await res.json()
			server.close()
			console.log(JSON.stringify(data))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { message: "hello", num: 42 })
	})

	testQnOnly('multiple sequential requests', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			let count = 0
			const server = await serve({ port: 0 }, (req) => {
				count++
				return new Response("request " + count)
			})
			const addr = server.address()
			const results = []
			for (let i = 0; i < 3; i++) {
				const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`)
				results.push(await res.text())
			}
			server.close()
			console.log(JSON.stringify(results))
		`)
		const output = $({ timeout: 10000 })`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), ["request 1", "request 2", "request 3"])
	})

	testQnOnly('handler(req) and serve(handler) argument order', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve((req) => new Response("alt order"), { port: 0 })
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`)
			const text = await res.text()
			server.close()
			console.log(JSON.stringify({ text }))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { text: "alt order" })
	})

	testQnOnly('streaming response body', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, (req) => {
				async function* chunks() {
					yield new TextEncoder().encode("chunk1,")
					yield new TextEncoder().encode("chunk2,")
					yield new TextEncoder().encode("chunk3")
				}
				return new Response(chunks(), {
					headers: { 'content-type': 'text/plain' },
				})
			})
			const addr = server.address()
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`)
			const text = await res.text()
			server.close()
			console.log(JSON.stringify({ text }))
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { text: "chunk1,chunk2,chunk3" })
	})

	testQnOnly('large POST body', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { serve } from 'qn:http'
			const server = await serve({ port: 0 }, async (req) => {
				const body = await req.arrayBuffer()
				const bytes = new Uint8Array(body)
				let sum = 0
				for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) >>> 0
				return Response.json({ length: bytes.length, checksum: sum })
			})
			const addr = server.address()
			const data = new Uint8Array(64 * 1024)
			for (let i = 0; i < data.length; i++) data[i] = i & 0xff
			let expected = 0
			for (let i = 0; i < data.length; i++) expected = (expected + data[i]) >>> 0
			const res = await fetch(\`http://127.0.0.1:\${addr.port}/\`, {
				method: "POST",
				body: data,
			})
			const result = await res.json()
			server.close()
			console.log(JSON.stringify({ ...result, expected }))
		`)
		const output = $({ timeout: 10000 })`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.length, 64 * 1024)
		assert.strictEqual(result.checksum, result.expected)
	})
})

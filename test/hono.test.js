import { describe, test } from 'node:test'
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import path from 'node:path'

if (!process.env.HONO_PATH) {
	describe('Hono on qn', () => {
		test.skip('skipped (HONO_PATH not set, run via jix)', () => {})
	})
} else {

const testDir = path.dirname(new URL(import.meta.url).pathname)
const honoApp = path.join(testDir, 'hono-test-app.js')

function startHonoServer(bin) {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, [honoApp], {
			stdio: ['ignore', 'pipe', 'pipe']
		})

		let output = ''
		let stderr = ''
		child.stdout.on('data', (data) => {
			output += data.toString()
			const port = parseInt(output.trim(), 10)
			if (!isNaN(port)) {
				setTimeout(() => {
					resolve({
						port,
						close: () => child.kill()
					})
				}, 50)
			}
		})
		child.stderr.on('data', (data) => {
			stderr += data.toString()
		})

		child.on('error', reject)
		child.on('exit', (code) => {
			if (code !== null && code !== 0) {
				reject(new Error(`Server exited with code ${code}: ${stderr}`))
			}
		})
	})
}

async function fetchJSON(url) {
	const res = await fetch(url)
	return { status: res.status, data: await res.json(), headers: res.headers }
}

async function fetchText(url, opts) {
	const res = await fetch(url, opts)
	return { status: res.status, text: await res.text(), headers: res.headers }
}

describe('Hono on qn', () => {
	for (const bin of ['node', path.join(testDir, '..', 'bin', 'qn')]) {
		const runtime = bin.includes('qn') ? 'qn' : 'node'

		test(`basic GET text response [${runtime}]`, async () => {
			const { port, close } = await startHonoServer(bin)
			try {
				const { status, text } = await fetchText(`http://127.0.0.1:${port}/`)
				assert.strictEqual(status, 200)
				assert.strictEqual(text, 'Hello from Hono on qn!')
			} finally {
				close()
			}
		})

		test(`JSON response [${runtime}]`, async () => {
			const { port, close } = await startHonoServer(bin)
			try {
				const { status, data } = await fetchJSON(`http://127.0.0.1:${port}/json`)
				assert.strictEqual(status, 200)
				assert.deepStrictEqual(data, { message: 'Hello', runtime: 'qn' })
			} finally {
				close()
			}
		})

		test(`URL params [${runtime}]`, async () => {
			const { port, close } = await startHonoServer(bin)
			try {
				const { text } = await fetchText(`http://127.0.0.1:${port}/params/World`)
				assert.strictEqual(text, 'Hello World!')
			} finally {
				close()
			}
		})

		test(`POST echo [${runtime}]`, async () => {
			const { port, close } = await startHonoServer(bin)
			try {
				const { text } = await fetchText(`http://127.0.0.1:${port}/echo`, {
					method: 'POST',
					body: 'hello world',
				})
				assert.strictEqual(text, 'Echo: hello world')
			} finally {
				close()
			}
		})

		test(`custom headers [${runtime}]`, async () => {
			const { port, close } = await startHonoServer(bin)
			try {
				const res = await fetch(`http://127.0.0.1:${port}/headers`, {
					headers: { 'X-Test': 'test-value' }
				})
				assert.strictEqual(res.headers.get('x-custom'), 'hello')
				const data = await res.json()
				assert.strictEqual(data.custom, 'test-value')
			} finally {
				close()
			}
		})

		test(`custom status code [${runtime}]`, async () => {
			const { port, close } = await startHonoServer(bin)
			try {
				const { status, text } = await fetchText(`http://127.0.0.1:${port}/status`)
				assert.strictEqual(status, 404)
				assert.strictEqual(text, 'Not Found')
			} finally {
				close()
			}
		})

		test(`redirect [${runtime}]`, async () => {
			const { port, close } = await startHonoServer(bin)
			try {
				const res = await fetch(`http://127.0.0.1:${port}/redirect`)
				assert.strictEqual(res.status, 200)
				assert.strictEqual(res.redirected, true)
				const text = await res.text()
				assert.strictEqual(text, 'Hello from Hono on qn!')
			} finally {
				close()
			}
		})

		test(`404 for unknown route [${runtime}]`, async () => {
			const { port, close } = await startHonoServer(bin)
			try {
				const { status } = await fetchText(`http://127.0.0.1:${port}/nonexistent`)
				assert.strictEqual(status, 404)
			} finally {
				close()
			}
		})
	}
})

const qnBin = path.join(testDir, '..', 'bin', 'qn')
const honoServeApp = path.join(testDir, 'hono-serve-app.js')

function startHonoServeServer() {
	return new Promise((resolve, reject) => {
		const child = spawn(qnBin, [honoServeApp], {
			stdio: ['ignore', 'pipe', 'pipe']
		})

		let output = ''
		let stderr = ''
		child.stdout.on('data', (data) => {
			output += data.toString()
			const port = parseInt(output.trim(), 10)
			if (!isNaN(port)) {
				setTimeout(() => {
					resolve({
						port,
						close: () => child.kill()
					})
				}, 50)
			}
		})
		child.stderr.on('data', (data) => {
			stderr += data.toString()
		})

		child.on('error', reject)
		child.on('exit', (code) => {
			if (code !== null && code !== 0) {
				reject(new Error(`Server exited with code ${code}: ${stderr}`))
			}
		})
	})
}

describe('Hono on qn:http serve()', () => {
	test('basic GET text response', async () => {
		const { port, close } = await startHonoServeServer()
		try {
			const { status, text } = await fetchText(`http://127.0.0.1:${port}/`)
			assert.strictEqual(status, 200)
			assert.strictEqual(text, 'Hello from Hono on qn!')
		} finally {
			close()
		}
	})

	test('JSON response', async () => {
		const { port, close } = await startHonoServeServer()
		try {
			const { status, data } = await fetchJSON(`http://127.0.0.1:${port}/json`)
			assert.strictEqual(status, 200)
			assert.deepStrictEqual(data, { message: 'Hello', runtime: 'qn' })
		} finally {
			close()
		}
	})

	test('POST echo', async () => {
		const { port, close } = await startHonoServeServer()
		try {
			const { text } = await fetchText(`http://127.0.0.1:${port}/echo`, {
				method: 'POST',
				body: 'hello world',
			})
			assert.strictEqual(text, 'Echo: hello world')
		} finally {
			close()
		}
	})

	test('custom headers', async () => {
		const { port, close } = await startHonoServeServer()
		try {
			const res = await fetch(`http://127.0.0.1:${port}/headers`, {
				headers: { 'X-Test': 'test-value' }
			})
			assert.strictEqual(res.headers.get('x-custom'), 'hello')
			const data = await res.json()
			assert.strictEqual(data.custom, 'test-value')
		} finally {
			close()
		}
	})

	test('redirect', async () => {
		const { port, close } = await startHonoServeServer()
		try {
			const res = await fetch(`http://127.0.0.1:${port}/redirect`)
			assert.strictEqual(res.status, 200)
			assert.strictEqual(res.redirected, true)
			const text = await res.text()
			assert.strictEqual(text, 'Hello from Hono on qn!')
		} finally {
			close()
		}
	})

	test('404 for unknown route', async () => {
		const { port, close } = await startHonoServeServer()
		try {
			const { status } = await fetchText(`http://127.0.0.1:${port}/nonexistent`)
			assert.strictEqual(status, 404)
		} finally {
			close()
		}
	})
})

} // HONO_PATH

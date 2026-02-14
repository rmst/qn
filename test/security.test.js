import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test, testQnOnly, $, execAsync, QN, mktempdir } from './util.js'

// Shared test server that echoes request details as JSON
const ECHO_SERVER_CODE = `
import { createServer } from 'node:http'
const server = createServer((req, res) => {
	res.setHeader('Connection', 'close')
	const url = new URL(req.url, 'http://localhost')
	let body = ''
	req.on('data', chunk => body += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
	req.on('end', () => {
		if (url.pathname === '/redirect-external') {
			const target = url.searchParams.get('to')
			res.writeHead(302, { 'Location': target })
			res.end()
		} else if (url.pathname === '/redirect-same') {
			res.writeHead(302, { 'Location': '/echo' })
			res.end()
		} else {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({
				method: req.method,
				url: req.url,
				headers: req.headers,
			}))
		}
	})
})
server.listen(0, '127.0.0.1', () => {
	console.log(server.address().port)
})
`

function startServer(code = ECHO_SERVER_CODE) {
	const serverDir = mktempdir()
	const serverFile = join(serverDir, 'server.js')
	writeFileSync(serverFile, code)
	return new Promise((resolve, reject) => {
		const child = spawn(QN(), [serverFile], {
			stdio: ['ignore', 'pipe', 'inherit']
		})
		const cleanup = () => {
			child.kill()
			try { require('node:fs').rmSync(serverDir, { recursive: true }) } catch {}
		}
		let output = ''
		child.stdout.on('data', (data) => {
			output += data.toString()
			const port = parseInt(output.trim(), 10)
			if (!isNaN(port)) {
				setTimeout(() => resolve({ port, close: cleanup }), 50)
			}
		})
		child.on('error', reject)
		child.on('exit', (code) => {
			if (code !== null && code !== 0)
				reject(new Error(`Server exited with code ${code}`))
		})
	})
}

describe('Security: Headers validation', () => {
	test('rejects header name with CRLF', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				const h = new Headers()
				h.set('Bad\\r\\nHeader', 'value')
				console.log('no error')
			} catch (e) {
				console.log(e.name)
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'TypeError')
	})

	test('rejects header name with spaces', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				const h = new Headers()
				h.set('Bad Header', 'value')
				console.log('no error')
			} catch (e) {
				console.log(e.name)
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'TypeError')
	})

	test('rejects header name with colon', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				const h = new Headers()
				h.set('Bad:Name', 'value')
				console.log('no error')
			} catch (e) {
				console.log(e.name)
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'TypeError')
	})

	test('rejects empty header name', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				const h = new Headers()
				h.set('', 'value')
				console.log('no error')
			} catch (e) {
				console.log(e.name)
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'TypeError')
	})

	test('rejects header value with NUL', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				const h = new Headers()
				h.set('X-Test', 'val\\x00ue')
				console.log('no error')
			} catch (e) {
				console.log(e.name)
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'TypeError')
	})

	test('rejects header value with CR', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				const h = new Headers()
				h.set('X-Test', 'val\\rue')
				console.log('no error')
			} catch (e) {
				console.log(e.name)
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'TypeError')
	})

	test('rejects header value with LF', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				const h = new Headers()
				h.set('X-Test', 'val\\nue')
				console.log('no error')
			} catch (e) {
				console.log(e.name)
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'TypeError')
	})

	test('validates in append() too', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				const h = new Headers()
				h.append('Bad Header', 'value')
				console.log('no error')
			} catch (e) {
				console.log(e.name)
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'TypeError')
	})

	test('validates in constructor with object', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				new Headers({ 'Bad Header': 'value' })
				console.log('no error')
			} catch (e) {
				console.log(e.name)
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'TypeError')
	})

	test('validates in constructor with array', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				new Headers([['Bad Header', 'value']])
				console.log('no error')
			} catch (e) {
				console.log(e.name)
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'TypeError')
	})

	test('accepts valid header names with special chars', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const h = new Headers()
			h.set('X-My-Header_v2.0', 'ok')
			h.set("X-Special!#$%&'*+^", 'ok')
			console.log(h.get('x-my-header_v2.0'))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'ok')
	})
})

describe('Security: HTTP request building', () => {
	testQnOnly('rejects CRLF in fetch method', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			const server = http.createServer((req, res) => {
				res.writeHead(200)
				res.end('ok')
			})
			server.listen(0, '127.0.0.1', async () => {
				const addr = server.address()
				try {
					await fetch('http://127.0.0.1:' + addr.port + '/test', {
						method: 'GET\\r\\nX-Injected: true\\r\\n\\r\\nPOST'
					})
					console.log('no error')
				} catch (e) {
					console.log(e.name)
				}
				server.close()
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.strictEqual(output, 'TypeError')
		})
	})
})

describe('Security: HTTP response splitting', () => {
	testQnOnly('rejects CRLF in statusMessage setter', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			const server = http.createServer((req, res) => {
				try {
					res.statusMessage = 'OK\\r\\nInjected-Header: evil'
					console.log('no error')
				} catch (e) {
					console.log(e.name)
				}
				res.writeHead(200)
				res.end('ok')
			})
			server.listen(0, '127.0.0.1', async () => {
				const addr = server.address()
				await fetch('http://127.0.0.1:' + addr.port + '/')
				server.close()
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.strictEqual(output, 'TypeError')
		})
	})

	testQnOnly('rejects CRLF in writeHead statusMessage', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'
			const server = http.createServer((req, res) => {
				try {
					res.writeHead(200, 'OK\\r\\nInjected: evil')
					console.log('no error')
				} catch (e) {
					console.log(e.name)
				}
				res.writeHead(200)
				res.end('ok')
			})
			server.listen(0, '127.0.0.1', async () => {
				const addr = server.address()
				await fetch('http://127.0.0.1:' + addr.port + '/')
				server.close()
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.strictEqual(output, 'TypeError')
		})
	})
})

describe('Security: cross-origin redirect credential stripping', () => {
	testQnOnly('strips Authorization on cross-origin redirect', ({ bin, dir }) => {
		// We need two servers: one that redirects to the other
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'

			// Target server: echoes request headers
			const target = http.createServer((req, res) => {
				res.setHeader('Connection', 'close')
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ auth: req.headers['authorization'] || null }))
			})

			// Redirect server: redirects to target on a different port (= different origin)
			const redirector = http.createServer((req, res) => {
				const targetAddr = target.address()
				res.writeHead(302, {
					'Location': 'http://127.0.0.1:' + targetAddr.port + '/dest',
					'Connection': 'close',
				})
				res.end()
			})

			target.listen(0, '127.0.0.1', () => {
				redirector.listen(0, '127.0.0.1', async () => {
					const rAddr = redirector.address()
					const res = await fetch('http://127.0.0.1:' + rAddr.port + '/start', {
						headers: { 'Authorization': 'Bearer secret-token' }
					})
					const data = await res.json()
					console.log('auth:' + data.auth)
					target.close()
					redirector.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.strictEqual(output, 'auth:null')
		})
	})

	testQnOnly('preserves Authorization on same-origin redirect', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'

			const server = http.createServer((req, res) => {
				res.setHeader('Connection', 'close')
				if (req.url === '/start') {
					res.writeHead(302, { 'Location': '/dest' })
					res.end()
				} else {
					res.writeHead(200, { 'Content-Type': 'application/json' })
					res.end(JSON.stringify({ auth: req.headers['authorization'] || null }))
				}
			})

			server.listen(0, '127.0.0.1', async () => {
				const addr = server.address()
				const res = await fetch('http://127.0.0.1:' + addr.port + '/start', {
					headers: { 'Authorization': 'Bearer secret-token' }
				})
				const data = await res.json()
				console.log('auth:' + data.auth)
				server.close()
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.strictEqual(output, 'auth:Bearer secret-token')
		})
	})

	testQnOnly('strips Cookie on cross-origin redirect', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import http from 'node:http'

			const target = http.createServer((req, res) => {
				res.setHeader('Connection', 'close')
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ cookie: req.headers['cookie'] || null }))
			})

			const redirector = http.createServer((req, res) => {
				const targetAddr = target.address()
				res.writeHead(302, {
					'Location': 'http://127.0.0.1:' + targetAddr.port + '/dest',
					'Connection': 'close',
				})
				res.end()
			})

			target.listen(0, '127.0.0.1', () => {
				redirector.listen(0, '127.0.0.1', async () => {
					const rAddr = redirector.address()
					const res = await fetch('http://127.0.0.1:' + rAddr.port + '/start', {
						headers: { 'Cookie': 'session=abc123' }
					})
					const data = await res.json()
					console.log('cookie:' + data.cookie)
					target.close()
					redirector.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.strictEqual(output, 'cookie:null')
		})
	})
})

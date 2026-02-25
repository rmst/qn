import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { testQnOnly, execAsync, QN } from './util.js'

const NO_NODE = process.env.NO_NODEJS_TESTS

const testDir = path.dirname(new URL(import.meta.url).pathname)
const certFile = path.join(testDir, 'fixtures', 'test-cert.pem')
const keyFile = path.join(testDir, 'fixtures', 'test-key.pem')

const HTTPS_SERVER_CODE = `
const https = require('https');
const fs = require('fs');
const server = https.createServer({
	cert: fs.readFileSync(${JSON.stringify(certFile)}),
	key: fs.readFileSync(${JSON.stringify(keyFile)}),
}, (req, res) => {
	res.setHeader('Connection', 'close');
	const url = new URL(req.url, 'https://localhost');
	let body = '';
	req.on('data', chunk => body += chunk);
	req.on('end', () => {
		if (url.pathname === '/get') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ url: req.url, method: req.method }));
		} else if (url.pathname === '/post' && req.method === 'POST') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			let json = null;
			try { json = JSON.parse(body); } catch {}
			res.end(JSON.stringify({ data: body, json }));
		} else if (url.pathname === '/headers') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ headers: req.headers }));
		} else if (url.pathname === '/redirect') {
			res.writeHead(302, { 'Location': '/get' });
			res.end();
		} else if (url.pathname === '/text') {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end('Hello, TLS!');
		} else if (url.pathname === '/slow') {
			setTimeout(() => {
				res.writeHead(200, { 'Content-Type': 'text/plain' });
				res.end('slow-response');
			}, 100);
		} else {
			res.writeHead(404);
			res.end('Not Found');
		}
	});
});
server.listen(0, '127.0.0.1', () => {
	console.log(server.address().port);
});
`

function startHttpsServer() {
	return new Promise((resolve, reject) => {
		const child = spawn('node', ['-e', HTTPS_SERVER_CODE], {
			stdio: ['ignore', 'pipe', 'inherit']
		})
		let output = ''
		child.stdout.on('data', (data) => {
			output += data.toString()
			const port = parseInt(output.trim(), 10)
			if (!isNaN(port)) {
				setTimeout(() => resolve({ port, close: () => child.kill() }), 50)
			}
		})
		child.on('error', reject)
		child.on('exit', (code) => {
			if (code !== null && code !== 0)
				reject(new Error(`HTTPS server exited with code ${code}`))
		})
	})
}

describe('qn_tls native module', () => {
	testQnOnly('CA certificates can be loaded', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { loadCACerts, caCertCount } from 'qn:tls'
			const before = caCertCount()
			loadCACerts(${JSON.stringify(certFile)})
			const after = caCertCount()
			console.log(before === 0 && after > 0 ? 'ok' : 'bad: ' + before + ' ' + after)
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		assert.strictEqual(output, 'ok')
	})

	if (!NO_NODE) testQnOnly('TLS connect, handshake, and read from local HTTPS server', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				import * as tls from 'qn:tls'
				import { _op, TCP_NEW, TCP_CONNECT, SET_ON_CONNECT, CLOSE, AF_INET } from 'qn_uv_stream'

				tls.loadCACerts(${JSON.stringify(certFile)})
				const handle = _op(TCP_NEW, AF_INET)
				await new Promise((resolve, reject) => {
					_op(SET_ON_CONNECT, handle, (err) => {
						if (err) reject(err)
						else resolve()
					})
					_op(TCP_CONNECT, handle, '127.0.0.1', ${port})
				})
				const transport = tls.streamTransport(handle)
				const conn = tls.connect('localhost')
				await tls.handshake(conn, transport)
				const req = 'GET /text HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n'
				await tls.writeAll(conn, transport, new TextEncoder().encode(req))
				const buf = new ArrayBuffer(65536)
				const n = await tls.read(conn, transport, buf, 0, 65536)
				const text = new TextDecoder().decode(new Uint8Array(buf, 0, n))
				console.log(text.startsWith('HTTP/1.1 200') ? 'ok' : 'bad: ' + text.substring(0, 50))
				await tls.close(conn, transport)
				_op(CLOSE, handle)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'ok')
		} finally {
			close()
		}
	})
})

// These suites need a Node.js HTTPS server as a fixture
if (!NO_NODE) describe('HTTPS fetch (local server)', { concurrency: true }, () => {
	testQnOnly('HTTPS GET', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('https://localhost:${port}/get')
				const data = await res.json()
				console.log(res.status + ' ' + data.method)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, '200 GET')
		} finally {
			close()
		}
	})

	testQnOnly('HTTPS POST with JSON body', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('https://localhost:${port}/post', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ key: 'value' })
				})
				const data = await res.json()
				console.log(data.json.key)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'value')
		} finally {
			close()
		}
	})

	testQnOnly('HTTPS redirect following', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('https://localhost:${port}/redirect')
				console.log(res.status + ' ' + res.redirected)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, '200 true')
		} finally {
			close()
		}
	})

	testQnOnly('HTTPS custom headers', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('https://localhost:${port}/headers', {
					headers: { 'X-Test-Header': 'hello-tls' }
				})
				const data = await res.json()
				console.log(data.headers['x-test-header'])
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'hello-tls')
		} finally {
			close()
		}
	})

	testQnOnly('HTTPS text body', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('https://localhost:${port}/text')
				console.log(await res.text())
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'Hello, TLS!')
		} finally {
			close()
		}
	})

	testQnOnly('HTTPS concurrent fetch requests', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const [res1, res2] = await Promise.all([
					fetch('https://localhost:${port}/text'),
					fetch('https://localhost:${port}/get'),
				])
				const text = await res1.text()
				const data = await res2.json()
				console.log(text + ' | ' + data.method)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'Hello, TLS! | GET')
		} finally {
			close()
		}
	})
})

function startQnTlsServer(serverScript) {
	return new Promise((resolve, reject) => {
		const child = spawn(QN(), [serverScript], {
			stdio: ['ignore', 'pipe', 'pipe']
		})
		let output = ''
		let stderr = ''
		child.stdout.on('data', (data) => {
			output += data.toString()
			const port = parseInt(output.trim(), 10)
			if (!isNaN(port)) {
				setTimeout(() => resolve({ port, close: () => child.kill() }), 50)
			}
		})
		child.stderr.on('data', (data) => { stderr += data.toString() })
		child.on('error', reject)
		child.on('exit', (code) => {
			if (code !== null && code !== 0)
				reject(new Error(`qn TLS server exited with code ${code}: ${stderr}`))
		})
	})
}

describe('TLS server', { concurrency: true }, () => {
	testQnOnly('Server credentials can be loaded', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { loadServerCert } from 'qn:tls'
			const cred = loadServerCert(${JSON.stringify(certFile)}, ${JSON.stringify(keyFile)})
			console.log(cred ? 'ok' : 'fail')
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		assert.strictEqual(output, 'ok')
	})

	testQnOnly('TLS server accept and serve response', async ({ bin, dir }) => {
		writeFileSync(`${dir}/server.js`, `
			import * as tls from 'qn:tls'
			import { _op, TCP_NEW, TCP_BIND, LISTEN, SET_ON_CONNECTION, TCP_GETSOCKNAME, CLOSE, AF_INET } from 'qn_uv_stream'
			const tcpNew = (f) => _op(TCP_NEW, f)
			const tcpBind = (h, host, port) => _op(TCP_BIND, h, host, port)
			const uvListen = (h, backlog) => _op(LISTEN, h, backlog)
			const setOnConnection = (h, fn) => _op(SET_ON_CONNECTION, h, fn)
			const tcpGetsockname = (h) => _op(TCP_GETSOCKNAME, h)
			const streamClose = (h) => _op(CLOSE, h)

			const cred = tls.loadServerCert(${JSON.stringify(certFile)}, ${JSON.stringify(keyFile)})

			const server = tcpNew(AF_INET)
			tcpBind(server, '127.0.0.1', 0)
			uvListen(server, 1)
			console.log(tcpGetsockname(server).port)

			setOnConnection(server, async (clientHandle) => {
				if (clientHandle instanceof Error) return
				setOnConnection(server, null)

				const transport = tls.streamTransport(clientHandle)
				const conn = tls.accept(cred)
				await tls.handshake(conn, transport)

				const buf = new ArrayBuffer(65536)
				await tls.read(conn, transport, buf, 0, 65536)

				const body = 'Hello from qn TLS server!'
				const response = 'HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: ' + body.length + '\\r\\nConnection: close\\r\\n\\r\\n' + body
				await tls.writeAll(conn, transport, new TextEncoder().encode(response))
				await tls.close(conn, transport)
				streamClose(clientHandle)
				streamClose(server)
			})
		`)

		const { port, close } = await startQnTlsServer(`${dir}/server.js`)
		try {
			writeFileSync(`${dir}/client.js`, `
				const res = await fetch('https://localhost:${port}/')
				console.log(res.status + ' ' + await res.text())
			`)
			const output = await execAsync(bin, [`${dir}/client.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, '200 Hello from qn TLS server!')
		} finally {
			close()
		}
	})

	testQnOnly('TLS server handles POST with body', async ({ bin, dir }) => {
		writeFileSync(`${dir}/server.js`, `
			import * as tls from 'qn:tls'
			import { _op, TCP_NEW, TCP_BIND, LISTEN, SET_ON_CONNECTION, TCP_GETSOCKNAME, CLOSE, AF_INET } from 'qn_uv_stream'
			const tcpNew = (f) => _op(TCP_NEW, f)
			const tcpBind = (h, host, port) => _op(TCP_BIND, h, host, port)
			const uvListen = (h, backlog) => _op(LISTEN, h, backlog)
			const setOnConnection = (h, fn) => _op(SET_ON_CONNECTION, h, fn)
			const tcpGetsockname = (h) => _op(TCP_GETSOCKNAME, h)
			const streamClose = (h) => _op(CLOSE, h)

			const cred = tls.loadServerCert(${JSON.stringify(certFile)}, ${JSON.stringify(keyFile)})

			const server = tcpNew(AF_INET)
			tcpBind(server, '127.0.0.1', 0)
			uvListen(server, 1)
			console.log(tcpGetsockname(server).port)

			setOnConnection(server, async (clientHandle) => {
				if (clientHandle instanceof Error) return
				setOnConnection(server, null)

				const transport = tls.streamTransport(clientHandle)
				const conn = tls.accept(cred)
				await tls.handshake(conn, transport)

				// Read until we have complete headers + body
				const buf = new ArrayBuffer(65536)
				let accumulated = new Uint8Array(0)
				while (true) {
					const n = await tls.read(conn, transport, buf, 0, 65536)
					if (n <= 0) break
					const prev = accumulated
					accumulated = new Uint8Array(prev.length + n)
					accumulated.set(prev, 0)
					accumulated.set(new Uint8Array(buf, 0, n), prev.length)
					const text = new TextDecoder().decode(accumulated)
					const headerEnd = text.indexOf('\\r\\n\\r\\n')
					if (headerEnd >= 0) {
						const clMatch = text.match(/content-length:\\s*(\\d+)/i)
						const contentLength = clMatch ? parseInt(clMatch[1], 10) : 0
						if (accumulated.length >= headerEnd + 4 + contentLength) break
					}
				}
				const request = new TextDecoder().decode(accumulated)

				const bodyStart = request.indexOf('\\r\\n\\r\\n')
				const reqBody = bodyStart >= 0 ? request.slice(bodyStart + 4) : ''

				const body = JSON.stringify({ echo: reqBody })
				const response = 'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: ' + new TextEncoder().encode(body).length + '\\r\\nConnection: close\\r\\n\\r\\n' + body
				await tls.writeAll(conn, transport, new TextEncoder().encode(response))
				await tls.close(conn, transport)
				streamClose(clientHandle)
				streamClose(server)
			})
		`)

		const { port, close } = await startQnTlsServer(`${dir}/server.js`)
		try {
			writeFileSync(`${dir}/client.js`, `
				const res = await fetch('https://localhost:${port}/', {
					method: 'POST',
					headers: { 'Content-Type': 'text/plain' },
					body: 'test-payload'
				})
				const data = await res.json()
				console.log(data.echo)
			`)
			const output = await execAsync(bin, [`${dir}/client.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'test-payload')
		} finally {
			close()
		}
	})

	testQnOnly('TLS server with multiple sequential connections', async ({ bin, dir }) => {
		writeFileSync(`${dir}/server.js`, `
			import * as tls from 'qn:tls'
			import { _op, TCP_NEW, TCP_BIND, LISTEN, SET_ON_CONNECTION, TCP_GETSOCKNAME, CLOSE, AF_INET } from 'qn_uv_stream'
			const tcpNew = (f) => _op(TCP_NEW, f)
			const tcpBind = (h, host, port) => _op(TCP_BIND, h, host, port)
			const uvListen = (h, backlog) => _op(LISTEN, h, backlog)
			const setOnConnection = (h, fn) => _op(SET_ON_CONNECTION, h, fn)
			const tcpGetsockname = (h) => _op(TCP_GETSOCKNAME, h)
			const streamClose = (h) => _op(CLOSE, h)

			const cred = tls.loadServerCert(${JSON.stringify(certFile)}, ${JSON.stringify(keyFile)})

			const server = tcpNew(AF_INET)
			tcpBind(server, '127.0.0.1', 0)
			uvListen(server, 2)
			console.log(tcpGetsockname(server).port)

			let count = 0
			setOnConnection(server, async (clientHandle) => {
				if (clientHandle instanceof Error) return

				const transport = tls.streamTransport(clientHandle)
				const conn = tls.accept(cred)
				await tls.handshake(conn, transport)

				const buf = new ArrayBuffer(65536)
				await tls.read(conn, transport, buf, 0, 65536)

				count++
				const body = 'request ' + count
				const response = 'HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: ' + body.length + '\\r\\nConnection: close\\r\\n\\r\\n' + body
				await tls.writeAll(conn, transport, new TextEncoder().encode(response))
				await tls.close(conn, transport)
				streamClose(clientHandle)

				if (count >= 2) {
					setOnConnection(server, null)
					streamClose(server)
				}
			})
		`)

		const { port, close } = await startQnTlsServer(`${dir}/server.js`)
		try {
			writeFileSync(`${dir}/client.js`, `
				const res1 = await fetch('https://localhost:${port}/')
				const text1 = await res1.text()
				const res2 = await fetch('https://localhost:${port}/')
				const text2 = await res2.text()
				console.log(text1 + ' | ' + text2)
			`)
			const output = await execAsync(bin, [`${dir}/client.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'request 1 | request 2')
		} finally {
			close()
		}
	})
})

const HTTPS_SERVER_SLOW = `
const https = require('https');
const fs = require('fs');
const server = https.createServer({
	cert: fs.readFileSync(${JSON.stringify(certFile)}),
	key: fs.readFileSync(${JSON.stringify(keyFile)}),
}, (req, res) => {
	res.setHeader('Connection', 'close');
	setTimeout(() => {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('slow-response');
	}, 2000);
});
server.listen(0, '127.0.0.1', () => {
	console.log(server.address().port);
});
`

function startSlowHttpsServer() {
	return new Promise((resolve, reject) => {
		const child = spawn('node', ['-e', HTTPS_SERVER_SLOW], {
			stdio: ['ignore', 'pipe', 'inherit']
		})
		let output = ''
		child.stdout.on('data', (data) => {
			output += data.toString()
			const port = parseInt(output.trim(), 10)
			if (!isNaN(port)) {
				setTimeout(() => resolve({ port, close: () => child.kill() }), 50)
			}
		})
		child.on('error', reject)
		child.on('exit', (code) => {
			if (code !== null && code !== 0)
				reject(new Error(`HTTPS server exited with code ${code}`))
		})
	})
}

if (!NO_NODE) describe('Fetch timeout and AbortSignal', { concurrency: true }, () => {
	testQnOnly('AbortSignal.timeout aborts slow HTTPS request', async ({ bin, dir }) => {
		const { port, close } = await startSlowHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				try {
					await fetch('https://localhost:${port}/', {
						signal: AbortSignal.timeout(200)
					})
					console.log('should-not-reach')
				} catch (e) {
					console.log(e.name)
				}
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'TimeoutError')
		} finally {
			close()
		}
	})

	testQnOnly('AbortController aborts HTTPS request', async ({ bin, dir }) => {
		const { port, close } = await startSlowHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const controller = new AbortController()
				setTimeout(() => controller.abort(), 100)
				try {
					await fetch('https://localhost:${port}/', {
						signal: controller.signal
					})
					console.log('should-not-reach')
				} catch (e) {
					console.log(e.name)
				}
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'AbortError')
		} finally {
			close()
		}
	})

	testQnOnly('Already-aborted signal rejects immediately', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				try {
					await fetch('https://localhost:${port}/get', {
						signal: AbortSignal.abort()
					})
					console.log('should-not-reach')
				} catch (e) {
					console.log(e.name)
				}
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'AbortError')
		} finally {
			close()
		}
	})
})

if (!NO_NODE) describe('Streaming response body', { concurrency: true }, () => {
	testQnOnly('response.body async iteration', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('https://localhost:${port}/text')
				const chunks = []
				for await (const chunk of res.body) {
					chunks.push(chunk)
				}
				const text = chunks.map(c => new TextDecoder().decode(c)).join('')
				console.log(chunks.length > 0 && text === 'Hello, TLS!' ? 'ok' : 'bad: ' + text)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'ok')
		} finally {
			close()
		}
	})

	testQnOnly('response.body getReader', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('https://localhost:${port}/text')
				const reader = res.body.getReader()
				const parts = []
				while (true) {
					const { value, done } = await reader.read()
					if (done) break
					parts.push(new TextDecoder().decode(value))
				}
				console.log(parts.join(''))
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'Hello, TLS!')
		} finally {
			close()
		}
	})

	testQnOnly('body consumed via text() then body iteration throws', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('https://localhost:${port}/text')
				await res.text()
				try {
					for await (const chunk of res.body) {}
					console.log('should-not-reach')
				} catch (e) {
					console.log(e.message)
				}
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'Body has already been consumed')
		} finally {
			close()
		}
	})

	testQnOnly('bodyUsed reflects consumption state', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				const res = await fetch('https://localhost:${port}/text')
				const before = res.bodyUsed
				await res.text()
				const after = res.bodyUsed
				console.log(before + ' ' + after)
			`)
			const output = await execAsync(bin, [`${dir}/test.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'false true')
		} finally {
			close()
		}
	})
})

/**
 * Helper: write a qn TLS server script that accepts one connection,
 * sends rawResponse bytes, then closes.
 * The server prints its port to stdout.
 */
function writeRawServer(dir, rawResponseExpr) {
	const script = `
		import * as tls from 'qn:tls'
		import { _op, TCP_NEW, TCP_BIND, LISTEN, SET_ON_CONNECTION, TCP_GETSOCKNAME, CLOSE, AF_INET } from 'qn_uv_stream'
			const tcpNew = (f) => _op(TCP_NEW, f)
			const tcpBind = (h, host, port) => _op(TCP_BIND, h, host, port)
			const uvListen = (h, backlog) => _op(LISTEN, h, backlog)
			const setOnConnection = (h, fn) => _op(SET_ON_CONNECTION, h, fn)
			const tcpGetsockname = (h) => _op(TCP_GETSOCKNAME, h)
			const streamClose = (h) => _op(CLOSE, h)

		const cred = tls.loadServerCert(${JSON.stringify(certFile)}, ${JSON.stringify(keyFile)})
		const server = tcpNew(AF_INET)
		tcpBind(server, '127.0.0.1', 0)
		uvListen(server, 1)
		console.log(tcpGetsockname(server).port)

		setOnConnection(server, async (clientHandle) => {
			if (clientHandle instanceof Error) return
			setOnConnection(server, null)
			const transport = tls.streamTransport(clientHandle)
			const conn = tls.accept(cred)
			await tls.handshake(conn, transport)
			// Read the request (and discard it)
			const buf = new ArrayBuffer(65536)
			await tls.read(conn, transport, buf, 0, 65536)
			// Send the raw response
			const raw = ${rawResponseExpr}
			await tls.writeAll(conn, transport, typeof raw === 'string' ? new TextEncoder().encode(raw) : raw)
			await tls.close(conn, transport)
			streamClose(clientHandle)
			streamClose(server)
		})
	`
	writeFileSync(`${dir}/server.js`, script)
	return `${dir}/server.js`
}

describe('Adversarial: malformed responses', { concurrency: true }, () => {
	testQnOnly('server sends garbage (not HTTP)', async ({ bin, dir }) => {
		writeRawServer(dir, `'this is not http at all\\r\\n'`)
		const { port, close } = await startQnTlsServer(`${dir}/server.js`)
		try {
			writeFileSync(`${dir}/client.js`, `
				try {
					const res = await fetch('https://localhost:${port}/')
					// status 0 is acceptable for unparseable responses
					console.log('status:' + res.status)
				} catch (e) {
					console.log('error:' + e.constructor.name)
				}
			`)
			const output = await execAsync(bin, [`${dir}/client.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			// Should get an error since headers can't be parsed
			assert.strictEqual(output, 'error:TypeError')
		} finally {
			close()
		}
	})

	testQnOnly('server closes connection immediately (no response)', async ({ bin, dir }) => {
		const script = `
			import * as tls from 'qn:tls'
			import { _op, TCP_NEW, TCP_BIND, LISTEN, SET_ON_CONNECTION, TCP_GETSOCKNAME, CLOSE, AF_INET } from 'qn_uv_stream'
			const tcpNew = (f) => _op(TCP_NEW, f)
			const tcpBind = (h, host, port) => _op(TCP_BIND, h, host, port)
			const uvListen = (h, backlog) => _op(LISTEN, h, backlog)
			const setOnConnection = (h, fn) => _op(SET_ON_CONNECTION, h, fn)
			const tcpGetsockname = (h) => _op(TCP_GETSOCKNAME, h)
			const streamClose = (h) => _op(CLOSE, h)

			const cred = tls.loadServerCert(${JSON.stringify(certFile)}, ${JSON.stringify(keyFile)})
			const server = tcpNew(AF_INET)
			tcpBind(server, '127.0.0.1', 0)
			uvListen(server, 1)
			console.log(tcpGetsockname(server).port)

			setOnConnection(server, async (clientHandle) => {
				if (clientHandle instanceof Error) return
				setOnConnection(server, null)
				const transport = tls.streamTransport(clientHandle)
				const conn = tls.accept(cred)
				await tls.handshake(conn, transport)
				// Read the request then close immediately without responding
				const buf = new ArrayBuffer(65536)
				await tls.read(conn, transport, buf, 0, 65536)
				await tls.close(conn, transport)
				streamClose(clientHandle)
				streamClose(server)
			})
		`
		writeFileSync(`${dir}/server.js`, script)
		const { port, close } = await startQnTlsServer(`${dir}/server.js`)
		try {
			writeFileSync(`${dir}/client.js`, `
				try {
					await fetch('https://localhost:${port}/')
					console.log('should-not-reach')
				} catch (e) {
					console.log('error:' + e.constructor.name)
				}
			`)
			const output = await execAsync(bin, [`${dir}/client.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'error:TypeError')
		} finally {
			close()
		}
	})

	testQnOnly('server sends headers only, no body, with Content-Length', async ({ bin, dir }) => {
		writeRawServer(dir, `'HTTP/1.1 200 OK\\r\\nContent-Length: 100\\r\\nConnection: close\\r\\n\\r\\n'`)
		const { port, close } = await startQnTlsServer(`${dir}/server.js`)
		try {
			writeFileSync(`${dir}/client.js`, `
				const res = await fetch('https://localhost:${port}/')
				// Server promised 100 bytes but sent 0 - text() should return truncated body
				const text = await res.text()
				console.log('status:' + res.status + ' len:' + text.length)
			`)
			const output = await execAsync(bin, [`${dir}/client.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'status:200 len:0')
		} finally {
			close()
		}
	})

	testQnOnly('server sends wrong Content-Length (less than actual body)', async ({ bin, dir }) => {
		const body = 'Hello, this is a long body!'
		writeRawServer(dir, `'HTTP/1.1 200 OK\\r\\nContent-Length: 5\\r\\nConnection: close\\r\\n\\r\\n${body}'`)
		const { port, close } = await startQnTlsServer(`${dir}/server.js`)
		try {
			writeFileSync(`${dir}/client.js`, `
				const res = await fetch('https://localhost:${port}/')
				const text = await res.text()
				// Should only read Content-Length bytes
				console.log(text)
			`)
			const output = await execAsync(bin, [`${dir}/client.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'Hello')
		} finally {
			close()
		}
	})

	testQnOnly('server sends empty body with Content-Length: 0', async ({ bin, dir }) => {
		writeRawServer(dir, `'HTTP/1.1 204 No Content\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n'`)
		const { port, close } = await startQnTlsServer(`${dir}/server.js`)
		try {
			writeFileSync(`${dir}/client.js`, `
				const res = await fetch('https://localhost:${port}/')
				const text = await res.text()
				console.log('status:' + res.status + ' body:' + JSON.stringify(text))
			`)
			const output = await execAsync(bin, [`${dir}/client.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'status:204 body:""')
		} finally {
			close()
		}
	})

	testQnOnly('server sends chunked with zero-length final chunk', async ({ bin, dir }) => {
		const chunkedBody = '5\\r\\nhello\\r\\n7\\r\\n world!\\r\\n0\\r\\n\\r\\n'
		writeRawServer(dir, `'HTTP/1.1 200 OK\\r\\nTransfer-Encoding: chunked\\r\\nConnection: close\\r\\n\\r\\n${chunkedBody}'`)
		const { port, close } = await startQnTlsServer(`${dir}/server.js`)
		try {
			writeFileSync(`${dir}/client.js`, `
				const res = await fetch('https://localhost:${port}/')
				console.log(await res.text())
			`)
			const output = await execAsync(bin, [`${dir}/client.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'hello world!')
		} finally {
			close()
		}
	})

	testQnOnly('redirect loop is detected', async ({ bin, dir }) => {
		// Server that always redirects to itself
		const script = `
			import * as tls from 'qn:tls'
			import { _op, TCP_NEW, TCP_BIND, LISTEN, SET_ON_CONNECTION, TCP_GETSOCKNAME, CLOSE, AF_INET } from 'qn_uv_stream'
			const tcpNew = (f) => _op(TCP_NEW, f)
			const tcpBind = (h, host, port) => _op(TCP_BIND, h, host, port)
			const uvListen = (h, backlog) => _op(LISTEN, h, backlog)
			const setOnConnection = (h, fn) => _op(SET_ON_CONNECTION, h, fn)
			const tcpGetsockname = (h) => _op(TCP_GETSOCKNAME, h)
			const streamClose = (h) => _op(CLOSE, h)

			const cred = tls.loadServerCert(${JSON.stringify(certFile)}, ${JSON.stringify(keyFile)})
			const server = tcpNew(AF_INET)
			tcpBind(server, '127.0.0.1', 0)
			uvListen(server, 128)
			const port = tcpGetsockname(server).port
			console.log(port)

			setOnConnection(server, async (clientHandle) => {
				if (clientHandle instanceof Error) return
				const transport = tls.streamTransport(clientHandle)
				const conn = tls.accept(cred)
				try {
					await tls.handshake(conn, transport)
					const buf = new ArrayBuffer(65536)
					await tls.read(conn, transport, buf, 0, 65536)
					const response = 'HTTP/1.1 302 Found\\r\\nLocation: https://localhost:' + port + '/loop\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n'
					await tls.writeAll(conn, transport, new TextEncoder().encode(response))
				} catch {}
				try { await tls.close(conn, transport) } catch {}
				try { streamClose(clientHandle) } catch {}
			})
		`
		writeFileSync(`${dir}/server.js`, script)
		const { port, close } = await startQnTlsServer(`${dir}/server.js`)
		try {
			writeFileSync(`${dir}/client.js`, `
				try {
					await fetch('https://localhost:${port}/')
					console.log('should-not-reach')
				} catch (e) {
					console.log(e.message.includes('redirect') ? 'redirect-error' : e.message)
				}
			`)
			const output = await execAsync(bin, [`${dir}/client.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'redirect-error')
		} finally {
			close()
		}
	})

	testQnOnly('redirect with manual mode returns redirect response', async ({ bin, dir }) => {
		writeRawServer(dir, `'HTTP/1.1 302 Found\\r\\nLocation: /other\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n'`)
		const { port, close } = await startQnTlsServer(`${dir}/server.js`)
		try {
			writeFileSync(`${dir}/client.js`, `
				const res = await fetch('https://localhost:${port}/', { redirect: 'manual' })
				console.log('status:' + res.status + ' location:' + res.headers.get('location'))
			`)
			const output = await execAsync(bin, [`${dir}/client.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'status:302 location:/other')
		} finally {
			close()
		}
	})

	testQnOnly('redirect with error mode throws', async ({ bin, dir }) => {
		writeRawServer(dir, `'HTTP/1.1 301 Moved\\r\\nLocation: /other\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n'`)
		const { port, close } = await startQnTlsServer(`${dir}/server.js`)
		try {
			writeFileSync(`${dir}/client.js`, `
				try {
					await fetch('https://localhost:${port}/', { redirect: 'error' })
					console.log('should-not-reach')
				} catch (e) {
					console.log(e.message.includes('redirect') ? 'redirect-error' : e.message)
				}
			`)
			const output = await execAsync(bin, [`${dir}/client.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'redirect-error')
		} finally {
			close()
		}
	})

	testQnOnly('large response body (1MB)', async ({ bin, dir }) => {
		// Server that sends 1MB of data
		const script = `
			import * as tls from 'qn:tls'
			import { _op, TCP_NEW, TCP_BIND, LISTEN, SET_ON_CONNECTION, TCP_GETSOCKNAME, CLOSE, AF_INET } from 'qn_uv_stream'
			const tcpNew = (f) => _op(TCP_NEW, f)
			const tcpBind = (h, host, port) => _op(TCP_BIND, h, host, port)
			const uvListen = (h, backlog) => _op(LISTEN, h, backlog)
			const setOnConnection = (h, fn) => _op(SET_ON_CONNECTION, h, fn)
			const tcpGetsockname = (h) => _op(TCP_GETSOCKNAME, h)
			const streamClose = (h) => _op(CLOSE, h)

			const cred = tls.loadServerCert(${JSON.stringify(certFile)}, ${JSON.stringify(keyFile)})
			const server = tcpNew(AF_INET)
			tcpBind(server, '127.0.0.1', 0)
			uvListen(server, 1)
			console.log(tcpGetsockname(server).port)

			setOnConnection(server, async (clientHandle) => {
				if (clientHandle instanceof Error) return
				setOnConnection(server, null)
				const transport = tls.streamTransport(clientHandle)
				const conn = tls.accept(cred)
				await tls.handshake(conn, transport)
				const buf = new ArrayBuffer(65536)
				await tls.read(conn, transport, buf, 0, 65536)

				const bodySize = 1024 * 1024
				const header = 'HTTP/1.1 200 OK\\r\\nContent-Length: ' + bodySize + '\\r\\nConnection: close\\r\\n\\r\\n'
				await tls.writeAll(conn, transport, new TextEncoder().encode(header))
				// Send body in 64KB chunks
				const chunk = new Uint8Array(65536)
				chunk.fill(0x41) // 'A'
				let sent = 0
				while (sent < bodySize) {
					const toSend = Math.min(65536, bodySize - sent)
					await tls.writeAll(conn, transport, chunk.subarray(0, toSend))
					sent += toSend
				}
				await tls.close(conn, transport)
				streamClose(clientHandle)
				streamClose(server)
			})
		`
		writeFileSync(`${dir}/server.js`, script)
		const { port, close } = await startQnTlsServer(`${dir}/server.js`)
		try {
			writeFileSync(`${dir}/client.js`, `
				const res = await fetch('https://localhost:${port}/')
				const text = await res.text()
				const allA = text.split('').every(c => c === 'A')
				console.log('len:' + text.length + ' allA:' + allA)
			`)
			const output = await execAsync(bin, [`${dir}/client.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'len:1048576 allA:true')
		} finally {
			close()
		}
	})

	testQnOnly('abort during streaming body read', async ({ bin, dir }) => {
		// Server that sends headers quickly, then delays body
		const script = `
			import * as tls from 'qn:tls'
			import { _op, TCP_NEW, TCP_BIND, LISTEN, SET_ON_CONNECTION, TCP_GETSOCKNAME, CLOSE, AF_INET } from 'qn_uv_stream'
			const tcpNew = (f) => _op(TCP_NEW, f)
			const tcpBind = (h, host, port) => _op(TCP_BIND, h, host, port)
			const uvListen = (h, backlog) => _op(LISTEN, h, backlog)
			const setOnConnection = (h, fn) => _op(SET_ON_CONNECTION, h, fn)
			const tcpGetsockname = (h) => _op(TCP_GETSOCKNAME, h)
			const streamClose = (h) => _op(CLOSE, h)

			const cred = tls.loadServerCert(${JSON.stringify(certFile)}, ${JSON.stringify(keyFile)})
			const server = tcpNew(AF_INET)
			tcpBind(server, '127.0.0.1', 0)
			uvListen(server, 1)
			console.log(tcpGetsockname(server).port)

			setOnConnection(server, async (clientHandle) => {
				if (clientHandle instanceof Error) return
				setOnConnection(server, null)
				const transport = tls.streamTransport(clientHandle)
				const conn = tls.accept(cred)
				await tls.handshake(conn, transport)
				const buf = new ArrayBuffer(65536)
				await tls.read(conn, transport, buf, 0, 65536)

				// Send headers with a large content-length, then send data slowly
				const header = 'HTTP/1.1 200 OK\\r\\nContent-Length: 10000\\r\\nConnection: close\\r\\n\\r\\n'
				await tls.writeAll(conn, transport, new TextEncoder().encode(header))
				// Send a small bit then wait forever
				await tls.writeAll(conn, transport, new TextEncoder().encode('partial'))
				await new Promise(r => setTimeout(r, 5000))
				try { await tls.close(conn, transport) } catch {}
				streamClose(clientHandle)
				streamClose(server)
			})
		`
		writeFileSync(`${dir}/server.js`, script)
		const { port, close } = await startQnTlsServer(`${dir}/server.js`)
		try {
			writeFileSync(`${dir}/client.js`, `
				const controller = new AbortController()
				const res = await fetch('https://localhost:${port}/', {
					signal: controller.signal
				})
				// Headers received, now abort while reading body
				setTimeout(() => controller.abort(), 200)
				try {
					await res.text()
					console.log('should-not-reach')
				} catch (e) {
					console.log(e.name)
				}
			`)
			const output = await execAsync(bin, [`${dir}/client.js`], {
				env: { NODE_EXTRA_CA_CERTS: certFile }
			})
			assert.strictEqual(output, 'AbortError')
		} finally {
			close()
		}
	})
})

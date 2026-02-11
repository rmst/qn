import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { testQnOnly, execAsync, QN } from './util.js'

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
			import { tlsLoadCACerts, tlsCaCertCount } from 'qn_tls'
			const before = tlsCaCertCount()
			tlsLoadCACerts(${JSON.stringify(certFile)})
			const after = tlsCaCertCount()
			console.log(before === 0 && after > 0 ? 'ok' : 'bad: ' + before + ' ' + after)
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		assert.strictEqual(output, 'ok')
	})

	testQnOnly('TLS connect, handshake, and read from local HTTPS server', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				import * as tls from 'node:tls'
				import { socket, connect, connectFinish, getaddrinfo, AF_INET, SOCK_STREAM, EINPROGRESS } from 'qn_socket'
				import * as os from 'os'

				tls.loadCACerts(${JSON.stringify(certFile)})
				const addrs = getaddrinfo('127.0.0.1', ${port}, { family: AF_INET })
				const fd = socket(addrs[0].family, SOCK_STREAM)
				const ret = connect(fd, addrs[0].address, ${port})
				if (ret === -EINPROGRESS) {
					await new Promise((resolve) => {
						os.setWriteHandler(fd, () => {
							os.setWriteHandler(fd, null)
							connectFinish(fd)
							resolve()
						})
					})
				}
				const conn = tls.connect(fd, 'localhost')
				await tls.handshake(conn, fd)
				const req = 'GET /text HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n'
				await tls.writeAll(conn, fd, new TextEncoder().encode(req))
				const buf = new ArrayBuffer(65536)
				const n = await tls.read(conn, fd, buf, 0, 65536)
				const text = new TextDecoder().decode(new Uint8Array(buf, 0, n))
				console.log(text.startsWith('HTTP/1.1 200') ? 'ok' : 'bad: ' + text.substring(0, 50))
				await tls.close(conn, fd)
				os.close(fd)
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

describe('HTTPS fetch (local server)', () => {
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

describe('TLS server', () => {
	testQnOnly('Server credentials can be loaded', async ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { tlsLoadServerCert } from 'qn_tls'
			const cred = tlsLoadServerCert(${JSON.stringify(certFile)}, ${JSON.stringify(keyFile)})
			console.log(cred ? 'ok' : 'fail')
		`)
		const output = await execAsync(bin, [`${dir}/test.js`])
		assert.strictEqual(output, 'ok')
	})

	testQnOnly('TLS server accept and serve response', async ({ bin, dir }) => {
		writeFileSync(`${dir}/server.js`, `
			import * as tls from 'node:tls'
			import { socket, bind, listen, accept, setsockopt, getsockname, AF_INET, SOCK_STREAM, SOL_SOCKET, SO_REUSEADDR } from 'qn_socket'
			import * as os from 'os'

			const cred = tls.loadServerCert(${JSON.stringify(certFile)}, ${JSON.stringify(keyFile)})

			const fd = socket(AF_INET, SOCK_STREAM)
			setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, 1)
			bind(fd, '127.0.0.1', 0)
			listen(fd, 1)
			const addr = getsockname(fd)
			console.log(addr.port)

			os.setReadHandler(fd, async () => {
				const result = accept(fd)
				if (!result) return
				os.setReadHandler(fd, null)

				const conn = tls.accept(result.fd, cred)
				await tls.handshake(conn, result.fd)

				const buf = new ArrayBuffer(65536)
				await tls.read(conn, result.fd, buf, 0, 65536)

				const body = 'Hello from qn TLS server!'
				const response = 'HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: ' + body.length + '\\r\\nConnection: close\\r\\n\\r\\n' + body
				await tls.writeAll(conn, result.fd, new TextEncoder().encode(response))
				await tls.close(conn, result.fd)
				os.close(result.fd)
				os.close(fd)
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
			import * as tls from 'node:tls'
			import { socket, bind, listen, accept, setsockopt, getsockname, AF_INET, SOCK_STREAM, SOL_SOCKET, SO_REUSEADDR } from 'qn_socket'
			import * as os from 'os'

			const cred = tls.loadServerCert(${JSON.stringify(certFile)}, ${JSON.stringify(keyFile)})

			const fd = socket(AF_INET, SOCK_STREAM)
			setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, 1)
			bind(fd, '127.0.0.1', 0)
			listen(fd, 1)
			const addr = getsockname(fd)
			console.log(addr.port)

			os.setReadHandler(fd, async () => {
				const result = accept(fd)
				if (!result) return
				os.setReadHandler(fd, null)

				const conn = tls.accept(result.fd, cred)
				await tls.handshake(conn, result.fd)

				// Read until we have complete headers + body
				const buf = new ArrayBuffer(65536)
				let accumulated = new Uint8Array(0)
				while (true) {
					const n = await tls.read(conn, result.fd, buf, 0, 65536)
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
				await tls.writeAll(conn, result.fd, new TextEncoder().encode(response))
				await tls.close(conn, result.fd)
				os.close(result.fd)
				os.close(fd)
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
			import * as tls from 'node:tls'
			import { socket, bind, listen, accept, setsockopt, getsockname, AF_INET, SOCK_STREAM, SOL_SOCKET, SO_REUSEADDR } from 'qn_socket'
			import * as os from 'os'

			const cred = tls.loadServerCert(${JSON.stringify(certFile)}, ${JSON.stringify(keyFile)})

			const fd = socket(AF_INET, SOCK_STREAM)
			setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, 1)
			bind(fd, '127.0.0.1', 0)
			listen(fd, 2)
			const addr = getsockname(fd)
			console.log(addr.port)

			let count = 0
			os.setReadHandler(fd, async () => {
				const result = accept(fd)
				if (!result) return

				const conn = tls.accept(result.fd, cred)
				await tls.handshake(conn, result.fd)

				const buf = new ArrayBuffer(65536)
				await tls.read(conn, result.fd, buf, 0, 65536)

				count++
				const body = 'request ' + count
				const response = 'HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: ' + body.length + '\\r\\nConnection: close\\r\\n\\r\\n' + body
				await tls.writeAll(conn, result.fd, new TextEncoder().encode(response))
				await tls.close(conn, result.fd)
				os.close(result.fd)

				if (count >= 2) {
					os.setReadHandler(fd, null)
					os.close(fd)
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

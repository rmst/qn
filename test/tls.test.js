import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { testQnOnly, execAsync } from './util.js'

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

	testQnOnly('TLS connect and read from local HTTPS server', async ({ bin, dir }) => {
		const { port, close } = await startHttpsServer()
		try {
			writeFileSync(`${dir}/test.js`, `
				import { tlsLoadCACerts, tlsConnect, tlsRead, tlsWriteAll, tlsFlush, tlsClose } from 'qn_tls'
				import { socket, connect, connectFinish, getaddrinfo, AF_INET, SOCK_STREAM, EINPROGRESS } from 'qn_socket'
				import * as os from 'os'

				tlsLoadCACerts(${JSON.stringify(certFile)})
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
				const tls = tlsConnect(fd, 'localhost')
				const req = 'GET /text HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n'
				const reqBytes = new TextEncoder().encode(req)
				const reqBuf = reqBytes.buffer.slice(reqBytes.byteOffset, reqBytes.byteOffset + reqBytes.byteLength)
				tlsWriteAll(tls, reqBuf, 0, reqBytes.byteLength)
				tlsFlush(tls)
				const buf = new ArrayBuffer(65536)
				const n = tlsRead(tls, buf, 0, 65536)
				const text = new TextDecoder().decode(new Uint8Array(buf, 0, n))
				console.log(text.startsWith('HTTP/1.1 200') ? 'ok' : 'bad: ' + text.substring(0, 50))
				tlsClose(tls)
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
})

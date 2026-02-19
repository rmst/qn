import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { testQnOnly, execAsync } from './util.js'

describe('async DNS via node:net', () => {
	testQnOnly('Socket.connect with localhost resolves asynchronously', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createServer, createConnection } from 'node:net'

			const server = createServer((socket) => {
				socket.on('data', (data) => {
					const text = new TextDecoder().decode(data)
					socket.write('echo:' + text)
				})
				socket.on('end', () => {
					server.close()
				})
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, 'localhost', () => {
					client.write('hello')
				})
				client.on('data', (data) => {
					console.log(new TextDecoder().decode(data))
					client.end()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'echo:hello')
		})
	})

	testQnOnly('Socket.connect with IP address', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createServer, createConnection } from 'node:net'

			const server = createServer((socket) => {
				socket.write('ok')
				socket.end()
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1')
				client.on('data', (data) => {
					console.log(new TextDecoder().decode(data))
				})
				client.on('close', () => server.close())
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'ok')
		})
	})

	testQnOnly('multiple concurrent connections with async DNS', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createServer, createConnection } from 'node:net'

			let responses = []
			let count = 0

			const server = createServer((socket) => {
				socket.on('data', (data) => {
					const text = new TextDecoder().decode(data)
					socket.write('reply:' + text)
					socket.end()
				})
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				for (let i = 0; i < 3; i++) {
					const client = createConnection(addr.port, 'localhost', () => {
						client.write('msg' + i)
					})
					client.on('data', (data) => {
						responses.push(new TextDecoder().decode(data))
					})
					client.on('close', () => {
						count++
						if (count === 3) {
							responses.sort()
							console.log(responses.join(','))
							server.close()
						}
					})
				}
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'reply:msg0,reply:msg1,reply:msg2')
		})
	})
})

describe('async DNS via node:fetch', () => {
	testQnOnly('fetch to localhost HTTP server', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createServer } from 'node:http'

			const server = createServer((req, res) => {
				res.writeHead(200, { 'Content-Type': 'text/plain' })
				res.end('hello from server')
			})

			server.listen(0, '127.0.0.1', async () => {
				const addr = server.address()
				try {
					const resp = await fetch('http://localhost:' + addr.port + '/')
					const text = await resp.text()
					console.log(text)
				} finally {
					server.close()
				}
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'hello from server')
		})
	})

	testQnOnly('fetch to 127.0.0.1 HTTP server', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createServer } from 'node:http'

			const server = createServer((req, res) => {
				res.writeHead(200, { 'Content-Type': 'text/plain' })
				res.end('ip-direct')
			})

			server.listen(0, '127.0.0.1', async () => {
				const addr = server.address()
				try {
					const resp = await fetch('http://127.0.0.1:' + addr.port + '/')
					const text = await resp.text()
					console.log(text)
				} finally {
					server.close()
				}
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'ip-direct')
		})
	})
})

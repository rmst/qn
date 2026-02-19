import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { testQnOnly, execAsync } from './util.js'

describe('getaddrinfoAsync native', () => {
	testQnOnly('resolves localhost to 127.0.0.1', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as os from 'os'
			import { setReadHandler } from 'qn_vm'
			import { getaddrinfoAsync, AF_INET, EAGAIN } from 'qn_socket'
			const fd = getaddrinfoAsync('localhost', 80, { family: AF_INET })
			setReadHandler(fd, () => {
				const buf = new ArrayBuffer(4096)
				const n = os.read(fd, buf, 0, 4096)
				if (n === -EAGAIN) return
				setReadHandler(fd, null)
				os.close(fd)
				const view = new Uint8Array(buf, 0, n)
				const status = view[0]
				const count = view[1]
				const family = view[2]
				let end = 3
				while (end < n && view[end] !== 0) end++
				const address = new TextDecoder().decode(view.subarray(3, end))
				console.log(JSON.stringify({ status, count, family, address }))
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const result = JSON.parse(output)
			assert.equal(result.status, 0)
			assert.ok(result.count > 0)
			assert.equal(result.family, 2) // AF_INET
			assert.equal(result.address, '127.0.0.1')
		})
	})

	testQnOnly('resolves IP literal without blocking', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as os from 'os'
			import { setReadHandler } from 'qn_vm'
			import { getaddrinfoAsync, AF_INET, EAGAIN } from 'qn_socket'
			const fd = getaddrinfoAsync('127.0.0.1', 80, { family: AF_INET })
			setReadHandler(fd, () => {
				const buf = new ArrayBuffer(4096)
				const n = os.read(fd, buf, 0, 4096)
				if (n === -EAGAIN) return
				setReadHandler(fd, null)
				os.close(fd)
				const view = new Uint8Array(buf, 0, n)
				const status = view[0]
				const count = view[1]
				const family = view[2]
				let end = 3
				while (end < n && view[end] !== 0) end++
				const address = new TextDecoder().decode(view.subarray(3, end))
				console.log(JSON.stringify({ status, count, family, address }))
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const result = JSON.parse(output)
			assert.equal(result.status, 0)
			assert.equal(result.count, 1)
			assert.equal(result.family, 2)
			assert.equal(result.address, '127.0.0.1')
		})
	})

	testQnOnly('returns error for invalid hostname', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as os from 'os'
			import { setReadHandler } from 'qn_vm'
			import { getaddrinfoAsync, EAGAIN } from 'qn_socket'
			const fd = getaddrinfoAsync('this.host.does.not.exist.invalid', 80)
			setReadHandler(fd, () => {
				const buf = new ArrayBuffer(4096)
				const n = os.read(fd, buf, 0, 4096)
				if (n === -EAGAIN) return
				setReadHandler(fd, null)
				os.close(fd)
				const view = new Uint8Array(buf, 0, n)
				const status = view[0]
				console.log('status:' + status)
				if (status !== 0) {
					let end = 1
					while (end < n && view[end] !== 0) end++
					const errMsg = new TextDecoder().decode(view.subarray(1, end))
					console.log('error:' + errMsg)
				}
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const lines = output.split('\n')
			assert.ok(parseInt(lines[0].split(':')[1]) !== 0, 'status should be nonzero')
			assert.ok(lines[1].startsWith('error:'), 'should have error message')
		})
	})

	testQnOnly('returns fd synchronously, result comes via event loop', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as os from 'os'
			import { setReadHandler } from 'qn_vm'
			import { getaddrinfoAsync, AF_INET, EAGAIN } from 'qn_socket'

			const fd = getaddrinfoAsync('localhost', 80, { family: AF_INET })
			console.log('fd_type:' + typeof fd)
			console.log('fd_valid:' + (fd >= 0))

			let resolved = false
			setReadHandler(fd, () => {
				const buf = new ArrayBuffer(4096)
				const n = os.read(fd, buf, 0, 4096)
				if (n === -EAGAIN) return
				setReadHandler(fd, null)
				os.close(fd)
				resolved = true
				console.log('resolved:true')
			})
			console.log('immediate_resolved:' + resolved)
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const lines = output.split('\n')
			assert.equal(lines[0], 'fd_type:number')
			assert.equal(lines[1], 'fd_valid:true')
			assert.equal(lines[2], 'immediate_resolved:false')
			assert.equal(lines[3], 'resolved:true')
		})
	})
})

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

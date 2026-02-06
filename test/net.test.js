import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { testQnOnly, execAsync, QN } from './util.js'

describe('qn_socket native module', () => {
	testQnOnly('constants are defined', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as sock from 'qn_socket'
			console.log(JSON.stringify({
				AF_INET: sock.AF_INET,
				AF_INET6: sock.AF_INET6,
				SOCK_STREAM: sock.SOCK_STREAM,
				SOL_SOCKET: sock.SOL_SOCKET,
				SO_REUSEADDR: sock.SO_REUSEADDR,
				TCP_NODELAY: sock.TCP_NODELAY,
				EAGAIN: sock.EAGAIN,
			}))
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const c = JSON.parse(output)
			assert.equal(c.AF_INET, 2)
			assert.equal(c.AF_INET6, 10)
			assert.equal(c.SOCK_STREAM, 1)
			assert.ok(c.SOL_SOCKET > 0)
			assert.ok(c.SO_REUSEADDR > 0)
			assert.ok(c.TCP_NODELAY > 0)
			assert.ok(c.EAGAIN > 0)
		})
	})

	testQnOnly('socket() creates fd', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { socket, AF_INET, SOCK_STREAM } from 'qn_socket'
			import * as os from 'os'
			const fd = socket(AF_INET, SOCK_STREAM)
			console.log(fd >= 0 ? 'ok' : 'fail')
			os.close(fd)
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'ok')
		})
	})

	testQnOnly('bind + listen + getsockname', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as sock from 'qn_socket'
			import * as os from 'os'
			const fd = sock.socket(sock.AF_INET, sock.SOCK_STREAM)
			sock.setsockopt(fd, sock.SOL_SOCKET, sock.SO_REUSEADDR, 1)
			sock.bind(fd, '127.0.0.1', 0)
			sock.listen(fd, 128)
			const addr = sock.getsockname(fd)
			console.log(JSON.stringify(addr))
			os.close(fd)
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const addr = JSON.parse(output)
			assert.equal(addr.address, '127.0.0.1')
			assert.ok(addr.port > 0)
			assert.equal(addr.family, 2)
		})
	})

	testQnOnly('getaddrinfo resolves localhost', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { getaddrinfo, AF_INET } from 'qn_socket'
			const results = getaddrinfo('localhost', 80, { family: AF_INET })
			console.log(JSON.stringify(results))
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const results = JSON.parse(output)
			assert.ok(results.length > 0)
			assert.equal(results[0].address, '127.0.0.1')
		})
	})

	testQnOnly('connect + accept + send + recv round trip', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import * as sock from 'qn_socket'
			import * as os from 'os'

			const sfd = sock.socket(sock.AF_INET, sock.SOCK_STREAM)
			sock.setsockopt(sfd, sock.SOL_SOCKET, sock.SO_REUSEADDR, 1)
			sock.bind(sfd, '127.0.0.1', 0)
			sock.listen(sfd, 128)
			const addr = sock.getsockname(sfd)

			const cfd = sock.socket(sock.AF_INET, sock.SOCK_STREAM)
			const ret = sock.connect(cfd, '127.0.0.1', addr.port)

			let accepted = null
			os.setReadHandler(sfd, () => {
				accepted = sock.accept(sfd)
				os.setReadHandler(sfd, null)
			})

			if (ret === -sock.EINPROGRESS) {
				os.setWriteHandler(cfd, () => {
					os.setWriteHandler(cfd, null)
					sock.connectFinish(cfd)
				})
			}

			await os.sleepAsync(50)

			console.log(accepted !== null ? 'connected' : 'fail')

			const msg = new TextEncoder().encode('hello')
			const buf = new ArrayBuffer(msg.byteLength)
			new Uint8Array(buf).set(msg)
			sock.send(cfd, buf, 0, msg.byteLength)

			await os.sleepAsync(50)

			const recvBuf = new ArrayBuffer(1024)
			const n = sock.recv(accepted.fd, recvBuf, 0, 1024)
			const received = new TextDecoder().decode(new Uint8Array(recvBuf, 0, n))
			console.log(received)

			os.close(cfd)
			os.close(accepted.fd)
			os.close(sfd)
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const lines = output.split('\n')
			assert.equal(lines[0], 'connected')
			assert.equal(lines[1], 'hello')
		})
	})
})

describe('node:net Server', () => {
	testQnOnly('server listens and accepts connections', ({ bin, dir }) => {
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
				const client = createConnection(addr.port, '127.0.0.1', () => {
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

	testQnOnly('server.address() returns correct info', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createServer } from 'node:net'

			const server = createServer()
			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				console.log(JSON.stringify(addr))
				server.close()
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const addr = JSON.parse(output)
			assert.equal(addr.address, '127.0.0.1')
			assert.ok(addr.port > 0)
			assert.equal(addr.family, 'IPv4')
		})
	})

	testQnOnly('multiple clients', ({ bin, dir }) => {
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
					const client = createConnection(addr.port, '127.0.0.1', () => {
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

	testQnOnly('Socket.setNoDelay', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createServer, createConnection } from 'node:net'

			const server = createServer((socket) => {
				socket.setNoDelay(true)
				socket.write('ok')
				socket.end()
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1')
				client.setNoDelay(true)
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

	testQnOnly('server close destroys connections', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createServer, createConnection } from 'node:net'

			const server = createServer((socket) => {
				// don't close socket, let server.close() handle it
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1', () => {
					server.close(() => {
						console.log('closed')
					})
				})
				client.on('close', () => {})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'closed')
		})
	})

	testQnOnly('large data transfer', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createServer, createConnection } from 'node:net'

			const size = 256 * 1024
			const data = new Uint8Array(size)
			for (let i = 0; i < size; i++) data[i] = i & 0xff

			const server = createServer((socket) => {
				socket.write(data)
				socket.end()
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				let totalLen = 0
				let first = null
				const client = createConnection(addr.port, '127.0.0.1')
				client.on('data', (chunk) => {
					if (!first) first = chunk
					totalLen += chunk.length
				})
				client.on('end', () => {
					console.log('size:' + totalLen)
					console.log('start:' + first[0] + ',' + first[1] + ',' + first[2])
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			const lines = output.split('\n')
			assert.equal(lines[0], 'size:262144')
			assert.equal(lines[1], 'start:0,1,2')
		})
	})
})

describe('node:net Socket client', () => {
	testQnOnly('connect event fires', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createServer, Socket } from 'node:net'

			const server = createServer()
			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const sock = new Socket()
				sock.connect({ port: addr.port, host: '127.0.0.1' }, () => {
					console.log('connected')
					sock.destroy()
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'connected')
		})
	})

	testQnOnly('write and read', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createServer, createConnection } from 'node:net'

			const server = createServer((socket) => {
				socket.on('data', (data) => {
					const text = new TextDecoder().decode(data)
					socket.write(text.split('').reverse().join(''))
					socket.end()
				})
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				const client = createConnection(addr.port, '127.0.0.1', () => {
					client.write('abcdef')
				})
				client.on('data', (data) => {
					console.log(new TextDecoder().decode(data))
				})
				client.on('close', () => server.close())
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'fedcba')
		})
	})

	testQnOnly('end event on server disconnect', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createServer, createConnection } from 'node:net'

			const server = createServer((socket) => {
				socket.end('goodbye')
			})

			server.listen(0, '127.0.0.1', () => {
				const addr = server.address()
				let chunks = []
				const client = createConnection(addr.port, '127.0.0.1')
				client.on('data', (data) => {
					chunks.push(new TextDecoder().decode(data))
				})
				client.on('end', () => {
					console.log('end:' + chunks.join(''))
					server.close()
				})
			})
		`)
		return execAsync(bin, [`${dir}/test.js`]).then(output => {
			assert.equal(output, 'end:goodbye')
		})
	})
})

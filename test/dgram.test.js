import { describe, it } from 'node:test'
import assert from 'node:assert'
import dgram from 'node:dgram'

describe('node:dgram', () => {

	it('send and receive a message on localhost', async () => {
		const server = dgram.createSocket('udp4')
		const client = dgram.createSocket('udp4')

		const received = new Promise((resolve, reject) => {
			server.on('message', (msg, rinfo) => {
				resolve({ msg, rinfo })
			})
			server.on('error', reject)
		})

		server.bind(0, '127.0.0.1', () => {
			const addr = server.address()
			client.send('hello udp', addr.port, '127.0.0.1')
		})

		const { msg, rinfo } = await received
		assert.strictEqual(new TextDecoder().decode(msg), 'hello udp')
		assert.strictEqual(rinfo.address, '127.0.0.1')
		assert.strictEqual(rinfo.family, 'IPv4')
		assert.strictEqual(typeof rinfo.port, 'number')

		client.close()
		server.close()
	})

	it('send Uint8Array data', async () => {
		const server = dgram.createSocket('udp4')
		const client = dgram.createSocket('udp4')

		const received = new Promise((resolve) => {
			server.on('message', (msg) => resolve(msg))
		})

		server.bind(0, '127.0.0.1', () => {
			const addr = server.address()
			const data = new Uint8Array([1, 2, 3, 4, 5])
			client.send(data, addr.port, '127.0.0.1')
		})

		const msg = await received
		assert.deepStrictEqual(Array.from(msg), [1, 2, 3, 4, 5])

		client.close()
		server.close()
	})

	it('multiple messages', async () => {
		const server = dgram.createSocket('udp4')
		const client = dgram.createSocket('udp4')

		const messages = []
		const allReceived = new Promise((resolve) => {
			server.on('message', (msg) => {
				messages.push(new TextDecoder().decode(msg))
				if (messages.length === 3) resolve()
			})
		})

		server.bind(0, '127.0.0.1', () => {
			const addr = server.address()
			client.send('one', addr.port, '127.0.0.1')
			client.send('two', addr.port, '127.0.0.1')
			client.send('three', addr.port, '127.0.0.1')
		})

		await allReceived
		assert.deepStrictEqual(messages.sort(), ['one', 'three', 'two'])

		client.close()
		server.close()
	})

	it('auto-bind on send', async () => {
		const server = dgram.createSocket('udp4')
		const client = dgram.createSocket('udp4')

		const received = new Promise((resolve) => {
			server.on('message', (msg, rinfo) => resolve({ msg, rinfo }))
		})

		server.bind(0, '127.0.0.1', () => {
			const addr = server.address()
			// Client not explicitly bound — should auto-bind
			client.send('auto', addr.port, '127.0.0.1')
		})

		const { msg, rinfo } = await received
		assert.strictEqual(new TextDecoder().decode(msg), 'auto')
		// Client should have been auto-bound to some port
		assert.strictEqual(typeof rinfo.port, 'number')
		assert.ok(rinfo.port > 0)

		client.close()
		server.close()
	})

	it('address() returns bound address', () => {
		const socket = dgram.createSocket('udp4')
		socket.bind(0, '127.0.0.1', () => {
			const addr = socket.address()
			assert.strictEqual(addr.address, '127.0.0.1')
			assert.strictEqual(addr.family, 'IPv4')
			assert.strictEqual(typeof addr.port, 'number')
			assert.ok(addr.port > 0)
			socket.close()
		})
	})

	it('close event fires', async () => {
		const socket = dgram.createSocket('udp4')
		const closed = new Promise((resolve) => {
			socket.on('close', resolve)
		})
		socket.bind(0, '127.0.0.1', () => {
			socket.close()
		})
		await closed
	})

	it('close with callback', async () => {
		const socket = dgram.createSocket('udp4')
		const closed = new Promise((resolve) => {
			socket.bind(0, '127.0.0.1', () => {
				socket.close(resolve)
			})
		})
		await closed
	})

	it('setBroadcast does not throw', () => {
		const socket = dgram.createSocket('udp4')
		socket.bind(0, '127.0.0.1', () => {
			socket.setBroadcast(true)
			socket.setBroadcast(false)
			socket.close()
		})
	})

	it('setTTL does not throw', () => {
		const socket = dgram.createSocket('udp4')
		socket.bind(0, '127.0.0.1', () => {
			socket.setTTL(128)
			socket.close()
		})
	})

	it('createSocket with message callback', async () => {
		const received = new Promise((resolve) => {
			const server = dgram.createSocket('udp4', (msg, rinfo) => {
				resolve({ msg, rinfo, server })
			})
			server.bind(0, '127.0.0.1', () => {
				const client = dgram.createSocket('udp4')
				client.send('callback', server.address().port, '127.0.0.1', () => {
					client.close()
				})
			})
		})

		const { msg, server } = await received
		assert.strictEqual(new TextDecoder().decode(msg), 'callback')
		server.close()
	})

	it('send with callback', async () => {
		const server = dgram.createSocket('udp4')
		const client = dgram.createSocket('udp4')

		const sent = new Promise((resolve, reject) => {
			server.bind(0, '127.0.0.1', () => {
				client.send('cb-test', server.address().port, '127.0.0.1', (err) => {
					if (err) reject(err)
					else resolve()
				})
			})
		})

		await sent
		client.close()
		server.close()
	})

	it('echo server', async () => {
		const server = dgram.createSocket('udp4')
		server.on('message', (msg, rinfo) => {
			server.send(msg, rinfo.port, rinfo.address)
		})

		const client = dgram.createSocket('udp4')
		const reply = new Promise((resolve) => {
			client.on('message', (msg) => resolve(new TextDecoder().decode(msg)))
		})

		server.bind(0, '127.0.0.1', () => {
			client.send('echo me', server.address().port, '127.0.0.1')
		})

		const response = await reply
		assert.strictEqual(response, 'echo me')

		client.close()
		server.close()
	})
})

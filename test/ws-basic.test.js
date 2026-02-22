import { test } from 'node:test'
import assert from 'node:assert'
import { WebSocket, WebSocketServer } from 'ws'

test('ws module exports', () => {
	assert.strictEqual(typeof WebSocket, 'function')
	assert.strictEqual(typeof WebSocketServer, 'function')
})

test('WebSocket server basic echo', async () => {
	const wss = new WebSocketServer({ port: 0 })

	await new Promise((resolve, reject) => {
		wss.on('listening', resolve)
		wss.on('error', reject)
	})

	const addr = wss.address()
	const port = addr.port

	const client = new WebSocket(`ws://127.0.0.1:${port}`)

	// Server side: echo messages back
	wss.on('connection', (ws) => {
		ws.on('message', (data, isBinary) => {
			ws.send(data)
		})
	})

	// Client side: send and receive
	const received = await new Promise((resolve, reject) => {
		client.on('open', () => {
			client.send('hello world')
		})
		client.on('message', (data) => {
			resolve(data.toString())
		})
		client.on('error', reject)
		setTimeout(() => reject(new Error('timeout')), 5000)
	})

	assert.strictEqual(received, 'hello world')

	// Clean close
	await new Promise((resolve) => {
		client.on('close', resolve)
		client.close()
	})

	await new Promise((resolve) => {
		wss.close(resolve)
	})
})

test('WebSocket server binary messages', async () => {
	const wss = new WebSocketServer({ port: 0 })

	await new Promise((resolve) => wss.on('listening', resolve))
	const port = wss.address().port

	wss.on('connection', (ws) => {
		ws.on('message', (data) => {
			ws.send(data)
		})
	})

	const client = new WebSocket(`ws://127.0.0.1:${port}`)

	const received = await new Promise((resolve, reject) => {
		client.on('open', () => {
			const buf = Buffer.from([1, 2, 3, 4, 5])
			client.send(buf)
		})
		client.on('message', (data, isBinary) => {
			assert.ok(isBinary)
			resolve(data)
		})
		client.on('error', reject)
		setTimeout(() => reject(new Error('timeout')), 5000)
	})

	assert.deepStrictEqual(Buffer.from(received), Buffer.from([1, 2, 3, 4, 5]))

	client.close()
	await new Promise((resolve) => wss.close(resolve))
})

test('WebSocket close codes', async () => {
	const wss = new WebSocketServer({ port: 0 })

	await new Promise((resolve) => wss.on('listening', resolve))
	const port = wss.address().port

	wss.on('connection', (ws) => {
		ws.close(1000, 'normal closure')
	})

	const client = new WebSocket(`ws://127.0.0.1:${port}`)

	const { code, reason } = await new Promise((resolve, reject) => {
		client.on('close', (code, reason) => {
			resolve({ code, reason: reason.toString() })
		})
		client.on('error', reject)
		setTimeout(() => reject(new Error('timeout')), 5000)
	})

	assert.strictEqual(code, 1000)
	assert.strictEqual(reason, 'normal closure')

	await new Promise((resolve) => wss.close(resolve))
})

test('WebSocket multiple clients', async () => {
	const wss = new WebSocketServer({ port: 0 })

	await new Promise((resolve) => wss.on('listening', resolve))
	const port = wss.address().port

	const messages = []
	wss.on('connection', (ws) => {
		ws.on('message', (data) => {
			messages.push(data.toString())
			ws.send('ack')
		})
	})

	const client1 = new WebSocket(`ws://127.0.0.1:${port}`)
	const client2 = new WebSocket(`ws://127.0.0.1:${port}`)

	const p1 = new Promise((resolve, reject) => {
		client1.on('open', () => client1.send('from-1'))
		client1.on('message', resolve)
		client1.on('error', reject)
	})

	const p2 = new Promise((resolve, reject) => {
		client2.on('open', () => client2.send('from-2'))
		client2.on('message', resolve)
		client2.on('error', reject)
	})

	await Promise.all([p1, p2])

	assert.ok(messages.includes('from-1'))
	assert.ok(messages.includes('from-2'))
	assert.strictEqual(wss.clients.size, 2)

	client1.close()
	client2.close()
	await new Promise((resolve) => wss.close(resolve))
})

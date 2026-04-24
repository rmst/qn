import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, $ } from './util.js'

describe('node:events shim', () => {
	test('EventEmitter on and emit', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { EventEmitter } from 'node:events'
			const emitter = new EventEmitter()
			let received = null
			emitter.on('test', (data) => { received = data })
			emitter.emit('test', 'hello')
			console.log(JSON.stringify({ received }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { received: 'hello' })
	})

	test('EventEmitter once fires only once', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { EventEmitter } from 'node:events'
			const emitter = new EventEmitter()
			let count = 0
			emitter.once('test', () => { count++ })
			emitter.emit('test')
			emitter.emit('test')
			console.log(JSON.stringify({ count }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { count: 1 })
	})

	test('EventEmitter removeListener', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { EventEmitter } from 'node:events'
			const emitter = new EventEmitter()
			let count = 0
			const handler = () => { count++ }
			emitter.on('test', handler)
			emitter.emit('test')
			emitter.removeListener('test', handler)
			emitter.emit('test')
			console.log(JSON.stringify({ count }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { count: 1 })
	})

	test('EventEmitter removeAllListeners', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { EventEmitter } from 'node:events'
			const emitter = new EventEmitter()
			let count = 0
			emitter.on('test', () => { count++ })
			emitter.on('test', () => { count++ })
			emitter.emit('test')
			emitter.removeAllListeners('test')
			emitter.emit('test')
			console.log(JSON.stringify({ count }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { count: 2 })
	})

	test('EventEmitter emit returns boolean', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { EventEmitter } from 'node:events'
			const emitter = new EventEmitter()
			const noListeners = emitter.emit('test')
			emitter.on('test', () => {})
			const hasListeners = emitter.emit('test')
			console.log(JSON.stringify({ noListeners, hasListeners }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { noListeners: false, hasListeners: true })
	})

	test('EventEmitter listenerCount', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { EventEmitter } from 'node:events'
			const emitter = new EventEmitter()
			emitter.on('test', () => {})
			emitter.on('test', () => {})
			emitter.on('other', () => {})
			console.log(JSON.stringify({
				testCount: emitter.listenerCount('test'),
				otherCount: emitter.listenerCount('other'),
				noneCount: emitter.listenerCount('none')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			testCount: 2,
			otherCount: 1,
			noneCount: 0
		})
	})

	test('EventEmitter eventNames', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { EventEmitter } from 'node:events'
			const emitter = new EventEmitter()
			emitter.on('foo', () => {})
			emitter.on('bar', () => {})
			console.log(JSON.stringify({ names: emitter.eventNames().sort() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { names: ['bar', 'foo'] })
	})

	test('EventEmitter multiple arguments', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { EventEmitter } from 'node:events'
			const emitter = new EventEmitter()
			let args = null
			emitter.on('test', (a, b, c) => { args = [a, b, c] })
			emitter.emit('test', 1, 'two', { three: 3 })
			console.log(JSON.stringify({ args }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { args: [1, 'two', { three: 3 }] })
	})

	test('EventEmitter error event with no listeners throws', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { EventEmitter } from 'node:events'
			const emitter = new EventEmitter()
			let threw = false
			let errorMsg = ''
			try {
				emitter.emit('error', new Error('test error'))
			} catch (e) {
				threw = true
				errorMsg = e.message
			}
			console.log(JSON.stringify({ threw, errorMsg }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true, errorMsg: 'test error' })
	})

	test('EventEmitter error event with listener does not throw', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { EventEmitter } from 'node:events'
			const emitter = new EventEmitter()
			let caught = null
			emitter.on('error', (err) => { caught = err.message })
			emitter.emit('error', new Error('handled error'))
			console.log(JSON.stringify({ caught }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { caught: 'handled error' })
	})

	test('EventEmitter prependListener fires first', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { EventEmitter } from 'node:events'
			const emitter = new EventEmitter()
			const order = []
			emitter.on('test', () => order.push('first'))
			emitter.prependListener('test', () => order.push('prepended'))
			emitter.emit('test')
			console.log(JSON.stringify({ order }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { order: ['prepended', 'first'] })
	})
})

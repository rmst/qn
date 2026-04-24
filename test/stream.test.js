import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, $ } from './util.js'

describe('node:stream shim', () => {
	test('Readable emits data and end events', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('echo', ['hello'])
			const events = []
			child.stdout.on('data', () => events.push('data'))
			child.stdout.on('end', () => events.push('end'))
			child.on('close', () => {
				console.log(JSON.stringify({ events }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.events.includes('data'))
		assert.ok(result.events.includes('end'))
		assert.ok(result.events.indexOf('data') < result.events.indexOf('end'))
	})

	test('Readable pause returns self for chaining', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('echo', ['test'])
			const returnValue = child.stdout.pause()
			const isSelf = returnValue === child.stdout
			child.stdout.resume()
			child.on('close', () => {
				console.log(JSON.stringify({ isSelf }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isSelf: true })
	})

	test('Writable write and end', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('cat')
			child.stdout.setEncoding('utf8')
			let output = ''
			child.stdout.on('data', (chunk) => { output += chunk })
			child.on('close', () => {
				console.log(JSON.stringify({ output: output.trim() }))
			})
			child.stdin.write('first ')
			child.stdin.write('second')
			child.stdin.end()
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'first second' })
	})

	test('Writable end with chunk', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('cat')
			child.stdout.setEncoding('utf8')
			let output = ''
			child.stdout.on('data', (chunk) => { output += chunk })
			child.on('close', () => {
				console.log(JSON.stringify({ output: output.trim() }))
			})
			child.stdin.write('first ')
			child.stdin.end('last')
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'first last' })
	})

	test('Writable finish event', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('cat')
			let finishEmitted = false
			child.stdin.on('finish', () => { finishEmitted = true })
			child.on('close', () => {
				console.log(JSON.stringify({ finishEmitted }))
			})
			child.stdin.end('data')
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { finishEmitted: true })
	})

	test('Readable close event', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('echo', ['test'])
			let closeEmitted = false
			child.stdout.on('close', () => {
				closeEmitted = true
				console.log(JSON.stringify({ closeEmitted }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { closeEmitted: true })
	})

	test('Readable destroyed property', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('echo', ['test'])
			const beforeClose = child.stdout.destroyed
			child.on('close', () => {
				const afterClose = child.stdout.destroyed
				console.log(JSON.stringify({ beforeClose, afterClose }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.beforeClose, false)
		assert.strictEqual(result.afterClose, true)
	})

	test('Writable destroyed property', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('cat')
			const beforeEnd = child.stdin.destroyed
			child.stdin.on('close', () => {
				const afterClose = child.stdin.destroyed
				console.log(JSON.stringify({ beforeEnd, afterClose }))
			})
			child.stdin.end('x')
			// Keep event loop alive until stdin closes
			child.on('close', () => {})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.beforeEnd, false)
		assert.strictEqual(result.afterClose, true)
	})
})

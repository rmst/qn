import { describe, test as nodetest } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, rmSync } from 'node:fs'
import { test, $, mktempdir, QN } from './util.js'

describe('timer globals', () => {
	test('setTimeout works', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			setTimeout(() => console.log('done'), 10)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'done')
	})

	test('clearTimeout cancels timer', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const handle = setTimeout(() => console.log('should not print'), 10)
			clearTimeout(handle)
			setTimeout(() => console.log('done'), 20)
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'done')
	})

	// qn specific tests (behavior differs from Node.js)
	nodetest('setTimeout with extra args throws NodeCompatibilityError [qn]', () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/test.js`, `
				try {
					setTimeout(console.log, 10, 'arg1', 'arg2')
					console.log('no error')
				} catch (e) {
					console.log(e.name)
				}
			`)
			const output = $`${QN()} ${dir}/test.js`
			assert.strictEqual(output, 'NodeCompatibilityError')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	nodetest('setInterval throws NodeCompatibilityError [qn]', () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/test.js`, `
				try {
					setInterval(() => {}, 10)
					console.log('no error')
				} catch (e) {
					console.log(e.name)
				}
			`)
			const output = $`${QN()} ${dir}/test.js`
			assert.strictEqual(output, 'NodeCompatibilityError')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	nodetest('clearInterval throws NodeCompatibilityError [qn]', () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/test.js`, `
				try {
					clearInterval(123)
					console.log('no error')
				} catch (e) {
					console.log(e.name)
				}
			`)
			const output = $`${QN()} ${dir}/test.js`
			assert.strictEqual(output, 'NodeCompatibilityError')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

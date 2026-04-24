import { describe, test } from 'node:test'
import assert from 'node:assert'
import { QN, QX, $ } from './util.js'

describe('-e flag', () => {
	test('qn -e evaluates code', () => {
		const output = $`${QN()} -e "console.log(1+2)"`
		assert.strictEqual(output, '3')
	})

	test('qn -e has access to globals', () => {
		const output = $`${QN()} -e "console.log(typeof console.log)"`
		assert.strictEqual(output, 'function')
	})

	test('qn -e with empty string exits cleanly', () => {
		const output = $`${QN()} -e ""`
		assert.strictEqual(output, '')
	})

	test('qx -e evaluates code', () => {
		const output = $`${QX()} -e "console.log(1+2)"`
		assert.strictEqual(output, '3')
	})

	test('qx -e has access to $ global', () => {
		const output = $`${QX()} -e "console.log(typeof $)"`
		assert.strictEqual(output, 'function')
	})

	test('qx -e with empty string exits cleanly', () => {
		const output = $`${QX()} -e ""`
		assert.strictEqual(output, '')
	})
})

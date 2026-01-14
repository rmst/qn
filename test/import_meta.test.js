import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { platform } from 'node:os'
import { test, $ } from './util.js'

const QJSX = resolve(`./bin/${platform()}/qjsx`)

describe('import.meta', () => {
	test('dirname and filename for entry module', ({ dir }) => {
		writeFileSync(`${dir}/entry.js`, `
			console.log(JSON.stringify({
				dirname: import.meta.dirname,
				filename: import.meta.filename
			}))
		`)

		const output = $`${QJSX} -m ${dir}/entry.js`
		const result = JSON.parse(output)

		assert.strictEqual(result.dirname, dir)
		assert.strictEqual(result.filename, `${dir}/entry.js`)
	})

	test('dirname and filename for imported module', ({ dir }) => {
		mkdirSync(`${dir}/sub`)
		writeFileSync(`${dir}/sub/mod.js`, `
			export const meta = {
				dirname: import.meta.dirname,
				filename: import.meta.filename
			}
		`)
		writeFileSync(`${dir}/runner.js`, `
			import { meta } from './sub/mod.js'
			console.log(JSON.stringify(meta))
		`)

		const output = $`${QJSX} -m ${dir}/runner.js`
		const result = JSON.parse(output)

		assert.strictEqual(result.dirname, `${dir}/sub`)
		assert.strictEqual(result.filename, `${dir}/sub/mod.js`)
	})

	test('import.meta.url is valid file URL', ({ dir }) => {
		writeFileSync(`${dir}/entry.js`, `
			console.log(JSON.stringify({ url: import.meta.url }))
		`)

		const output = $`${QJSX} -m ${dir}/entry.js`
		const result = JSON.parse(output)

		assert.ok(result.url.startsWith('file://'), `Expected file:// URL, got: ${result.url}`)
		assert.ok(result.url.endsWith('/entry.js'), `Expected to end with /entry.js, got: ${result.url}`)
	})
})

import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test, testQnodeOnly, $ } from './util.js'

describe('node:process shim', () => {
	test('process.argv structure matches Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({
				length: process.argv.length,
				argv0Type: typeof process.argv[0],
				argv1: process.argv[1],
				argv2: process.argv[2],
				argv3: process.argv[3]
			}))
		`)

		const output = $`${bin} ${dir}/test.js arg1 arg2`
		const result = JSON.parse(output)

		// argv[0] = interpreter path, argv[1] = script path, argv[2+] = user args
		assert.strictEqual(result.length, 4)
		assert.strictEqual(result.argv0Type, 'string')
		assert.strictEqual(result.argv1, `${dir}/test.js`)
		assert.strictEqual(result.argv2, 'arg1')
		assert.strictEqual(result.argv3, 'arg2')
	})

	test('process.cwd matches Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ cwd: process.cwd() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		// cwd should be a non-empty string
		const result = JSON.parse(output)
		assert.strictEqual(typeof result.cwd, 'string')
		assert.ok(result.cwd.length > 0)
	})

	test('process.env reads environment variable', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ home: typeof process.env.HOME }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { home: 'string' })
	})

	test('process.env returns undefined for missing var', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			const val = process.env.DEFINITELY_NOT_SET_12345
			console.log(JSON.stringify({ isUndefined: val === undefined }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isUndefined: true })
	})

	test('process.pid is a number', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ pidType: typeof process.pid, isPositive: process.pid > 0 }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { pidType: 'number', isPositive: true })
	})

	test('process.platform is a string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ platformType: typeof process.platform }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { platformType: 'string' })
	})

	test('process.version is a string starting with v', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			console.log(JSON.stringify({ startsWithV: process.version.startsWith('v') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { startsWithV: true })
	})

	test('process.stdout.write works', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			process.stdout.write('direct output')
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'direct output')
	})

	test('named imports from process work', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { cwd, pid, platform, env } from 'node:process'
			console.log(JSON.stringify({
				cwdType: typeof cwd,
				pidType: typeof pid,
				platformType: typeof platform,
				envType: typeof env
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			cwdType: 'function',
			pidType: 'number',
			platformType: 'string',
			envType: 'object'
		})
	})

	test('process.exitCode sets exit code', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			process.exitCode = 42
		`)

		const result = spawnSync(bin, [`${dir}/test.js`], { encoding: 'utf8' })
		assert.strictEqual(result.status, 42)
	})

	test('process.on exit handler is called', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			process.on('exit', (code) => {
				console.log('exit handler called with code ' + code)
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'exit handler called with code 0')
	})

	test('process.on exit handler receives exitCode', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import process from 'node:process'
			process.on('exit', (code) => {
				console.log('exit code: ' + code)
			})
			process.exitCode = 7
		`)

		const result = spawnSync(bin, [`${dir}/test.js`], { encoding: 'utf8' })
		assert.strictEqual(result.status, 7)
		assert.strictEqual(result.stdout.trim(), 'exit code: 7')
	})
})

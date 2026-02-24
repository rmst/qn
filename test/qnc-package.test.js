import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { test, testQnOnly, $, QN, QNC } from './util.js'

const FIXTURES = resolve(dirname(import.meta.filename), 'fixtures')
const NATIVE_FIXTURE = join(FIXTURES, 'native-test')

describe('qnc package', () => {
	test('builds .so from fixture and loads it', ({ dir }) => {
		// Copy fixture into temp dir so we don't pollute the repo
		mkdirSync(`${dir}/pkg`)
		copyFileSync(join(NATIVE_FIXTURE, 'test_native.c'), `${dir}/pkg/test_native.c`)
		copyFileSync(join(NATIVE_FIXTURE, 'package.json'), `${dir}/pkg/package.json`)

		// Build the .so
		const soPath = $`${QNC()} package -o ${dir}/pkg/test_native.so ${dir}/pkg`
		assert.ok(existsSync(soPath), `.so should exist at ${soPath}`)

		// Write a JS wrapper that imports the .so
		writeFileSync(`${dir}/pkg/index.js`, `
			import { add, greeting } from './test_native.so'
			console.log(JSON.stringify({ sum: add(3, 4), msg: greeting() }))
		`)

		// Run with qn (dlopen mode)
		const output = $`${QN()} ${dir}/pkg/index.js`
		assert.deepStrictEqual(JSON.parse(output), {
			sum: 7,
			msg: "hello from native"
		})
	})

	testQnOnly('builds .so with default output path', ({ dir }) => {
		mkdirSync(`${dir}/pkg`)
		copyFileSync(join(NATIVE_FIXTURE, 'test_native.c'), `${dir}/pkg/test_native.c`)
		copyFileSync(join(NATIVE_FIXTURE, 'package.json'), `${dir}/pkg/package.json`)

		const soPath = $`${QNC()} package ${dir}/pkg`
		assert.strictEqual(soPath, `${dir}/pkg/test_native.so`)
		assert.ok(existsSync(soPath))
	})

	testQnOnly('static linking via qnc still works with fixture', ({ dir }) => {
		// Copy fixture
		mkdirSync(`${dir}/pkg`)
		copyFileSync(join(NATIVE_FIXTURE, 'test_native.c'), `${dir}/pkg/test_native.c`)
		copyFileSync(join(NATIVE_FIXTURE, 'package.json'), `${dir}/pkg/package.json`)

		// Write JS that imports the .so (qnc will statically link it)
		writeFileSync(`${dir}/pkg/index.js`, `
			import { add, greeting } from './test_native.so'
			console.log(JSON.stringify({ sum: add(10, 20), msg: greeting() }))
		`)

		// Compile to standalone binary
		$`${QNC()} -o ${dir}/app ${dir}/pkg/index.js`
		const output = $`${dir}/app`
		assert.deepStrictEqual(JSON.parse(output), {
			sum: 30,
			msg: "hello from native"
		})
	})

	testQnOnly('error on missing qnc field', ({ dir }) => {
		mkdirSync(`${dir}/pkg`)
		writeFileSync(`${dir}/pkg/package.json`, '{"name": "no-qnc"}')

		assert.throws(() => {
			$`${QNC()} package ${dir}/pkg`
		}, /no "qnc" field/)
	})

	testQnOnly('error on nonexistent directory', ({ dir }) => {
		assert.throws(() => {
			$`${QNC()} package ${dir}/nonexistent`
		}, /cannot resolve path/)
	})
})

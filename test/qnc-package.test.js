import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { platform } from 'node:os'
import { testQnOnly, $, QN, QNC, QNC_PATH } from './util.js'

const ROOT = resolve(dirname(import.meta.filename), '..')
const FIXTURES = resolve(dirname(import.meta.filename), 'fixtures')
const NATIVE_FIXTURE = join(FIXTURES, 'native-test')
const QJS_INC = join(ROOT, 'bin', platform(), 'quickjs')

describe('qnc package', { concurrency: true }, () => {
	testQnOnly('builds .so from fixture and loads it', ({ dir }) => {
		// Copy fixture into temp dir so we don't pollute the repo
		mkdirSync(`${dir}/pkg`)
		copyFileSync(join(NATIVE_FIXTURE, 'test_native.c'), `${dir}/pkg/test_native.c`)
		copyFileSync(join(NATIVE_FIXTURE, 'package.json'), `${dir}/pkg/package.json`)

		// Build the .so
		const soPath = $`${QNC_PATH()} package -o ${dir}/pkg/test_native.so ${dir}/pkg`
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

		const soPath = $`${QNC_PATH()} package ${dir}/pkg`
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

	testQnOnly('builds .so from pre-built .o via objects field', ({ dir }) => {
		mkdirSync(`${dir}/pkg`)
		copyFileSync(join(NATIVE_FIXTURE, 'test_native.c'), `${dir}/pkg/test_native.c`)

		// Pre-compile the .c to .o manually
		$`gcc -fPIC -I ${QJS_INC} -c -o ${dir}/pkg/test_native.o ${dir}/pkg/test_native.c`

		// Use objects instead of sources
		writeFileSync(`${dir}/pkg/package.json`, JSON.stringify({
			name: "test-prebuilt",
			qnc: {
				target_name: "test_native",
				objects: ["test_native.o"]
			}
		}))

		const soPath = $`${QNC_PATH()} package ${dir}/pkg`
		assert.ok(existsSync(soPath))

		writeFileSync(`${dir}/pkg/index.js`, `
			import { add, greeting } from './test_native.so'
			console.log(JSON.stringify({ sum: add(1, 2), msg: greeting() }))
		`)
		const output = $`${QN()} ${dir}/pkg/index.js`
		assert.deepStrictEqual(JSON.parse(output), {
			sum: 3,
			msg: "hello from native"
		})
	})

	testQnOnly('static linking works with objects field', ({ dir }) => {
		mkdirSync(`${dir}/pkg`)
		copyFileSync(join(NATIVE_FIXTURE, 'test_native.c'), `${dir}/pkg/test_native.c`)

		// Pre-compile to .o with renamed symbol (required for static linking)
		$`gcc -I ${QJS_INC} -Djs_init_module=js_init_module_test_native -c -o ${dir}/pkg/test_native.o ${dir}/pkg/test_native.c`

		writeFileSync(`${dir}/pkg/package.json`, JSON.stringify({
			name: "test-prebuilt",
			qnc: {
				target_name: "test_native",
				objects: ["test_native.o"]
			}
		}))

		writeFileSync(`${dir}/pkg/index.js`, `
			import { add, greeting } from './test_native.so'
			console.log(JSON.stringify({ sum: add(5, 6), msg: greeting() }))
		`)

		$`${QNC()} -o ${dir}/app ${dir}/pkg/index.js`
		const output = $`${dir}/app`
		assert.deepStrictEqual(JSON.parse(output), {
			sum: 11,
			msg: "hello from native"
		})
	})

	testQnOnly('error on missing qnc field', ({ dir }) => {
		mkdirSync(`${dir}/pkg`)
		writeFileSync(`${dir}/pkg/package.json`, '{"name": "no-qnc"}')

		assert.throws(() => {
			$`${QNC_PATH()} package ${dir}/pkg`
		}, /no "qnc" field/)
	})

	testQnOnly('error on nonexistent directory', ({ dir }) => {
		assert.throws(() => {
			$`${QNC_PATH()} package ${dir}/nonexistent`
		}, /cannot resolve path/)
	})
})

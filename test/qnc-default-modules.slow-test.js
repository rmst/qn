import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { testQnOnly, $, QNC_PATH } from './util.js'

describe('qnc default modules', () => {
	testQnOnly('compiles with all default modules included', ({ dir }) => {
		// Copy qnc to isolated dir to test fully self-contained behavior
		mkdirSync(`${dir}/bin`)
		copyFileSync(QNC_PATH(), `${dir}/bin/qnc`)

		writeFileSync(`${dir}/main.js`, `
			import { writeFileSync, readFileSync, unlinkSync } from 'node:fs'
			import { join } from 'node:path'
			import { tmpdir } from 'node:os'
			import { execSync } from 'node:child_process'
			import { createHash } from 'node:crypto'
			import { EventEmitter } from 'node:events'
			import { Buffer } from 'node:buffer'
			import { Readable } from 'node:stream'
			import assert from 'node:assert'

			// Test fs
			const tmp = join(tmpdir(), 'qnc_default_modules_test.txt')
			writeFileSync(tmp, 'hello')
			const content = readFileSync(tmp, 'utf8')
			unlinkSync(tmp)
			assert.strictEqual(content, 'hello')

			// Test crypto
			const hash = createHash('sha256').update('test').digest('hex')
			assert.strictEqual(hash.length, 64)

			// Test child_process
			const echo = execSync('echo ok').toString().trim()
			assert.strictEqual(echo, 'ok')

			// Test events
			const emitter = new EventEmitter()
			let fired = false
			emitter.on('test', () => { fired = true })
			emitter.emit('test')
			assert.strictEqual(fired, true)

			// Test buffer
			const buf = Buffer.from('hello')
			assert.strictEqual(buf.toString(), 'hello')

			// Test stream
			assert.ok(Readable)

			console.log('all ok')
		`)

		// No --no-default-modules: all modules should be available
		$`${dir}/bin/qnc --cache-dir ${dir}/cache -o ${dir}/app ${dir}/main.js`
		assert.strictEqual($`${dir}/app`, 'all ok')
	})
})
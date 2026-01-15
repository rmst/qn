import { describe, test } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, readFileSync, mkdirSync, rmSync, mkdtempSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir, platform } from 'node:os'

const QX = resolve(`./bin/${platform()}/qx`)
const EXAMPLES = resolve('./qx/examples')
const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), '/')))

describe('qx examples', () => {
	test('hello.js - default', () => {
		const output = execSync(`${QX} ${EXAMPLES}/hello.js`, { encoding: 'utf8' }).trim()
		assert.strictEqual(output, 'Hello, World!')
	})

	test('hello.js - with name', () => {
		const output = execSync(`${QX} ${EXAMPLES}/hello.js QuickJS`, { encoding: 'utf8' }).trim()
		assert.strictEqual(output, 'Hello, QuickJS!')
	})

	test('file-stats.js - lists files with sizes', () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/a.txt`, '12345')
			writeFileSync(`${dir}/b.txt`, '1234567890')

			const output = execSync(`${QX} ${EXAMPLES}/file-stats.js ${dir}`, { encoding: 'utf8' }).trim()
			const lines = output.split('\n')

			assert.ok(lines.some(l => l.includes('a.txt') && l.includes('5 bytes')))
			assert.ok(lines.some(l => l.includes('b.txt') && l.includes('10 bytes')))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('search-replace.js - replaces text', () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/test.txt`, 'foo bar foo baz foo')

			const output = execSync(
				`${QX} ${EXAMPLES}/search-replace.js ${dir}/test.txt foo replaced`,
				{ encoding: 'utf8' }
			).trim()

			assert.ok(output.includes('3 occurrence(s)'))

			const content = readFileSync(`${dir}/test.txt`, 'utf8')
			assert.strictEqual(content, 'replaced bar replaced baz replaced')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('search-replace.js - error on missing file', () => {
		try {
			execSync(`${QX} ${EXAMPLES}/search-replace.js /nonexistent foo bar`, {
				encoding: 'utf8',
				stdio: 'pipe'
			})
			assert.fail('Should have thrown')
		} catch (err) {
			assert.ok(err.stdout.includes('File not found') || err.stderr.includes('File not found'))
		}
	})

	test('search-replace.js - shows usage without args', () => {
		try {
			execSync(`${QX} ${EXAMPLES}/search-replace.js`, {
				encoding: 'utf8',
				stdio: 'pipe'
			})
			assert.fail('Should have thrown')
		} catch (err) {
			assert.ok(err.stdout.includes('Usage') || err.stderr.includes('Usage'))
		}
	})
})

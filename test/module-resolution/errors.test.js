import { describe, test as nodetest } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, rmSync, mkdtempSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QJSX } from '../util.js'

const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), 'import-error-test-')))

const $err = (strings, ...values) => {
	const cmd = String.raw({ raw: strings }, ...values)
	try {
		execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
		return null
	} catch (e) {
		return e.stderr || e.message
	}
}

const test = (name, fn) => nodetest(name, () => {
	const dir = mktempdir()
	try {
		fn({ dir })
	} finally {
		rmSync(dir, { recursive: true })
	}
})

describe('Import error messages', () => {
	test('export not found: includes importing file and line number', ({ dir }) => {
		writeFileSync(`${dir}/target.js`, `export const foo = 1;`)
		writeFileSync(`${dir}/main.js`, `// comment
// another comment
import { foo, nonexistent } from './target.js';
console.log(foo);
`)
		const err = $err`${QJSX()} ${dir}/main.js`
		assert.ok(err, 'Expected an error')
		assert.ok(err.includes("Could not find export 'nonexistent'"), `Expected export name in error: ${err}`)
		assert.ok(err.includes('target.js'), `Expected target module in error: ${err}`)
		assert.ok(err.includes('main.js:3'), `Expected importing file:line in error: ${err}`)
	})

	test('module not found: includes importing file name', ({ dir }) => {
		writeFileSync(`${dir}/main.js`, `import { foo } from './nonexistent.js';`)
		const err = $err`${QJSX()} ${dir}/main.js`
		assert.ok(err, 'Expected an error')
		assert.ok(err.includes('nonexistent.js'), `Expected missing module name in error: ${err}`)
		assert.ok(err.includes('imported from') && err.includes('main.js'), `Expected importing file in error: ${err}`)
	})

	test('module not found in chain: shows import chain', ({ dir }) => {
		writeFileSync(`${dir}/middle.js`, `import { foo } from './missing.js';\nexport const bar = 1;`)
		writeFileSync(`${dir}/main.js`, `import { bar } from './middle.js';`)
		const err = $err`${QJSX()} ${dir}/main.js`
		assert.ok(err, 'Expected an error')
		assert.ok(err.includes('missing.js'), `Expected missing module name in error: ${err}`)
		assert.ok(err.includes('imported from') && err.includes('middle.js'), `Expected intermediate file in error: ${err}`)
	})
})

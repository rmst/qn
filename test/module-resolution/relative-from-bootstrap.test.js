/**
 * Tests for relative path resolution when importing from qn/qx bootstrap.
 *
 * When a user runs `qn ./script.js`, the `./` should be relative to the current
 * working directory, NOT relative to the bootstrap module's embedded path.
 *
 * This tests the fix for the bug where `qn './non-existing-file.js'` would
 * report an error about 'node/non-existing-file.js' instead of './non-existing-file.js'.
 */
import { describe, test as nodetest } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, rmSync, mkdtempSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QN, QX } from '../util.js'

const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), 'relative-from-bootstrap-')))

const exec = (cmd, opts = {}) => {
	try {
		return { stdout: execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }), stderr: '', code: 0 }
	} catch (e) {
		return { stdout: e.stdout || '', stderr: e.stderr || e.message, code: e.status || 1 }
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

describe('Relative path resolution from qn bootstrap', () => {
	test('qn ./script.js resolves relative to cwd, not bootstrap', ({ dir }) => {
		writeFileSync(`${dir}/script.js`, `console.log('success');`)
		const result = exec(`${QN()} ./script.js`, { cwd: dir })
		assert.strictEqual(result.code, 0, `Expected success, got: ${result.stderr}`)
		assert.ok(result.stdout.includes('success'), `Expected 'success' output, got: ${result.stdout}`)
	})

	test('qn ./subdir/script.js resolves relative to cwd', ({ dir }) => {
		const subdir = join(dir, 'subdir')
		execSync(`mkdir -p "${subdir}"`)
		writeFileSync(`${subdir}/script.js`, `console.log('subdir success');`)
		const result = exec(`${QN()} ./subdir/script.js`, { cwd: dir })
		assert.strictEqual(result.code, 0, `Expected success, got: ${result.stderr}`)
		assert.ok(result.stdout.includes('subdir success'), `Expected 'subdir success' output, got: ${result.stdout}`)
	})

	test('qn ./non-existing.js error message shows correct path', ({ dir }) => {
		const result = exec(`${QN()} ./non-existing.js`, { cwd: dir })
		assert.strictEqual(result.code, 1, 'Expected failure')
		// The error should mention the path relative to cwd or absolute path,
		// NOT 'node/non-existing.js'
		assert.ok(!result.stderr.includes('node/non-existing.js'),
			`Error should not reference 'node/non-existing.js': ${result.stderr}`)
		// Should reference the actual path the user asked for
		assert.ok(
			result.stderr.includes('non-existing.js') || result.stderr.includes(dir),
			`Error should reference 'non-existing.js' or the temp dir: ${result.stderr}`)
	})

	test('qn ../script.js resolves relative to cwd', ({ dir }) => {
		const subdir = join(dir, 'subdir')
		execSync(`mkdir -p ${subdir}`)
		writeFileSync(`${dir}/script.js`, `console.log('parent success');`)
		const result = exec(`${QN()} ../script.js`, { cwd: subdir })
		assert.strictEqual(result.code, 0, `Expected success, got: ${result.stderr}`)
		assert.ok(result.stdout.includes('parent success'), `Expected 'parent success' output, got: ${result.stdout}`)
	})

	test('absolute path works correctly', ({ dir }) => {
		writeFileSync(`${dir}/script.js`, `console.log('absolute success');`)
		const result = exec(`${QN()} ${dir}/script.js`)
		assert.strictEqual(result.code, 0, `Expected success, got: ${result.stderr}`)
		assert.ok(result.stdout.includes('absolute success'), `Expected 'absolute success' output, got: ${result.stdout}`)
	})

	test('bare path (no ./) falls back to filesystem', ({ dir }) => {
		writeFileSync(`${dir}/script.js`, `console.log('bare success');`)
		// Bare imports first try NODE_PATH, then fall back to filesystem
		// This is qn-specific behavior (different from Node.js ESM which requires ./)
		const result = exec(`${QN()} script.js`, { cwd: dir })
		// Should succeed because loader falls back to trying the path in cwd
		assert.strictEqual(result.code, 0, `Expected success, got: ${result.stderr}`)
		assert.ok(result.stdout.includes('bare success'), `Expected 'bare success' output, got: ${result.stdout}`)
	})

	test('nested relative imports from user script work correctly', ({ dir }) => {
		writeFileSync(`${dir}/main.js`, `
console.log('main loaded');
await import('./helper.js');
`)
		writeFileSync(`${dir}/helper.js`, `console.log('helper loaded');`)
		const result = exec(`${QN()} ./main.js`, { cwd: dir })
		assert.strictEqual(result.code, 0, `Expected success, got: ${result.stderr}`)
		assert.ok(result.stdout.includes('main loaded'), `Expected 'main loaded': ${result.stdout}`)
		assert.ok(result.stdout.includes('helper loaded'), `Expected 'helper loaded': ${result.stdout}`)
	})

	test('nested relative import error shows correct path', ({ dir }) => {
		writeFileSync(`${dir}/main.js`, `await import('./non-existing.js');`)
		const result = exec(`${QN()} ./main.js`, { cwd: dir })
		assert.strictEqual(result.code, 1, 'Expected failure')
		// Error should show the correct resolved path, not 'node/non-existing.js'
		assert.ok(!result.stderr.includes('node/non-existing.js'),
			`Error should not reference 'node/...': ${result.stderr}`)
		// Should include the temp dir path or 'non-existing.js'
		assert.ok(result.stderr.includes('non-existing.js'),
			`Error should reference 'non-existing.js': ${result.stderr}`)
	})
})

describe('Relative path resolution from qx bootstrap', () => {
	test('qx ./script.js resolves relative to cwd, not bootstrap', ({ dir }) => {
		writeFileSync(`${dir}/script.js`, `console.log('qx success');`)
		const result = exec(`${QX()} ./script.js`, { cwd: dir })
		assert.strictEqual(result.code, 0, `Expected success, got: ${result.stderr}`)
		assert.ok(result.stdout.includes('qx success'), `Expected 'qx success' output, got: ${result.stdout}`)
	})

	test('qx ./non-existing.js error message shows correct path', ({ dir }) => {
		const result = exec(`${QX()} ./non-existing.js`, { cwd: dir })
		assert.strictEqual(result.code, 1, 'Expected failure')
		// The error should not reference 'qx/non-existing.js' or any embedded path
		assert.ok(!result.stderr.includes('qx/non-existing.js') && !result.stderr.includes('node/non-existing.js'),
			`Error should not reference embedded paths: ${result.stderr}`)
	})
})


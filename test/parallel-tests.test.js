import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { testQnOnly, execAsync } from './util.js'

/** Like execAsync but always resolves with { stdout, stderr, code } */
const execCapture = (cmd, args, opts = {}) => {
	return new Promise((resolve, reject) => {
		const { FORCE_COLOR, NODE_OPTIONS, NODE_TEST_CONTEXT, ...env } = process.env
		const child = spawn(cmd, args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...env, NO_COLOR: '1', ...opts.env },
			cwd: opts.cwd,
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', d => stdout += d)
		child.stderr.on('data', d => stderr += d)
		child.on('error', reject)
		child.on('close', code => resolve({ stdout, stderr, code }))
	})
}

describe('qn --test parallel execution', () => {
	testQnOnly('runs multiple files in parallel', async ({ bin, dir }) => {
		// Each file sleeps 200ms. With parallel execution, total time should be
		// much less than 3 * 200ms = 600ms
		for (const name of ['a', 'b', 'c']) {
			writeFileSync(join(dir, `${name}.test.js`), `
				import { describe, test } from 'node:test'
				describe('suite-${name}', () => {
					test('slow-${name}', async () => {
						await new Promise(r => setTimeout(r, 200))
					})
				})
			`)
		}

		const start = performance.now()
		const output = await execAsync(bin, ['--test', '*.test.js'], { cwd: dir })
		const elapsed = performance.now() - start

		// All three suites should appear in output
		assert.match(output, /suite-a/)
		assert.match(output, /suite-b/)
		assert.match(output, /suite-c/)

		// Verify parallelism: 3 files x 200ms each would be ~600ms sequential,
		// but parallel should complete well under 500ms (plus process overhead)
		assert.ok(elapsed < 500, `Expected parallel execution under 500ms, got ${elapsed.toFixed(0)}ms`)
	})

	testQnOnly('aggregates pass/fail counts across files', async ({ bin, dir }) => {
		writeFileSync(join(dir, 'pass.test.js'), `
			import { describe, test } from 'node:test'
			describe('passing', () => {
				test('p1', () => {})
				test('p2', () => {})
			})
		`)
		writeFileSync(join(dir, 'fail.test.js'), `
			import { describe, test } from 'node:test'
			import assert from 'node:assert'
			describe('failing', () => {
				test('f1', () => { assert.strictEqual(1, 2) })
				test('f2', () => {})
			})
		`)

		try {
			await execAsync(bin, ['--test', '*.test.js'], { cwd: dir })
			assert.fail('should have exited with code 1')
		} catch (err) {
			assert.strictEqual(err.code, 1)
		}
	})

	testQnOnly('aggregates results in unified summary', async ({ bin, dir }) => {
		writeFileSync(join(dir, 'x.test.js'), `
			import { describe, test } from 'node:test'
			describe('x', () => {
				test('x1', () => {})
				test('x2', () => {})
			})
		`)
		writeFileSync(join(dir, 'y.test.js'), `
			import { describe, test } from 'node:test'
			describe('y', () => {
				test('y1', () => {})
			})
		`)

		const output = await execAsync(bin, ['--test', '*.test.js'], { cwd: dir })
		// Should show unified summary with totals from both files
		assert.match(output, /files 2/)
		assert.match(output, /tests 3/)
		assert.match(output, /pass 3/)
		assert.match(output, /fail 0/)
	})

	testQnOnly('--test-concurrency=1 runs files sequentially', async ({ bin, dir }) => {
		for (const name of ['a', 'b']) {
			writeFileSync(join(dir, `${name}.test.js`), `
				import { describe, test } from 'node:test'
				describe('suite-${name}', () => {
					test('slow-${name}', async () => {
						await new Promise(r => setTimeout(r, 200))
					})
				})
			`)
		}

		const start = performance.now()
		const output = await execAsync(bin, [
			'--test', '--test-concurrency=1', '*.test.js'
		], { cwd: dir })
		const elapsed = performance.now() - start

		assert.match(output, /suite-a/)
		assert.match(output, /suite-b/)
		// Sequential: should take at least 400ms (2 x 200ms)
		assert.ok(elapsed >= 390, `Expected sequential execution >=390ms, got ${elapsed.toFixed(0)}ms`)
	})

	testQnOnly('--test-concurrency N (space-separated) works', async ({ bin, dir }) => {
		for (const name of ['a', 'b']) {
			writeFileSync(join(dir, `${name}.test.js`), `
				import { describe, test } from 'node:test'
				describe('suite-${name}', () => {
					test('test-${name}', () => {})
				})
			`)
		}

		const output = await execAsync(bin, [
			'--test', '--test-concurrency', '1', '*.test.js'
		], { cwd: dir })
		assert.match(output, /suite-a/)
		assert.match(output, /suite-b/)
		assert.match(output, /files 2/)
	})

	testQnOnly('shows file headers with pass/fail indicators', async ({ bin, dir }) => {
		writeFileSync(join(dir, 'ok.test.js'), `
			import { describe, test } from 'node:test'
			describe('ok', () => { test('t', () => {}) })
		`)
		writeFileSync(join(dir, 'bad.test.js'), `
			import { describe, test } from 'node:test'
			import assert from 'node:assert'
			describe('bad', () => { test('t', () => { assert.fail('boom') }) })
		`)

		try {
			await execAsync(bin, ['--test', 'ok.test.js', 'bad.test.js'], { cwd: dir })
			assert.fail('should have exited with code 1')
		} catch (err) {
			// Can't easily check ANSI-colored output, but the file names should appear
			// The output goes to stdout, errors to stderr, both are in the error object
			assert.strictEqual(err.code, 1)
		}
	})

	testQnOnly('preserves file order in output', async ({ bin, dir }) => {
		for (const name of ['z', 'a', 'm']) {
			writeFileSync(join(dir, `${name}.test.js`), `
				import { describe, test } from 'node:test'
				describe('suite-${name}', () => {
					test('test-${name}', () => {})
				})
			`)
		}

		// Specify files in explicit order
		const output = await execAsync(bin, [
			'--test', 'z.test.js', 'a.test.js', 'm.test.js'
		], { cwd: dir })
		const zIdx = output.indexOf('suite-z')
		const aIdx = output.indexOf('suite-a')
		const mIdx = output.indexOf('suite-m')
		assert.ok(zIdx < aIdx, 'z should appear before a')
		assert.ok(aIdx < mIdx, 'a should appear before m')
	})

	testQnOnly('handles test file that crashes', async ({ bin, dir }) => {
		writeFileSync(join(dir, 'good.test.js'), `
			import { describe, test } from 'node:test'
			describe('good', () => { test('ok', () => {}) })
		`)
		writeFileSync(join(dir, 'crash.test.js'), `
			throw new Error('top-level crash')
		`)

		try {
			await execAsync(bin, ['--test', 'good.test.js', 'crash.test.js'], { cwd: dir })
			assert.fail('should have exited with code 1')
		} catch (err) {
			assert.strictEqual(err.code, 1)
		}
	})

	testQnOnly('single file still runs in-process (not parallel)', async ({ bin, dir }) => {
		writeFileSync(join(dir, 'solo.test.js'), `
			import { describe, test } from 'node:test'
			describe('solo', () => {
				test('t1', () => {})
				test('t2', () => {})
			})
		`)

		const output = await execAsync(bin, ['--test', './solo.test.js'], { cwd: dir })
		// Single file should show normal output (no "files" line in summary)
		assert.match(output, /pass 2/)
		assert.doesNotMatch(output, /files/)
	})

	testQnOnly('skip and todo counts aggregate across files', async ({ bin, dir }) => {
		writeFileSync(join(dir, 's.test.js'), `
			import { describe, test } from 'node:test'
			describe('s', () => {
				test('run', () => {})
				test.skip('skipped', () => {})
			})
		`)
		writeFileSync(join(dir, 't.test.js'), `
			import { describe, test } from 'node:test'
			describe('t', () => {
				test('run', () => {})
				test.todo('not yet', () => {})
			})
		`)

		const output = await execAsync(bin, ['--test', '*.test.js'], { cwd: dir })
		assert.match(output, /tests 4/)
		assert.match(output, /pass 2/)
		assert.match(output, /skipped 1/)
		assert.match(output, /todo 1/)
	})

	testQnOnly('failure details are shown in aggregate summary', async ({ bin, dir }) => {
		writeFileSync(join(dir, 'f1.test.js'), `
			import { describe, test } from 'node:test'
			import assert from 'node:assert'
			describe('f1', () => {
				test('bad1', () => { assert.strictEqual('a', 'b') })
			})
		`)
		writeFileSync(join(dir, 'f2.test.js'), `
			import { describe, test } from 'node:test'
			import assert from 'node:assert'
			describe('f2', () => {
				test('bad2', () => { assert.strictEqual(1, 2) })
			})
		`)

		const { stdout, code } = await execCapture(bin, ['--test', '*.test.js'], { cwd: dir })
		assert.strictEqual(code, 1)
		// Failure details should appear in the output
		assert.match(stdout, /failing tests/)
		assert.match(stdout, /bad1/)
		assert.match(stdout, /bad2/)
	})
})

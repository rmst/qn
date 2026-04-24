import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, testQnOnly, execAsync, $ } from './util.js'

describe('qn --test runner', () => {
	test('runs test file with explicit ./path', async ({ bin, dir }) => {
		writeFileSync(join(dir, 'my.test.js'), `
			import { describe, test } from 'node:test'
			describe('suite', () => {
				test('passes', () => {})
			})
		`)

		const output = await execAsync(bin, ['--test', './my.test.js'], { cwd: dir })
		assert.match(output, /pass 1/)
		assert.match(output, /fail 0/)
	})

	test('runs test file with glob pattern', async ({ bin, dir }) => {
		writeFileSync(join(dir, 'a.test.js'), `
			import { describe, test } from 'node:test'
			describe('suite-a', () => {
				test('test-a', () => {})
			})
		`)
		writeFileSync(join(dir, 'b.test.js'), `
			import { describe, test } from 'node:test'
			describe('suite-b', () => {
				test('test-b', () => {})
			})
		`)

		const output = await execAsync(bin, ['--test', '*.test.js'], { cwd: dir })
		assert.match(output, /suite-a/)
		assert.match(output, /suite-b/)
	})

	test('runs test file without ./ prefix (relative path)', async ({ bin, dir }) => {
		writeFileSync(join(dir, 'simple.test.js'), `
			import { describe, test } from 'node:test'
			describe('simple', () => {
				test('works', () => {})
			})
		`)

		// This should work: qn --test simple.test.js (without ./)
		const output = await execAsync(bin, ['--test', 'simple.test.js'], { cwd: dir })
		assert.match(output, /pass 1/)
		assert.match(output, /fail 0/)
	})

	test('runs test file in subdirectory without ./ prefix', async ({ bin, dir }) => {
		mkdirSync(join(dir, 'tests'))
		writeFileSync(join(dir, 'tests/sub.test.js'), `
			import { describe, test } from 'node:test'
			describe('sub', () => {
				test('subtest', () => {})
			})
		`)

		// This should work: qn --test tests/sub.test.js (without ./)
		const output = await execAsync(bin, ['--test', 'tests/sub.test.js'], { cwd: dir })
		assert.match(output, /pass 1/)
		assert.match(output, /fail 0/)
	})

	test('glob pattern in subdirectory', async ({ bin, dir }) => {
		mkdirSync(join(dir, 'tests'))
		writeFileSync(join(dir, 'tests/x.test.js'), `
			import { describe, test } from 'node:test'
			describe('suite-x', () => { test('test-x', () => {}) })
		`)
		writeFileSync(join(dir, 'tests/y.test.js'), `
			import { describe, test } from 'node:test'
			describe('suite-y', () => { test('test-y', () => {}) })
		`)

		const output = await execAsync(bin, ['--test', 'tests/*.test.js'], { cwd: dir })
		assert.match(output, /suite-x/)
		assert.match(output, /suite-y/)
	})

	test('reports failing test correctly', async ({ bin, dir }) => {
		writeFileSync(join(dir, 'fail.test.js'), `
			import { describe, test } from 'node:test'
			import assert from 'node:assert'
			describe('failing', () => {
				test('this fails', () => {
					assert.strictEqual(1, 2)
				})
			})
		`)

		try {
			await execAsync(bin, ['--test', './fail.test.js'], { cwd: dir })
			assert.fail('should have thrown')
		} catch (err) {
			// Test runner exits with code 1 on failure
			assert.strictEqual(err.code, 1)
		}
	})

	test('test.skip skips tests', async ({ bin, dir }) => {
		writeFileSync(join(dir, 'skip.test.js'), `
			import { describe, test } from 'node:test'
			describe('skipping', () => {
				test('runs', () => {})
				test.skip('skipped', () => { throw new Error('should not run') })
			})
		`)

		const output = await execAsync(bin, ['--test', './skip.test.js'], { cwd: dir })
		assert.match(output, /pass 1/)
		assert.match(output, /skipped 1/)
	})

	test('test.todo marks tests as todo', async ({ bin, dir }) => {
		writeFileSync(join(dir, 'todo.test.js'), `
			import { describe, test } from 'node:test'
			describe('todos', () => {
				test('runs', () => {})
				test.todo('not implemented yet', () => {})
			})
		`)

		const output = await execAsync(bin, ['--test', './todo.test.js'], { cwd: dir })
		assert.match(output, /pass 1/)
		assert.match(output, /todo 1/)
	})

	// qn-only: Node.js silently succeeds with 0 tests when no files found
	testQnOnly('warns when no test files found', async ({ bin, dir }) => {
		try {
			await execAsync(bin, ['--test', 'nonexistent/*.test.js'], { cwd: dir })
			assert.fail('should have thrown')
		} catch (err) {
			assert.match(err.stderr, /no test files found/)
		}
	})

	// qn-only: Node.js silently succeeds with 0 tests when no patterns provided
	testQnOnly('warns when no patterns provided', async ({ bin, dir }) => {
		try {
			await execAsync(bin, ['--test'], { cwd: dir })
			assert.fail('should have thrown')
		} catch (err) {
			assert.match(err.stderr, /no test files found/)
		}
	})

	test('deduplicates files matched by multiple patterns', async ({ bin, dir }) => {
		writeFileSync(join(dir, 'dup.test.js'), `
			import { describe, test } from 'node:test'
			describe('unique-suite', () => {
				test('only runs once', () => {})
			})
		`)

		// Same file specified multiple ways - should only run once
		const output = await execAsync(bin, ['--test', 'dup.test.js', './dup.test.js', '*.test.js'], { cwd: dir })
		// Verify suite appears exactly once (would appear 3x without dedup)
		const matches = output.match(/unique-suite/g)
		assert.strictEqual(matches?.length, 2) // suite header + summary
	})

	// qn-only: Node.js doesn't support negative glob patterns for --test
	testQnOnly('negative glob pattern excludes files', async ({ bin, dir }) => {
		writeFileSync(join(dir, 'a.test.js'), `
			import { describe, test } from 'node:test'
			describe('suite-a', () => { test('test-a', () => {}) })
		`)
		writeFileSync(join(dir, 'b.test.js'), `
			import { describe, test } from 'node:test'
			describe('suite-b', () => { test('test-b', () => {}) })
		`)
		writeFileSync(join(dir, 'c.test.js'), `
			import { describe, test } from 'node:test'
			describe('suite-c', () => { test('test-c', () => {}) })
		`)

		// Run all except b.test.js
		const output = await execAsync(bin, ['--test', '*.test.js', '!b.test.js'], { cwd: dir })
		assert.match(output, /suite-a/)
		assert.match(output, /suite-c/)
		assert.doesNotMatch(output, /suite-b/)
	})
})

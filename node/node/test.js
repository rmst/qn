/**
 * Node.js test runner module compatibility for Qn.
 * Implements the subset used by qn and jix tests.
 * @see https://nodejs.org/api/test.html
 */

import process from 'node:process'

// ANSI color codes
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BLUE = '\x1b[34m'
const CYAN = '\x1b[36m'

// Consume and clear QN_TEST_CHILD so it doesn't propagate to nested child processes
const isChildProcess = !!process.env.QN_TEST_CHILD
delete process.env.QN_TEST_CHILD

// Test state
const rootSuite = { name: null, tests: [], suites: [], parent: null }
let currentSuite = rootSuite
let isRunning = false
let hasScheduledRun = false

// Results tracking
const results = {
	tests: 0,
	suites: 0,
	pass: 0,
	fail: 0,
	skip: 0,
	todo: 0,
	failures: []
}

/**
 * Test context passed to test functions.
 * Supports subtests via t.test()
 */
class TestContext {
	constructor(name, parent = null) {
		this.name = name
		this.parent = parent
		this.subtests = []
	}

	/**
	 * Create a subtest
	 */
	async test(name, optionsOrFn, maybeFn) {
		const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn
		const options = typeof optionsOrFn === 'object' ? optionsOrFn : {}

		const subtest = { name, fn, options, parent: this }
		this.subtests.push(subtest)

		// Run the subtest immediately
		return runTest(subtest, getIndent(this) + 1)
	}
}

/**
 * Get nesting level for indentation
 */
function getIndent(context) {
	let indent = 0
	let current = context
	while (current && current.parent) {
		indent++
		current = current.parent
	}
	return indent
}

/**
 * Create indentation string
 */
function indent(level) {
	return '  '.repeat(level)
}

/**
 * Format duration
 */
function formatDuration(ms) {
	return `(${ms.toFixed(3)}ms)`
}

/**
 * Run a single test
 */
async function runTest(test, indentLevel = 0) {
	const { name, fn, options = {} } = test
	const pad = indent(indentLevel)

	if (options.skip) {
		console.log(`${pad}${YELLOW}⊘ ${name} ${DIM}[skipped]${RESET}`)
		results.skip++
		results.tests++
		return { passed: true, skipped: true }
	}

	if (options.todo) {
		console.log(`${pad}${BLUE}⊘ ${name} ${DIM}[todo]${RESET}`)
		results.todo++
		results.tests++
		return { passed: true, todo: true }
	}

	const context = new TestContext(name, test.parent)
	const startTime = performance.now()

	try {
		await fn(context)
		const duration = performance.now() - startTime
		console.log(`${pad}${GREEN}✔${RESET} ${name} ${DIM}${formatDuration(duration)}${RESET}`)
		results.pass++
		results.tests++
		return { passed: true, duration }
	} catch (error) {
		const duration = performance.now() - startTime
		console.log(`${pad}${RED}✖${RESET} ${name} ${DIM}${formatDuration(duration)}${RESET}`)
		results.fail++
		results.tests++
		results.failures.push({ name, error, indentLevel })
		return { passed: false, duration, error }
	}
}

/**
 * Run a suite (describe block)
 */
async function runSuite(suite, indentLevel = 0) {
	const pad = indent(indentLevel)
	const startTime = performance.now()
	const failsBefore = results.fail

	if (suite.name) {
		console.log(`${pad}${BOLD}▶${RESET} ${suite.name}`)
		results.suites++
	}

	// Run all tests in the suite
	for (const test of suite.tests) {
		await runTest(test, suite.name ? indentLevel + 1 : indentLevel)
	}

	// Run nested suites
	for (const nested of suite.suites) {
		await runSuite(nested, suite.name ? indentLevel + 1 : indentLevel)
	}

	if (suite.name) {
		const duration = performance.now() - startTime
		const suiteFailed = results.fail > failsBefore
		const status = suiteFailed ? `${RED}✖${RESET}` : `${GREEN}✔${RESET}`
		console.log(`${pad}${status} ${suite.name} ${DIM}${formatDuration(duration)}${RESET}`)
	}
}

/**
 * Print final summary
 */
function printSummary(totalDuration) {
	console.log(`${DIM}ℹ${RESET} tests ${results.tests}`)
	console.log(`${DIM}ℹ${RESET} suites ${results.suites}`)
	console.log(`${DIM}ℹ${RESET} pass ${results.pass}`)
	console.log(`${DIM}ℹ${RESET} fail ${results.fail}`)
	if (results.skip > 0) console.log(`${DIM}ℹ${RESET} skipped ${results.skip}`)
	if (results.todo > 0) console.log(`${DIM}ℹ${RESET} todo ${results.todo}`)
	console.log(`${DIM}ℹ${RESET} duration_ms ${totalDuration.toFixed(3)}`)

	// Print failure details
	if (results.failures.length > 0) {
		console.log(`\n${RED}✖ failing tests:${RESET}\n`)
		for (const { name, error, indentLevel } of results.failures) {
			console.log(`${RED}✖${RESET} ${name}`)
			console.log(`  ${error.name || 'Error'}: ${error.message}`)
			if (error.stack) {
				const stackLines = error.stack.split('\n').slice(1, 5)
				for (const line of stackLines) {
					console.log(`  ${DIM}${line.trim()}${RESET}`)
				}
			}
			console.log()
		}
	}
}

/**
 * Run all registered tests
 */
async function runAllTests() {
	if (isRunning) return
	isRunning = true

	const startTime = performance.now()

	await runSuite(rootSuite)

	const totalDuration = performance.now() - startTime

	if (isChildProcess) {
		// Child process mode: emit machine-readable results for the parent
		const json = JSON.stringify({
			tests: results.tests,
			suites: results.suites,
			pass: results.pass,
			fail: results.fail,
			skip: results.skip,
			todo: results.todo,
			duration_ms: totalDuration,
			failures: results.failures.map(f => ({
				name: f.name,
				message: f.error?.message,
				stack: f.error?.stack,
			})),
		})
		process.stderr.write(`QN_TEST_RESULT:${json}\n`)
	} else {
		printSummary(totalDuration)
	}

	process.exitCode = results.fail > 0 ? 1 : 0
}

/**
 * Schedule test run after current module evaluation
 */
function scheduleRun() {
	if (hasScheduledRun) return
	hasScheduledRun = true

	// Use setTimeout to run after all describe/test calls are registered
	setTimeout(runAllTests, 0)
}

/**
 * Create a test suite (describe block)
 */
export function describe(name, fn) {
	const suite = { name, tests: [], suites: [], parent: currentSuite }
	currentSuite.suites.push(suite)

	const previousSuite = currentSuite
	currentSuite = suite
	fn()
	currentSuite = previousSuite

	scheduleRun()
}

/**
 * Create a test case
 */
export function test(name, optionsOrFn, maybeFn) {
	const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn
	const options = typeof optionsOrFn === 'object' ? optionsOrFn : {}

	currentSuite.tests.push({ name, fn, options })
	scheduleRun()
}

/**
 * Create a skipped test
 */
test.skip = function skip(name, optionsOrFn, maybeFn) {
	const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn
	const options = typeof optionsOrFn === 'object' ? optionsOrFn : {}
	options.skip = true
	currentSuite.tests.push({ name, fn, options })
	scheduleRun()
}

/**
 * Create a todo test
 */
test.todo = function todo(name, optionsOrFn, maybeFn) {
	const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn
	const options = typeof optionsOrFn === 'object' ? optionsOrFn : {}
	options.todo = true
	currentSuite.tests.push({ name, fn, options })
	scheduleRun()
}

/**
 * Run only this test (marks others as skipped)
 * Note: This is a simplified implementation
 */
test.only = function only(name, optionsOrFn, maybeFn) {
	const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn
	const options = typeof optionsOrFn === 'object' ? optionsOrFn : {}
	options.only = true
	currentSuite.tests.push({ name, fn, options })
	scheduleRun()
}

// Alias
export const it = test

// Default export includes all functions
export default { describe, test, it }

import { describe, test as nodetest } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, realpathSync } from 'node:fs'
import { QN } from './util.js'

const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-test-')))

const $ = (strings, ...values) => {
	const cmd = String.raw({ raw: strings }, ...values)
	return execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim()
}

// Helper to generate event loop code for waiting on worker responses
const eventLoopCode = `
let __done = false
function __checkDone() {
	if (__done) std.exit(0)
	if (++__checkDone.count > 100) { console.log('timeout'); std.exit(1) }
	os.setTimeout(__checkDone, 10)
}
__checkDone.count = 0
os.setTimeout(__checkDone, 10)
`

describe('SandboxedWorker', () => {
	// TODO: SandboxedWorker uses QuickJS os.setTimeout which conflicts with qn's libuv event loop.
	// Sandbox tests are deactivated until the sandbox is migrated to libuv (see dev-roadmap.md).
	nodetest('basic message passing with code string', { skip: 'sandbox not yet migrated to libuv' }, () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/test.js`, `
				import * as os from 'os'
				import * as std from 'std'

				const worker = new os.SandboxedWorker({
					code: \`
						Worker.parent.onmessage = (e) => {
							Worker.parent.postMessage({ received: e.data, doubled: e.data.value * 2 })
						}
					\`
				})

				worker.onmessage = (e) => {
					console.log(JSON.stringify(e.data))
					__done = true
				}

				worker.postMessage({ value: 21 })
				${eventLoopCode}
			`)

			const output = $`${QN()} ${dir}/test.js`
			const result = JSON.parse(output)
			assert.deepStrictEqual(result, { received: { value: 21 }, doubled: 42 })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	nodetest('sandbox cannot access std module', { skip: 'sandbox not yet migrated to libuv' }, () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/test.js`, `
				import * as os from 'os'
				import * as std from 'std'

				const worker = new os.SandboxedWorker({
					code: \`
						Worker.parent.onmessage = (e) => {
							let hasStd = false
							try {
								// std should not be defined in sandbox
								hasStd = typeof std !== 'undefined'
							} catch (err) {
								hasStd = false
							}
							Worker.parent.postMessage({ hasStd })
						}
					\`
				})

				worker.onmessage = (e) => {
					console.log(JSON.stringify(e.data))
					__done = true
				}

				worker.postMessage('check')
				${eventLoopCode}
			`)

			const output = $`${QN()} ${dir}/test.js`
			const result = JSON.parse(output)
			assert.strictEqual(result.hasStd, false)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	nodetest('sandbox cannot access os module', { skip: 'sandbox not yet migrated to libuv' }, () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/test.js`, `
				import * as os from 'os'
				import * as std from 'std'

				const worker = new os.SandboxedWorker({
					code: \`
						Worker.parent.onmessage = (e) => {
							let hasOs = false
							try {
								// os should not be defined in sandbox
								hasOs = typeof os !== 'undefined'
							} catch (err) {
								hasOs = false
							}
							Worker.parent.postMessage({ hasOs })
						}
					\`
				})

				worker.onmessage = (e) => {
					console.log(JSON.stringify(e.data))
					__done = true
				}

				worker.postMessage('check')
				${eventLoopCode}
			`)

			const output = $`${QN()} ${dir}/test.js`
			const result = JSON.parse(output)
			assert.strictEqual(result.hasOs, false)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	nodetest('sandbox has console.log', { skip: 'sandbox not yet migrated to libuv' }, () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/test.js`, `
				import * as os from 'os'
				import * as std from 'std'

				const worker = new os.SandboxedWorker({
					code: \`
						Worker.parent.onmessage = (e) => {
							const hasConsole = typeof console !== 'undefined'
							const hasLog = hasConsole && typeof console.log === 'function'
							Worker.parent.postMessage({ hasConsole, hasLog })
						}
					\`
				})

				worker.onmessage = (e) => {
					console.log(JSON.stringify(e.data))
					__done = true
				}

				worker.postMessage('check')
				${eventLoopCode}
			`)

			const output = $`${QN()} ${dir}/test.js`
			const result = JSON.parse(output)
			assert.strictEqual(result.hasConsole, true)
			assert.strictEqual(result.hasLog, true)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	nodetest('sandbox can do pure JavaScript computation', { skip: 'sandbox not yet migrated to libuv' }, () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/test.js`, `
				import * as os from 'os'
				import * as std from 'std'

				const worker = new os.SandboxedWorker({
					code: \`
						Worker.parent.onmessage = (e) => {
							const arr = e.data.numbers
							const sum = arr.reduce((a, b) => a + b, 0)
							const sorted = [...arr].sort((a, b) => a - b)
							const reversed = arr.slice().reverse()
							Worker.parent.postMessage({ sum, sorted, reversed })
						}
					\`
				})

				worker.onmessage = (e) => {
					console.log(JSON.stringify(e.data))
					__done = true
				}

				worker.postMessage({ numbers: [3, 1, 4, 1, 5, 9, 2, 6] })
				${eventLoopCode}
			`)

			const output = $`${QN()} ${dir}/test.js`
			const result = JSON.parse(output)
			assert.strictEqual(result.sum, 31)
			assert.deepStrictEqual(result.sorted, [1, 1, 2, 3, 4, 5, 6, 9])
			assert.deepStrictEqual(result.reversed, [6, 2, 9, 5, 1, 4, 1, 3])
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	nodetest('file-based sandbox worker', { skip: 'sandbox not yet migrated to libuv' }, () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/sandbox-worker.js`, `
				Worker.parent.onmessage = (e) => {
					Worker.parent.postMessage({ msg: 'hello from file', input: e.data })
				}
			`)

			writeFileSync(`${dir}/test.js`, `
				import * as os from 'os'
				import * as std from 'std'

				const worker = new os.SandboxedWorker('${dir}/sandbox-worker.js')

				worker.onmessage = (e) => {
					console.log(JSON.stringify(e.data))
					__done = true
				}

				worker.postMessage('test input')
				${eventLoopCode}
			`)

			const output = $`${QN()} ${dir}/test.js`
			const result = JSON.parse(output)
			assert.strictEqual(result.msg, 'hello from file')
			assert.strictEqual(result.input, 'test input')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	nodetest('sandbox with allowImports can import modules', { skip: 'sandbox not yet migrated to libuv' }, () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/utils.js`, `
				export function double(x) { return x * 2 }
				export function square(x) { return x * x }
			`)

			writeFileSync(`${dir}/sandbox-worker.js`, `
				import { double, square } from './utils.js'

				Worker.parent.onmessage = (e) => {
					const val = e.data.value
					Worker.parent.postMessage({
						doubled: double(val),
						squared: square(val)
					})
				}
			`)

			writeFileSync(`${dir}/test.js`, `
				import * as os from 'os'
				import * as std from 'std'

				const worker = new os.SandboxedWorker('${dir}/sandbox-worker.js', {
					allowImports: true
				})

				worker.onmessage = (e) => {
					console.log(JSON.stringify(e.data))
					__done = true
				}

				worker.postMessage({ value: 5 })
				${eventLoopCode}
			`)

			const output = $`${QN()} ${dir}/test.js`
			const result = JSON.parse(output)
			assert.strictEqual(result.doubled, 10)
			assert.strictEqual(result.squared, 25)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

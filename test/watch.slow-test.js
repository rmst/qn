import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, utimesSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { testQnOnly } from './util.js'

/**
 * Bump a file's mtime to now+delta seconds. Using an explicit absolute time
 * (rather than `touch` relying on the wall clock) makes the change detectable
 * even on very fast filesystems where two successive writes can land in the
 * same nanosecond tick.
 */
function bumpMtime(path, deltaSec = 5) {
	const now = Date.now() / 1000 + deltaSec
	utimesSync(path, now, now)
}

/**
 * Spawn `qn --watch <entry>`, collect stdout/stderr, and let the caller trigger
 * changes via a callback. Resolves when the process is killed.
 */
function runWatch(bin, entryPath, { scenario, timeoutMs = 5000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, ['--watch', entryPath], { stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', d => stdout += d)
		child.stderr.on('data', d => stderr += d)
		const timer = setTimeout(() => {
			child.kill('SIGTERM')
			setTimeout(() => child.kill('SIGKILL'), 500)
		}, timeoutMs)
		child.on('error', reject)
		child.on('close', () => {
			clearTimeout(timer)
			resolve({ stdout, stderr })
		})
		scenario({ stdout: () => stdout, stderr: () => stderr, kill: () => child.kill('SIGTERM') })
			.catch(reject)
	})
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Wait for a substring to appear in the running stdout, polling every 50ms.
 * Throws if it doesn't appear before deadlineMs.
 */
async function waitFor(getText, substr, label, deadlineMs = 2500) {
	const start = Date.now()
	while (Date.now() - start < deadlineMs) {
		if (getText().includes(substr)) return
		await sleep(50)
	}
	throw new Error(`timeout waiting for ${label}; got: ${JSON.stringify(getText())}`)
}

describe('qn --watch', () => {
	testQnOnly('restarts on entry-file change', async ({ bin, dir }) => {
		writeFileSync(`${dir}/main.js`, `console.log('run:' + Date.now())\n`)

		const { stdout } = await runWatch(bin, `${dir}/main.js`, {
			scenario: async ({ stdout: getOut, kill }) => {
				await waitFor(getOut, 'run:', 'first run')
				const firstLineCount = getOut().split('run:').length
				bumpMtime(`${dir}/main.js`)
				await waitFor(
					() => {
						const n = getOut().split('run:').length
						return n > firstLineCount ? 'X' : ''
					},
					'X',
					'second run',
				)
				kill()
			},
		})

		const runs = stdout.split('run:').length - 1
		assert.ok(runs >= 2, `expected ≥2 runs, got ${runs}. stdout=${stdout}`)
	})

	testQnOnly('restarts on transitive import change', async ({ bin, dir }) => {
		writeFileSync(`${dir}/lib.js`, `export const v = 1\n`)
		writeFileSync(`${dir}/main.js`, `import { v } from './lib.js'\nconsole.log('run:' + v)\n`)

		const { stdout } = await runWatch(bin, `${dir}/main.js`, {
			scenario: async ({ stdout: getOut, kill }) => {
				await waitFor(getOut, 'run:1', 'first run')
				/* Rewrite lib.js and bump its mtime so the watcher notices */
				writeFileSync(`${dir}/lib.js`, `export const v = 2\n`)
				bumpMtime(`${dir}/lib.js`)
				await waitFor(getOut, 'run:2', 'second run with new value')
				kill()
			},
		})

		assert.ok(stdout.includes('run:1'), `missing first run: ${stdout}`)
		assert.ok(stdout.includes('run:2'), `missing second run: ${stdout}`)
	})

	testQnOnly('restarts on .json import change', async ({ bin, dir }) => {
		writeFileSync(`${dir}/config.json`, `{"value": 1}\n`)
		writeFileSync(`${dir}/main.js`, `import cfg from './config.json' with { type: 'json' }\nconsole.log('run:' + cfg.value)\n`)

		const { stdout } = await runWatch(bin, `${dir}/main.js`, {
			scenario: async ({ stdout: getOut, kill }) => {
				await waitFor(getOut, 'run:1', 'first run')
				writeFileSync(`${dir}/config.json`, `{"value": 42}\n`)
				bumpMtime(`${dir}/config.json`)
				await waitFor(getOut, 'run:42', 'second run with new json value')
				kill()
			},
		})

		assert.ok(stdout.includes('run:1'), `missing first run: ${stdout}`)
		assert.ok(stdout.includes('run:42'), `missing second run: ${stdout}`)
	})

	testQnOnly('restarts on .ts import change', async ({ bin, dir }) => {
		writeFileSync(`${dir}/data.ts`, `export const VALUE: number = 10\n`)
		writeFileSync(`${dir}/main.js`, `import { VALUE } from './data.ts'\nconsole.log('run:' + VALUE)\n`)

		const { stdout } = await runWatch(bin, `${dir}/main.js`, {
			scenario: async ({ stdout: getOut, kill }) => {
				await waitFor(getOut, 'run:10', 'first run')
				writeFileSync(`${dir}/data.ts`, `export const VALUE: number = 99\n`)
				bumpMtime(`${dir}/data.ts`)
				await waitFor(getOut, 'run:99', 'second run with new ts value')
				kill()
			},
		})

		assert.ok(stdout.includes('run:10'), `missing first run: ${stdout}`)
		assert.ok(stdout.includes('run:99'), `missing second run: ${stdout}`)
	})
})

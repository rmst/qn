import { describe, test } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, readFileSync, rmSync, mkdtempSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QX, QN } from '../util.js'

const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), '/')))

const runQx = (script, dir) => {
	writeFileSync(`${dir}/test.js`, script)
	return execSync(`${QX()} ${dir}/test.js`, { encoding: 'utf8', cwd: dir }).trim()
}

/** Check if a process is actually running (not a zombie). */
const isProcessRunning = (pid) => {
	try {
		const state = execSync(`ps -o state= -p ${pid}`, { encoding: 'utf8' }).trim()
		return state !== '' && !state.startsWith('Z')
	} catch {
		return false
	}
}

describe('qx config-first API', () => {
	test('$.quiet`cmd` suppresses output', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $.quiet\`echo "hello"\`
				console.log(JSON.stringify({ stdout: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { stdout: 'hello' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('$.nothrow`cmd` suppresses error on non-zero exit', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $.quiet.nothrow\`sh -c 'exit 1'\`
				console.log(JSON.stringify({ exitCode: result.exitCode }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { exitCode: 1 })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('$.quiet.nothrow`cmd` chains configurations', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $.quiet.nothrow\`sh -c 'echo out; exit 1'\`
				console.log(JSON.stringify({ stdout: result.stdout.trim(), exitCode: result.exitCode }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { stdout: 'out', exitCode: 1 })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('$.nothrow.quiet`cmd` order does not matter', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $.nothrow.quiet\`sh -c 'exit 1'\`
				console.log(JSON.stringify({ exitCode: result.exitCode }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { exitCode: 1 })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('configured $ can be stored and reused', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const $q = $.quiet
				const r1 = await $q\`echo "one"\`
				const r2 = await $q\`echo "two"\`
				console.log(JSON.stringify({ one: r1.stdout.trim(), two: r2.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { one: 'one', two: 'two' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

describe('qx assignment error', () => {
	test('$.quiet = true throws error', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				try {
					$.quiet = true
					console.log(JSON.stringify({ threw: false }))
				} catch (e) {
					console.log(JSON.stringify({ threw: true, message: e.message }))
				}
			`, dir)
			const result = JSON.parse(output)
			assert.strictEqual(result.threw, true)
			assert.ok(result.message.includes('$.quiet'))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('$.nothrow = true throws error', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				try {
					$.nothrow = true
					console.log(JSON.stringify({ threw: false }))
				} catch (e) {
					console.log(JSON.stringify({ threw: true }))
				}
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { threw: true })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('$.shell = throws error', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				try {
					$.shell = '/bin/bash'
					console.log(JSON.stringify({ threw: false }))
				} catch (e) {
					console.log(JSON.stringify({ threw: true, hasSuggestion: e.message.includes('$({') }))
				}
			`, dir)
			const result = JSON.parse(output)
			assert.strictEqual(result.threw, true)
			assert.strictEqual(result.hasSuggestion, true)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('$({ shell, prefix }) configures shell', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const $custom = $({ shell: '/bin/sh', prefix: '' })
				const result = await $custom.quiet\`echo hello\`
				console.log(JSON.stringify({ stdout: result.stdout.trim(), shell: $custom.shell }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { stdout: 'hello', shell: '/bin/sh' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

describe('qx eager execution', () => {
	test('output prints without await', () => {
		const dir = mktempdir()
		try {
			// Script with no await - should still print output
			writeFileSync(`${dir}/test.js`, `$\`echo hello\``)
			const result = execSync(`${QX()} ${dir}/test.js`, { encoding: 'utf8', cwd: dir }).trim()
			assert.strictEqual(result, 'hello')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('process starts immediately without await', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const startTime = Date.now()
				const p = $.quiet\`sh -c 'sleep 0.05; echo done'\`
				// Process should already be running
				const stage = p.stage
				await p
				const elapsed = Date.now() - startTime
				console.log(JSON.stringify({ stage, elapsed: elapsed >= 40 }))
			`, dir)
			const result = JSON.parse(output)
			assert.strictEqual(result.stage, 'running')
			assert.strictEqual(result.elapsed, true)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('multiple processes run in parallel', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const startTime = Date.now()
				const p1 = $.quiet\`sh -c 'sleep 0.05; echo one'\`
				const p2 = $.quiet\`sh -c 'sleep 0.05; echo two'\`
				const p3 = $.quiet\`sh -c 'sleep 0.05; echo three'\`
				const [r1, r2, r3] = await Promise.all([p1, p2, p3])
				const elapsed = Date.now() - startTime
				// Should take ~50ms not ~150ms since they run in parallel
				console.log(JSON.stringify({
					parallel: elapsed < 120,
					results: [r1.stdout.trim(), r2.stdout.trim(), r3.stdout.trim()]
				}))
			`, dir)
			const result = JSON.parse(output)
			assert.strictEqual(result.parallel, true)
			assert.deepStrictEqual(result.results, ['one', 'two', 'three'])
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

describe('qx streaming pipe', () => {
	test('pipe streams data immediately (not batch)', () => {
		const dir = mktempdir()
		try {
			// Source produces lines with delays, destination timestamps each line
			// If streaming works, timestamps will be spread out; if batch, they'd be the same
			// Uses perl -MTime::HiRes for portable millisecond timestamps (date +%3N is GNU-only)
			const output = runQx(`
				const result = await $.quiet\`sh -c 'echo A; sleep 0.1; echo B; sleep 0.1; echo C'\`
					.pipe($.quiet\`perl -MTime::HiRes=time -ne 'BEGIN{$$|=1} printf "%.0f\\n", time()*1000'\`)
				const times = result.stdout.trim().split('\\n').map(Number)
				// Check total spread (first to last): streaming ≈200ms, batching ≈0ms
				// Using total spread is more robust than checking individual gaps
				const totalSpread = times[2] - times[0]
				console.log(JSON.stringify({ streaming: totalSpread >= 100 }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { streaming: true })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('late pipe replays buffered output', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				// Start source, let it produce some output
				const source = $.quiet\`echo hello\`
				// Wait a bit for output to be produced
				await sleep(20)
				// Now pipe - should replay buffered output
				const result = await source.pipe($.quiet\`cat\`)
				console.log(JSON.stringify({ stdout: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { stdout: 'hello' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('pipe after source completes still works', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const source = $.quiet\`echo "completed"\`
				// Wait for source to fully complete
				await source
				// Pipe after completion - should replay entire buffer
				const result = await source.pipe($.quiet\`cat\`)
				console.log(JSON.stringify({ stdout: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { stdout: 'completed' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('chained pipes work', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $.quiet\`echo "hello world"\`
					.pipe($.quiet\`tr ' ' '_'\`)
					.pipe($.quiet\`tr 'a-z' 'A-Z'\`)
				console.log(JSON.stringify({ stdout: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { stdout: 'HELLO_WORLD' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

describe('qx backward compatibility', () => {
	test('.quiet() method still works (deprecated)', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $\`echo "test"\`.quiet()
				console.log(JSON.stringify({ stdout: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { stdout: 'test' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('.nothrow() method still works (deprecated)', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $\`sh -c 'exit 1'\`.quiet().nothrow()
				console.log(JSON.stringify({ exitCode: result.exitCode }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { exitCode: 1 })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

describe('qx binary data', () => {
	test('buffer() returns binary data', () => {
		const dir = mktempdir()
		try {
			// Use octal escapes (not \xNN) for portability — macOS printf doesn't support \x
			const output = runQx(`
				const buf = await $.quiet\`printf '\\\\000\\\\001\\\\002\\\\377'\`.buffer()
				console.log(JSON.stringify({
					isBuffer: buf instanceof Buffer,
					length: buf.length,
					bytes: [buf[0], buf[1], buf[2], buf[3]]
				}))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), {
				isBuffer: true,
				length: 4,
				bytes: [0, 1, 2, 255]
			})
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('binary data survives piping', () => {
		const dir = mktempdir()
		try {
			// Use octal escapes (not \xNN) for portability — macOS printf doesn't support \x
			const output = runQx(`
				const buf = await $.quiet\`printf '\\\\000\\\\001\\\\002\\\\377'\`
					.pipe($.quiet\`cat\`)
					.buffer()
				console.log(JSON.stringify({
					length: buf.length,
					bytes: [buf[0], buf[1], buf[2], buf[3]]
				}))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), {
				length: 4,
				bytes: [0, 1, 2, 255]
			})
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('ProcessOutput.buffer() and .stdout coexist', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $.quiet\`echo hello\`
				const buf = result.buffer()
				const str = result.stdout
				console.log(JSON.stringify({
					bufLen: buf.length,
					strLen: str.length,
					match: buf.toString() === str
				}))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), {
				bufLen: 6,  // "hello\n"
				strLen: 6,
				match: true
			})
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

describe('qx timeout', () => {
	test('$({ timeout }) kills long-running process', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const start = Date.now()
				try {
					await $({ timeout: 50 }).quiet.nothrow\`sleep 10\`
				} catch (e) {}
				const elapsed = Date.now() - start
				console.log(JSON.stringify({ killed: elapsed < 200 }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { killed: true })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('.timeout() kills long-running process', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const start = Date.now()
				try {
					await $.quiet\`sleep 10\`.timeout(50).nothrow()
				} catch (e) {}
				const elapsed = Date.now() - start
				console.log(JSON.stringify({ killed: elapsed < 200 }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { killed: true })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('.timeout() does not kill fast process', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $.quiet\`echo fast\`.timeout(1000)
				console.log(JSON.stringify({ stdout: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { stdout: 'fast' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('.kill() with signal string (backward compatible)', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const p = $.quiet.nothrow\`sleep 10\`
				await new Promise(r => setTimeout(r, 50))
				const killed = p.kill('SIGTERM')
				await p
				console.log(JSON.stringify({ killed }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { killed: true })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('.kill({ sigkillTimeout }) escalates to SIGKILL', () => {
		const dir = mktempdir()
		try {
			// Process that ignores SIGTERM but dies from SIGKILL
			const output = runQx(`
				const start = Date.now()
				const p = $.quiet.nothrow\`trap '' TERM; sleep 10\`
				await new Promise(r => setTimeout(r, 50))
				p.kill({ sigkillTimeout: 100 })
				await p
				const elapsed = Date.now() - start
				// Should complete quickly (SIGKILL after 100ms), not wait for sleep 10
				console.log(JSON.stringify({ killedQuickly: elapsed < 500 }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { killedQuickly: true })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('descendant processes are killed on exit', () => {
		const dir = mktempdir()
		try {
			const pidFile = `${dir}/child.pid`
			// Start a background process, write its PID, then exit via process.exit()
			const start = Date.now()
			runQx(`
				const p = $.quiet\`sh -c "echo \\$\\$ > ${pidFile}; sleep 5"\`
				await new Promise(r => setTimeout(r, 100))  // Let it start and write PID
				process.exit(0)
			`, dir)
			const elapsed = Date.now() - start
			assert.ok(elapsed < 2000, `qx should exit promptly, took ${elapsed}ms`)

			// Read the PID and check if it's still running (not zombie)
			const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
			assert.strictEqual(isProcessRunning(pid), false, 'Child process should have been killed on exit')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('.kill({ sigkillTimeout }) kills orphaned grandchildren', () => {
		const dir = mktempdir()
		try {
			// The outer shell (qx's /bin/sh -e -c) does NOT trap SIGTERM, so it dies.
			// The inner "sh -c" traps SIGTERM and its child (sleep) inherits SIG_IGN.
			// After the outer shell dies, the inner shell + sleep become orphans.
			// sigkillTimeout must still find and SIGKILL them.
			const output = runQx(`
				const start = Date.now()
				const p = $.quiet.nothrow\`sh -c "trap '' TERM; sleep 10"\`
				await new Promise(r => setTimeout(r, 50))
				p.kill({ sigkillTimeout: 200 })
				await p
				const elapsed = Date.now() - start
				console.log(JSON.stringify({ killedQuickly: elapsed < 1000 }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { killedQuickly: true })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('.kill() on deep process tree kills all levels', () => {
		const dir = mktempdir()
		try {
			const pidFile = `${dir}/deep.pid`
			// Create a 3-level deep process tree: sh -> sh -> sh -> sleep
			// The deepest sleep writes its PID to a file.
			const output = runQx(`
				const p = $.quiet.nothrow\`sh -c "sh -c 'sh -c \\"echo \\\\\\$\\\\\\$ > ${pidFile}; sleep 10\\"'"\`
				await new Promise(r => setTimeout(r, 200))
				p.kill({ sigkillTimeout: 200 })
				await p
				const elapsed = Date.now()
				console.log('done')
			`, dir)
			assert.strictEqual(output, 'done')

			// The deepest process should be dead
			const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
			assert.strictEqual(isProcessRunning(pid), false, 'Deepest process should have been killed')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('exit handler kills deep process tree', () => {
		const dir = mktempdir()
		try {
			const pidFile = `${dir}/deep_exit.pid`
			// Start a deep process tree then exit immediately.
			// The exit handler should kill everything.
			runQx(`
				const p = $.quiet\`sh -c "sh -c 'echo \\$\\$ > ${pidFile}; sleep 10'"\`
				await new Promise(r => setTimeout(r, 200))
				process.exit(0)
			`, dir)

			const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
			assert.strictEqual(isProcessRunning(pid), false, 'Deep child should have been killed on exit')
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

describe('qx retry', () => {
	test('retry() succeeds on first try', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				let attempts = 0
				const result = await retry(3, async () => {
					attempts++
					return await $.quiet\`echo success\`
				})
				console.log(JSON.stringify({ attempts, stdout: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { attempts: 1, stdout: 'success' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('retry() retries on failure', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				let attempts = 0
				try {
					await retry(3, async () => {
						attempts++
						await $.quiet\`sh -c 'exit 1'\`
					})
				} catch (e) {}
				console.log(JSON.stringify({ attempts }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { attempts: 3 })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

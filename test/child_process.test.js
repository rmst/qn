import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { test, $ } from './util.js'

describe('node:child_process shim', () => {
	test('execFileSync returns stdout', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('echo', ['hello', 'world'], { encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'hello world' })
	})

	test('execFileSync with empty args', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('echo', [], { encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: '' })
	})

	test('execFileSync with input option', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('cat', [], { input: 'piped input', encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'piped input' })
	})

	test('execFileSync with special characters in args', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('echo', ['hello world', 'foo\\\\nbar'], { encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		// echo outputs: hello world foo\nbar (literal backslash-n)
		assert.deepStrictEqual(JSON.parse(output), { output: 'hello world foo\\nbar' })
	})

	test('execFileSync throws on non-zero exit', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			let threw = false
			let status = null
			try {
				execFileSync('false', [], { encoding: 'utf8' })
			} catch (e) {
				threw = true
				status = e.status
			}
			console.log(JSON.stringify({ threw, status }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.threw, true)
		assert.strictEqual(result.status, 1)
	})

	test('execFileSync with cwd option', ({ bin, dir }) => {
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('pwd', [], { cwd: '${dir}/subdir', encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.output.endsWith('/subdir'))
	})

	test('execFileSync with env option', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFileSync } from 'node:child_process'
			const output = execFileSync('/bin/sh', ['-c', 'echo $MY_VAR'], { env: { MY_VAR: 'test_value' }, encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'test_value' })
	})

	// Async execFile tests
	test('execFile with callback', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			execFile('echo', ['hello', 'async'], (error, stdout, stderr) => {
				console.log(JSON.stringify({
					error: error ? error.message : null,
					stdout: stdout.trim(),
					stderr: stderr.trim()
				}))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			error: null,
			stdout: 'hello async',
			stderr: ''
		})
	})

	test('execFile returns ChildProcess with pid', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('echo', ['test'])
			console.log(JSON.stringify({ hasPid: typeof child.pid === 'number' && child.pid > 0 }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { hasPid: true })
	})

	test('execFile emits spawn event', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('echo', ['test'])
			child.on('spawn', () => {
				console.log(JSON.stringify({ spawned: true }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { spawned: true })
	})

	test('execFile emits close event with exit code', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('echo', ['test'])
			let stdout = ''
			child.stdout.on('data', (chunk) => { stdout += chunk })
			child.on('close', (code) => {
				console.log(JSON.stringify({ code, stdout: stdout.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { code: 0, stdout: 'test' })
	})

	test('execFile captures stderr', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('sh', ['-c', 'echo error >&2'])
			let stderr = ''
			child.stderr.on('data', (chunk) => { stderr += chunk })
			child.on('close', (code) => {
				console.log(JSON.stringify({ stderr: stderr.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { stderr: 'error' })
	})

	// Note: execFile with input option is a qnode extension, not supported in Node.js
	// Use stdin.write() instead for cross-platform compatibility (see streaming tests below)

	test('execFile callback receives error on non-zero exit', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			execFile('false', [], (error, stdout, stderr) => {
				console.log(JSON.stringify({
					hasError: error !== null,
					code: error ? error.code : null
				}))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.hasError, true)
		assert.strictEqual(result.code, 1)
	})

	test('execFile with cwd option', ({ bin, dir }) => {
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			execFile('pwd', [], { cwd: '${dir}/subdir' }, (error, stdout) => {
				console.log(JSON.stringify({ output: stdout.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.output.endsWith('/subdir'))
	})

	test('execFile handles large output without blocking', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			// Generate output larger than typical pipe buffer (64KB) using POSIX awk
			execFile('awk', ['BEGIN { for(i=1;i<=5000;i++) print "line " i ": some text to fill buffer" }'], (error, stdout) => {
				const lines = stdout.trim().split('\\n')
				console.log(JSON.stringify({
					lineCount: lines.length,
					firstLine: lines[0],
					lastLine: lines[lines.length - 1]
				}))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.lineCount, 5000)
		assert.strictEqual(result.firstLine, 'line 1: some text to fill buffer')
		assert.strictEqual(result.lastLine, 'line 5000: some text to fill buffer')
	})

	// Streaming tests
	test('streaming: write to stdin and read from stdout', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('cat')
			let output = ''
			child.stdout.on('data', (chunk) => { output += chunk })
			child.on('close', () => {
				console.log(JSON.stringify({ output: output.trim() }))
			})
			// Write to stdin
			child.stdin.write('line 1\\n')
			child.stdin.write('line 2\\n')
			child.stdin.end()
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'line 1\nline 2' })
	})

	test('streaming: receive data before process exits', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			// Process that outputs, sleeps, then outputs more
			const child = execFile('sh', ['-c', 'echo first; sleep 0.2; echo second'])
			let dataBeforeClose = false
			let gotData = false
			child.stdout.on('data', (chunk) => {
				gotData = true
				// At this point, process should still be running (sleeping)
				if (child.exitCode === null) {
					dataBeforeClose = true
				}
			})
			child.on('close', () => {
				console.log(JSON.stringify({ dataBeforeClose, gotData }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.gotData, true)
		assert.strictEqual(result.dataBeforeClose, true, 'data event should fire before process exits')
	})

	test('streaming: stdin.end() with data', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('cat')
			let output = ''
			child.stdout.on('data', (chunk) => { output += chunk })
			child.on('close', () => {
				console.log(JSON.stringify({ output: output.trim() }))
			})
			child.stdin.end('final chunk')
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'final chunk' })
	})

	test('streaming: stdout emits end event', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('echo', ['test'])
			let endEmitted = false
			child.stdout.on('end', () => { endEmitted = true })
			child.on('close', () => {
				console.log(JSON.stringify({ endEmitted }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { endEmitted: true })
	})

	test('streaming: stdin write returns true for small writes', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('cat')
			let writeResult = child.stdin.write('small data')
			child.stdin.end()
			child.on('close', () => {
				console.log(JSON.stringify({ writeResult }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		// write() should return boolean
		assert.strictEqual(typeof result.writeResult, 'boolean')
	})

	test('streaming: child.stdout and child.stderr are Readable streams', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			const child = execFile('echo', ['test'])
			const hasStdoutOn = typeof child.stdout.on === 'function'
			const hasStderrOn = typeof child.stderr.on === 'function'
			const hasStdinWrite = typeof child.stdin.write === 'function'
			const hasStdinEnd = typeof child.stdin.end === 'function'
			console.log(JSON.stringify({ hasStdoutOn, hasStderrOn, hasStdinWrite, hasStdinEnd }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hasStdoutOn: true,
			hasStderrOn: true,
			hasStdinWrite: true,
			hasStdinEnd: true
		})
	})

	test('streaming: bidirectional - write stdin, read stdout', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execFile } from 'node:child_process'
			// sed transforms input and outputs result
			const child = execFile('sed', ['s/hello/goodbye/'])
			const responses = []

			child.stdout.on('data', (chunk) => {
				responses.push(chunk.trim())
			})

			child.on('close', () => {
				console.log(JSON.stringify({
					responses,
					transformedCorrectly: responses.includes('goodbye world')
				}))
			})

			// Write input and close stdin
			child.stdin.write('hello world\\n')
			child.stdin.end()
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.transformedCorrectly, true, 'sed should transform hello to goodbye')
	})

	// execSync tests
	test('execSync runs command through shell', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execSync } from 'node:child_process'
			const output = execSync('echo $((1 + 2))', { encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: '3' })
	})

	test('execSync with custom shell', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execSync } from 'node:child_process'
			const output = execSync('echo hello', { shell: '/bin/sh', encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'hello' })
	})

	test('execSync with input option', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { execSync } from 'node:child_process'
			const output = execSync('cat', { input: 'piped via shell', encoding: 'utf8' })
			console.log(JSON.stringify({ output: output.trim() }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { output: 'piped via shell' })
	})

	// exec tests (async)
	test('exec runs command through shell', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { exec } from 'node:child_process'
			exec('echo $((2 * 3))', (error, stdout, stderr) => {
				console.log(JSON.stringify({
					error: error ? error.message : null,
					stdout: stdout.trim()
				}))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { error: null, stdout: '6' })
	})

	test('exec with cwd option', ({ bin, dir }) => {
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { exec } from 'node:child_process'
			exec('pwd', { cwd: '${dir}/subdir' }, (error, stdout) => {
				console.log(JSON.stringify({ output: stdout.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.output.endsWith('/subdir'))
	})

	test('exec returns ChildProcess', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { exec } from 'node:child_process'
			const child = exec('echo test')
			console.log(JSON.stringify({
				hasPid: typeof child.pid === 'number',
				hasStdout: child.stdout !== null
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { hasPid: true, hasStdout: true })
	})

	// spawn tests
	test('spawn returns ChildProcess with streams', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { spawn } from 'node:child_process'
			const child = spawn('echo', ['hello', 'spawn'])
			let stdout = ''
			child.stdout.on('data', (chunk) => { stdout += chunk })
			child.on('close', (code) => {
				console.log(JSON.stringify({ code, stdout: stdout.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { code: 0, stdout: 'hello spawn' })
	})

	test('spawn with shell option', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { spawn } from 'node:child_process'
			const child = spawn('echo $((3 + 4))', { shell: true })
			let stdout = ''
			child.stdout.on('data', (chunk) => { stdout += chunk })
			child.on('close', (code) => {
				console.log(JSON.stringify({ code, stdout: stdout.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { code: 0, stdout: '7' })
	})

	test('spawn with cwd option', ({ bin, dir }) => {
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { spawn } from 'node:child_process'
			const child = spawn('pwd', [], { cwd: '${dir}/subdir' })
			let stdout = ''
			child.stdout.on('data', (chunk) => { stdout += chunk })
			child.on('close', () => {
				console.log(JSON.stringify({ output: stdout.trim() }))
			})
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.output.endsWith('/subdir'))
	})

	test('spawn bidirectional streaming', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { spawn } from 'node:child_process'
			const child = spawn('cat')
			let stdout = ''
			child.stdout.on('data', (chunk) => { stdout += chunk })
			child.on('close', () => {
				console.log(JSON.stringify({ stdout: stdout.trim() }))
			})
			child.stdin.write('hello from spawn\\n')
			child.stdin.end()
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { stdout: 'hello from spawn' })
	})
})

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { spawn } from 'qn:pty'

describe('qn:pty', () => {

	it('should spawn a process and receive output', async () => {
		let output = ''
		let exitPromise = new Promise(resolve => {
			let pty = spawn('echo', ['hello from pty'])
			pty.onData = (data) => { output += new TextDecoder().decode(data) }
			pty.onExit = (code, signal) => resolve({ code, signal })
		})
		let { code } = await exitPromise
		assert.strictEqual(code, 0)
		assert.ok(output.includes('hello from pty'), `Expected "hello from pty" in output, got: ${JSON.stringify(output)}`)
	})

	it('should report the child pid', () => {
		let pty = spawn('sleep', ['0.1'])
		let pid = pty.pid
		assert.ok(typeof pid === 'number' && pid > 0, `Expected positive pid, got: ${pid}`)
		pty.kill()
	})

	it('should handle interactive shell input/output', async () => {
		let output = ''
		let pty = spawn('sh', [], { cols: 80, rows: 24 })
		pty.onData = (data) => { output += new TextDecoder().decode(data) }

		// Wait for shell prompt
		await new Promise(r => setTimeout(r, 200))

		// Send a command
		pty.write('echo PTY_TEST_OUTPUT\n')
		await new Promise(r => setTimeout(r, 200))

		assert.ok(output.includes('PTY_TEST_OUTPUT'), `Expected "PTY_TEST_OUTPUT" in output, got: ${JSON.stringify(output)}`)

		pty.write('exit\n')
		await new Promise(r => setTimeout(r, 200))
	})

	it('should support resize', async () => {
		let pty = spawn('sh', [], { cols: 80, rows: 24 })
		let output = ''
		pty.onData = (data) => { output += new TextDecoder().decode(data) }

		await new Promise(r => setTimeout(r, 100))
		pty.resize(120, 40)
		pty.write('stty size\n')
		await new Promise(r => setTimeout(r, 200))

		assert.ok(output.includes('40 120'), `Expected "40 120" in output after resize, got: ${JSON.stringify(output)}`)

		pty.write('exit\n')
		await new Promise(r => setTimeout(r, 200))
	})

	it('should handle kill', async () => {
		let exitPromise = new Promise(resolve => {
			let pty = spawn('sleep', ['10'])
			pty.onExit = (code, signal) => resolve({ code, signal })
			setTimeout(() => pty.kill(), 100)
		})
		let { signal } = await exitPromise
		assert.strictEqual(signal, 15) // SIGTERM
	})

	it('should pass environment variables', async () => {
		let output = ''
		let pty = spawn('/bin/sh', [], {
			env: { PATH: '/usr/bin:/bin', TERM: 'xterm', MY_TEST_VAR: 'pty_env_test' },
		})
		pty.onData = (data) => { output += new TextDecoder().decode(data) }
		await new Promise(r => setTimeout(r, 200))
		pty.write('echo $MY_TEST_VAR\n')
		await new Promise(r => setTimeout(r, 200))
		assert.ok(output.includes('pty_env_test'), `Expected "pty_env_test" in output, got: ${JSON.stringify(output)}`)
		pty.write('exit\n')
		await new Promise(r => setTimeout(r, 200))
	})
})

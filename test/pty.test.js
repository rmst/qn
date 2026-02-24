import { describe, it } from 'node:test'
import assert from 'node:assert'
import { spawn } from 'qn:pty'

// Wait for a condition to become true, polling every 10ms
function waitFor(fn, timeout = 2000) {
	return new Promise((resolve, reject) => {
		let elapsed = 0
		let check = () => {
			if (fn()) return resolve()
			elapsed += 10
			if (elapsed >= timeout) return reject(new Error('waitFor timed out'))
			setTimeout(check, 10)
		}
		check()
	})
}

describe('qn:pty', () => {

	it('should spawn a process and receive output', async () => {
		let output = ''
		let exitPromise = new Promise(resolve => {
			let pty = spawn('echo', ['hello from pty'])
			pty.onData((data) => { output += data })
			pty.onExit(resolve)
		})
		let { exitCode } = await exitPromise
		assert.strictEqual(exitCode, 0)
		assert.ok(output.includes('hello from pty'), `Expected "hello from pty" in output, got: ${JSON.stringify(output)}`)
	})

	it('should report the child pid', () => {
		let pty = spawn('sleep', ['0.1'])
		let pid = pty.pid
		assert.ok(typeof pid === 'number' && pid > 0, `Expected positive pid, got: ${pid}`)
		pty.kill()
	})

	it('should expose cols and rows', () => {
		let pty = spawn('sleep', ['0.1'], { cols: 100, rows: 50 })
		assert.strictEqual(pty.cols, 100)
		assert.strictEqual(pty.rows, 50)
		pty.kill()
	})

	it('should update cols and rows on resize', async () => {
		let pty = spawn('sh', [], { cols: 80, rows: 24 })
		let output = ''
		pty.onData((data) => { output += data })

		await waitFor(() => output.length > 0).catch(() => {})
		pty.resize(120, 40)
		assert.strictEqual(pty.cols, 120)
		assert.strictEqual(pty.rows, 40)

		output = ''
		pty.write('stty size\n')
		await waitFor(() => output.includes('40 120'))
		pty.write('exit\n')
	})

	it('should handle interactive shell input/output', async () => {
		let output = ''
		let pty = spawn('sh', [], { cols: 80, rows: 24 })
		pty.onData((data) => { output += data })

		await waitFor(() => output.length > 0).catch(() => {})
		output = ''
		pty.write('echo PTY_TEST_OUTPUT\n')
		await waitFor(() => output.includes('PTY_TEST_OUTPUT'))

		pty.write('exit\n')
	})

	it('should handle kill', async () => {
		let exitPromise = new Promise(resolve => {
			let pty = spawn('sleep', ['10'])
			pty.onExit(resolve)
			setTimeout(() => pty.kill(), 50)
		})
		let { signal } = await exitPromise
		assert.strictEqual(signal, 15) // SIGTERM
	})

	it('should pass environment variables', async () => {
		let output = ''
		let pty = spawn('/bin/sh', [], {
			env: { PATH: '/usr/bin:/bin', TERM: 'xterm', MY_TEST_VAR: 'pty_env_test' },
		})
		pty.onData((data) => { output += data })
		await waitFor(() => output.length > 0).catch(() => {})
		output = ''
		pty.write('echo $MY_TEST_VAR\n')
		await waitFor(() => output.includes('pty_env_test'))
		pty.write('exit\n')
	})

	it('should support multiple data listeners with dispose', async () => {
		let output1 = '', output2 = ''
		let pty = spawn('sh', [], { cols: 80, rows: 24 })
		let d1 = pty.onData((data) => { output1 += data })
		let d2 = pty.onData((data) => { output2 += data })

		await waitFor(() => output1.length > 0).catch(() => {})
		output1 = ''; output2 = ''
		pty.write('echo MULTI_TEST\n')
		await waitFor(() => output1.includes('MULTI_TEST'))
		assert.ok(output2.includes('MULTI_TEST'), 'Listener 2 should receive data')

		// Dispose first listener, send more data
		d1.dispose()
		output1 = ''; output2 = ''
		pty.write('echo AFTER_DISPOSE\n')
		await waitFor(() => output2.includes('AFTER_DISPOSE'))
		assert.ok(!output1.includes('AFTER_DISPOSE'), 'Disposed listener should not receive data')

		d2.dispose()
		pty.write('exit\n')
	})

	it('should deliver onData as strings', async () => {
		let receivedType = null
		let pty = spawn('echo', ['type test'])
		pty.onData((data) => { receivedType = typeof data })
		await waitFor(() => receivedType !== null)
		assert.strictEqual(receivedType, 'string', `Expected string data, got: ${receivedType}`)
	})

	it('should support pause and resume', async () => {
		let output = ''
		let pty = spawn('sh', [], { cols: 80, rows: 24 })
		pty.onData((data) => { output += data })

		await waitFor(() => output.length > 0).catch(() => {})
		output = ''
		pty.write('echo BEFORE_PAUSE\n')
		await waitFor(() => output.includes('BEFORE_PAUSE'))

		pty.pause()
		output = ''
		pty.write('echo DURING_PAUSE\n')
		// Give time for data to arrive (it shouldn't while paused)
		await new Promise(r => setTimeout(r, 100))
		assert.ok(!output.includes('DURING_PAUSE'), 'Should not receive data while paused')

		pty.resume()
		await waitFor(() => output.includes('DURING_PAUSE'))

		pty.write('exit\n')
	})
})

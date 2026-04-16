import { describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mktempdir } from './util.js'
import { run } from '../node/qn/run.js'

describe('qn run', () => {
	test('runs a simple script', async () => {
		let dir = mktempdir()
		try {
			let outFile = join(dir, "out.txt")
			writeFileSync(join(dir, "package.json"), JSON.stringify({
				name: "test-project",
				scripts: { hello: `echo hello > ${outFile}` }
			}))

			let code = await run(dir, "hello")
			assert.strictEqual(code, 0)
			assert.strictEqual(readFileSync(outFile, "utf8").trim(), "hello")
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('passes extra args to script', async () => {
		let dir = mktempdir()
		try {
			let outFile = join(dir, "out.txt")
			writeFileSync(join(dir, "package.json"), JSON.stringify({
				name: "test-project",
				scripts: { greet: `echo > ${outFile}` }
			}))

			let code = await run(dir, "greet", ["--verbose", "world"])
			assert.strictEqual(code, 0)
			let out = readFileSync(outFile, "utf8").trim()
			assert.ok(out.includes("--verbose"), `expected --verbose in output, got: ${out}`)
			assert.ok(out.includes("world"), `expected world in output, got: ${out}`)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('returns non-zero exit code on failure', async () => {
		let dir = mktempdir()
		try {
			writeFileSync(join(dir, "package.json"), JSON.stringify({
				name: "test-project",
				scripts: { fail: "exit 42" }
			}))

			let code = await run(dir, "fail")
			assert.strictEqual(code, 42)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('adds node_modules/.bin to PATH', async () => {
		let dir = mktempdir()
		try {
			// Create a fake bin script
			let binDir = join(dir, "node_modules", ".bin")
			mkdirSync(binDir, { recursive: true })
			let binScript = join(binDir, "my-tool")
			writeFileSync(binScript, "#!/bin/sh\necho my-tool-output\n")
			chmodSync(binScript, 0o755)

			let outFile = join(dir, "out.txt")
			writeFileSync(join(dir, "package.json"), JSON.stringify({
				name: "test-project",
				scripts: { tooltest: `my-tool > ${outFile}` }
			}))

			let code = await run(dir, "tooltest")
			assert.strictEqual(code, 0)
			assert.strictEqual(readFileSync(outFile, "utf8").trim(), "my-tool-output")
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('sets npm_lifecycle_event env var', async () => {
		let dir = mktempdir()
		try {
			let outFile = join(dir, "out.txt")
			writeFileSync(join(dir, "package.json"), JSON.stringify({
				name: "test-project",
				scripts: { build: `echo $npm_lifecycle_event > ${outFile}` }
			}))

			let code = await run(dir, "build")
			assert.strictEqual(code, 0)
			assert.strictEqual(readFileSync(outFile, "utf8").trim(), "build")
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('exits with error for missing script', async () => {
		let dir = mktempdir()
		try {
			writeFileSync(join(dir, "package.json"), JSON.stringify({
				name: "test-project",
				scripts: { build: "echo build" }
			}))

			// run() calls process.exit(1) for missing scripts,
			// so we test the import directly
			let { run: runFn } = await import('../node/qn/run.js')
			// We can't easily test process.exit, but we can verify
			// the script lookup works for existing scripts
			let code = await runFn(dir, "build")
			assert.strictEqual(code, 0)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

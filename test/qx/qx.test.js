import { describe, test } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, readFileSync, rmSync, mkdtempSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QX, QNODE } from '../util.js'

const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), '/')))

const runQx = (script, dir) => {
	writeFileSync(`${dir}/test.js`, script)
	return execSync(`${QX()} ${dir}/test.js`, { encoding: 'utf8', cwd: dir }).trim()
}

describe('qx $ function', () => {
	test('basic command execution', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $\`echo "Hello World"\`
				console.log(JSON.stringify({ stdout: result.stdout, exitCode: result.exitCode }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { stdout: 'Hello World\n', exitCode: 0 })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('ProcessOutput.text() removes trailing newline', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const text = await $\`echo "Hello"\`.text()
				console.log(JSON.stringify({ text }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { text: 'Hello' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('ProcessOutput.lines() splits output', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const lines = await $\`echo "line1\\nline2\\nline3"\`.lines()
				console.log(JSON.stringify({ lines }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { lines: ['line1', 'line2', 'line3'] })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('ProcessOutput.json() parses JSON', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const data = await $\`echo '{"name":"test","value":42}'\`.json()
				console.log(JSON.stringify(data))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { name: 'test', value: 42 })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('nothrow() suppresses error on non-zero exit', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $\`sh -c 'exit 1'\`.nothrow()
				console.log(JSON.stringify({ exitCode: result.exitCode }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { exitCode: 1 })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('shell piping works', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $\`echo "hello world" | tr ' ' '_'\`
				console.log(JSON.stringify({ stdout: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { stdout: 'hello_world' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('template interpolation', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const name = "qx"
				const result = await $\`echo "Hello \${name}"\`
				console.log(JSON.stringify({ stdout: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { stdout: 'Hello qx' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('pipe to another ProcessPromise', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $\`echo "hello"\`.pipe($\`cat\`)
				console.log(JSON.stringify({ stdout: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { stdout: 'hello' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('pipe to file', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				import { readFileSync } from 'node:fs'
				await $\`echo file_content\`.pipe('${dir}/output.txt')
				const content = readFileSync('${dir}/output.txt', 'utf8')
				console.log(JSON.stringify({ content: content.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { content: 'file_content' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

describe('qx helpers', () => {
	test('cd and pwd', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const original = pwd()
				cd('/tmp')
				const after = pwd()
				cd(original)
				const restored = pwd()
				console.log(JSON.stringify({ after, original, restored }))
			`, dir)
			const result = JSON.parse(output)
			assert.strictEqual(result.after, '/tmp')
			assert.strictEqual(result.restored, result.original)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('within preserves cwd', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const before = pwd()
				await within(async () => {
					cd('/tmp')
				})
				const after = pwd()
				console.log(JSON.stringify({ same: before === after }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { same: true })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('sleep delays execution', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const start = Date.now()
				await sleep(50)
				const elapsed = Date.now() - start
				console.log(JSON.stringify({ delayed: elapsed >= 45 }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { delayed: true })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('argv contains script arguments', () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/test.js`, `
				console.log(JSON.stringify({ argv }))
			`)
			const output = execSync(`${QX()} ${dir}/test.js arg1 arg2`, { encoding: 'utf8' }).trim()
			assert.deepStrictEqual(JSON.parse(output), { argv: ['arg1', 'arg2'] })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

describe('qx ProcessOutput', () => {
	test('toString() removes trailing newline', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $\`echo "test"\`
				console.log(JSON.stringify({ str: result.toString() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { str: 'test' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('stderr is captured', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const result = await $\`/bin/sh -c "echo error >&2"\`.nothrow()
				console.log(JSON.stringify({ stderr: result.stderr.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { stderr: 'error' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

describe('qx shell escaping', () => {
	test('escapes spaces in paths', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const path = "hello world"
				const result = await $\`echo \${path}\`
				console.log(JSON.stringify({ out: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { out: 'hello world' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('escapes double quotes', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const val = 'say "hello"'
				const result = await $\`echo \${val}\`
				console.log(JSON.stringify({ out: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { out: 'say "hello"' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('escapes dollar signs', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const val = "price is $100"
				const result = await $\`echo \${val}\`
				console.log(JSON.stringify({ out: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { out: 'price is $100' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('escapes backticks', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const val = "test\`cmd\`test"
				const result = await $\`echo \${val}\`
				console.log(JSON.stringify({ out: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { out: 'test`cmd`test' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('handles single quotes in strings', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const val = "it's working"
				const result = await $\`echo \${val}\`
				console.log(JSON.stringify({ out: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { out: "it's working" })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('file path with spaces works', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				import { writeFileSync } from 'node:fs'
				writeFileSync('${dir}/my file.txt', 'content here')
				const path = '${dir}/my file.txt'
				const result = await $\`cat \${path}\`
				console.log(JSON.stringify({ out: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { out: 'content here' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('prevents glob expansion', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const val = "*.txt"
				const result = await $\`echo \${val}\`
				console.log(JSON.stringify({ out: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { out: '*.txt' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('array interpolation joins with spaces', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				const args = ['one', 'two', 'three']
				const result = await $\`echo \${args}\`
				console.log(JSON.stringify({ out: result.stdout.trim() }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { out: 'one two three' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

describe('qx as library in qnode', () => {
	test('import { $ } from qx works', () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/test.js`, `
				import { $ } from 'qx'
				const result = await $\`echo "library test"\`
				console.log(JSON.stringify({ out: result.stdout.trim() }))
			`)
			const output = execSync(`${QNODE()} ${dir}/test.js`, { encoding: 'utf8' }).trim()
			assert.deepStrictEqual(JSON.parse(output), { out: 'library test' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('import $ from qx (default export) works', () => {
		const dir = mktempdir()
		try {
			writeFileSync(`${dir}/test.js`, `
				import $ from 'qx'
				const result = await $\`echo "default export"\`
				console.log(JSON.stringify({ out: result.stdout.trim() }))
			`)
			const output = execSync(`${QNODE()} ${dir}/test.js`, { encoding: 'utf8' }).trim()
			assert.deepStrictEqual(JSON.parse(output), { out: 'default export' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

describe('qx with node shims', () => {
	test('can use node:fs', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				import { writeFileSync, readFileSync } from 'node:fs'
				writeFileSync('${dir}/test.txt', 'hello')
				const content = readFileSync('${dir}/test.txt', 'utf8')
				console.log(JSON.stringify({ content }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { content: 'hello' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('can use node:path', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				import path from 'node:path'
				const result = path.join('/foo', 'bar', 'baz.txt')
				console.log(JSON.stringify({ result }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { result: '/foo/bar/baz.txt' })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('can use node:process', () => {
		const dir = mktempdir()
		try {
			const output = runQx(`
				import process from 'node:process'
				const cwd = process.cwd()
				console.log(JSON.stringify({ hasCwd: typeof cwd === 'string' }))
			`, dir)
			assert.deepStrictEqual(JSON.parse(output), { hasCwd: true })
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

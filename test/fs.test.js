import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { test, $ } from './util.js'

describe('node:fs shim', () => {
	test('writeFileSync and readFileSync', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			writeFileSync('${dir}/out.txt', 'hello world')
			console.log(JSON.stringify({ content: readFileSync('${dir}/out.txt', 'utf8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'hello world' })
	})

	test('readFileSync with utf-8 encoding variant', ({ bin, dir }) => {
		writeFileSync(`${dir}/data.txt`, 'utf-8 test content')
		writeFileSync(`${dir}/test.js`, `
			import { readFileSync } from 'node:fs'
			console.log(JSON.stringify({ content: readFileSync('${dir}/data.txt', 'utf-8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'utf-8 test content' })
	})

	test('readFileSync with options object', ({ bin, dir }) => {
		writeFileSync(`${dir}/data.txt`, 'options object test')
		writeFileSync(`${dir}/test.js`, `
			import { readFileSync } from 'node:fs'
			console.log(JSON.stringify({ content: readFileSync('${dir}/data.txt', { encoding: 'utf8' }) }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'options object test' })
	})

	test('writeFileSync with empty string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			writeFileSync('${dir}/empty.txt', '')
			console.log(JSON.stringify({ content: readFileSync('${dir}/empty.txt', 'utf8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: '' })
	})

	test('writeFileSync with unicode content', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			writeFileSync('${dir}/unicode.txt', '日本語 émojis 🎉 中文')
			console.log(JSON.stringify({ content: readFileSync('${dir}/unicode.txt', 'utf8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: '日本語 émojis 🎉 中文' })
	})

	test('writeFileSync with multiline content', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			writeFileSync('${dir}/multi.txt', 'line1\\nline2\\nline3')
			console.log(JSON.stringify({ content: readFileSync('${dir}/multi.txt', 'utf8') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'line1\nline2\nline3' })
	})

	test('existsSync matches Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/exists.txt`, 'test')
		writeFileSync(`${dir}/test.js`, `
			import { existsSync } from 'node:fs'
			console.log(JSON.stringify({
				exists: existsSync('${dir}/exists.txt'),
				missing: existsSync('${dir}/missing.txt')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { exists: true, missing: false })
	})

	test('existsSync with directories', ({ bin, dir }) => {
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { existsSync } from 'node:fs'
			console.log(JSON.stringify({
				dirExists: existsSync('${dir}/subdir'),
				missingDir: existsSync('${dir}/nonexistent')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { dirExists: true, missingDir: false })
	})

	test('statSync.isFile matches Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'test')
		writeFileSync(`${dir}/test.js`, `
			import { statSync } from 'node:fs'
			const stats = statSync('${dir}/file.txt')
			console.log(JSON.stringify({
				isFile: stats.isFile(),
				isDirectory: stats.isDirectory()
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isFile: true, isDirectory: false })
	})

	test('statSync.isDirectory matches Node.js', ({ bin, dir }) => {
		mkdirSync(`${dir}/mydir`)
		writeFileSync(`${dir}/test.js`, `
			import { statSync } from 'node:fs'
			const stats = statSync('${dir}/mydir')
			console.log(JSON.stringify({
				isFile: stats.isFile(),
				isDirectory: stats.isDirectory()
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isFile: false, isDirectory: true })
	})

	test('statSync size property matches Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/sized.txt`, 'exactly 20 chars!!!!')
		writeFileSync(`${dir}/test.js`, `
			import { statSync } from 'node:fs'
			const stats = statSync('${dir}/sized.txt')
			console.log(JSON.stringify({ size: stats.size }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { size: 20 })
	})

	test('lstatSync on regular file matches statSync', ({ bin, dir }) => {
		writeFileSync(`${dir}/regular.txt`, 'regular file')
		writeFileSync(`${dir}/test.js`, `
			import { statSync, lstatSync } from 'node:fs'
			const stat = statSync('${dir}/regular.txt')
			const lstat = lstatSync('${dir}/regular.txt')
			console.log(JSON.stringify({
				statIsFile: stat.isFile(),
				lstatIsFile: lstat.isFile(),
				statIsSymlink: stat.isSymbolicLink(),
				lstatIsSymlink: lstat.isSymbolicLink()
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			statIsFile: true,
			lstatIsFile: true,
			statIsSymlink: false,
			lstatIsSymlink: false
		})
	})

	test('readdirSync returns files without . and ..', ({ bin, dir }) => {
		writeFileSync(`${dir}/a.txt`, 'a')
		writeFileSync(`${dir}/b.txt`, 'b')
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { readdirSync } from 'node:fs'
			const files = readdirSync('${dir}')
			console.log(JSON.stringify({
				hasDot: files.includes('.'),
				hasDotDot: files.includes('..'),
				hasA: files.includes('a.txt'),
				hasB: files.includes('b.txt'),
				hasSubdir: files.includes('subdir')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hasDot: false,
			hasDotDot: false,
			hasA: true,
			hasB: true,
			hasSubdir: true
		})
	})

	test('readdirSync empty directory', ({ bin, dir }) => {
		mkdirSync(`${dir}/empty`)
		writeFileSync(`${dir}/test.js`, `
			import { readdirSync } from 'node:fs'
			const files = readdirSync('${dir}/empty')
			console.log(JSON.stringify({ count: files.length, files }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { count: 0, files: [] })
	})

	test('mkdirSync creates directory', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { mkdirSync, existsSync, statSync } from 'node:fs'
			mkdirSync('${dir}/newdir')
			const exists = existsSync('${dir}/newdir')
			const isDir = statSync('${dir}/newdir').isDirectory()
			console.log(JSON.stringify({ exists, isDir }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { exists: true, isDir: true })
	})

	test('mkdirSync recursive creates nested directories', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { mkdirSync, existsSync } from 'node:fs'
			mkdirSync('${dir}/a/b/c', { recursive: true })
			console.log(JSON.stringify({
				aExists: existsSync('${dir}/a'),
				bExists: existsSync('${dir}/a/b'),
				cExists: existsSync('${dir}/a/b/c')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { aExists: true, bExists: true, cExists: true })
	})

	test('mkdirSync recursive with existing parent', ({ bin, dir }) => {
		mkdirSync(`${dir}/parent`)
		writeFileSync(`${dir}/test.js`, `
			import { mkdirSync, existsSync } from 'node:fs'
			mkdirSync('${dir}/parent/child/grandchild', { recursive: true })
			console.log(JSON.stringify({
				parentExists: existsSync('${dir}/parent'),
				childExists: existsSync('${dir}/parent/child'),
				grandchildExists: existsSync('${dir}/parent/child/grandchild')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { parentExists: true, childExists: true, grandchildExists: true })
	})

	test('unlinkSync removes file', ({ bin, dir }) => {
		writeFileSync(`${dir}/toremove.txt`, 'remove me')
		writeFileSync(`${dir}/test.js`, `
			import { unlinkSync, existsSync } from 'node:fs'
			const beforeExists = existsSync('${dir}/toremove.txt')
			unlinkSync('${dir}/toremove.txt')
			const afterExists = existsSync('${dir}/toremove.txt')
			console.log(JSON.stringify({ beforeExists, afterExists }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { beforeExists: true, afterExists: false })
	})

	test('symlinkSync creates symlink', ({ bin, dir }) => {
		writeFileSync(`${dir}/original.txt`, 'original content')
		writeFileSync(`${dir}/test.js`, `
			import { symlinkSync, readFileSync, lstatSync } from 'node:fs'
			symlinkSync('${dir}/original.txt', '${dir}/link.txt')
			const content = readFileSync('${dir}/link.txt', 'utf8')
			const isSymlink = lstatSync('${dir}/link.txt').isSymbolicLink()
			console.log(JSON.stringify({ content, isSymlink }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'original content', isSymlink: true })
	})

	test('rmSync removes file', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'delete me')
		writeFileSync(`${dir}/test.js`, `
			import { rmSync, existsSync } from 'node:fs'
			rmSync('${dir}/file.txt')
			console.log(JSON.stringify({ exists: existsSync('${dir}/file.txt') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { exists: false })
	})

	test('rmSync recursive removes directory tree', ({ bin, dir }) => {
		mkdirSync(`${dir}/tree/nested`, { recursive: true })
		writeFileSync(`${dir}/tree/file1.txt`, 'file1')
		writeFileSync(`${dir}/tree/nested/file2.txt`, 'file2')
		writeFileSync(`${dir}/test.js`, `
			import { rmSync, existsSync } from 'node:fs'
			rmSync('${dir}/tree', { recursive: true })
			console.log(JSON.stringify({ exists: existsSync('${dir}/tree') }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { exists: false })
	})

	test('rmSync with force on non-existent file', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { rmSync, existsSync } from 'node:fs'
			let threw = false
			try {
				rmSync('${dir}/nonexistent.txt', { force: true })
			} catch {
				threw = true
			}
			console.log(JSON.stringify({ threw }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: false })
	})

	test('renameSync moves file', ({ bin, dir }) => {
		writeFileSync(`${dir}/original.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { renameSync, existsSync, readFileSync } from 'node:fs'
			renameSync('${dir}/original.txt', '${dir}/renamed.txt')
			console.log(JSON.stringify({
				oldExists: existsSync('${dir}/original.txt'),
				newExists: existsSync('${dir}/renamed.txt'),
				content: readFileSync('${dir}/renamed.txt', 'utf8')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			oldExists: false,
			newExists: true,
			content: 'content'
		})
	})

	test('realpathSync resolves path', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { realpathSync } from 'node:fs'
			const resolved = realpathSync('${dir}/./file.txt')
			console.log(JSON.stringify({ resolved }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.resolved, `${dir}/file.txt`)
	})

	test('readlinkSync reads symlink target', ({ bin, dir }) => {
		writeFileSync(`${dir}/target.txt`, 'target content')
		writeFileSync(`${dir}/test.js`, `
			import { symlinkSync, readlinkSync } from 'node:fs'
			symlinkSync('${dir}/target.txt', '${dir}/link.txt')
			const target = readlinkSync('${dir}/link.txt')
			console.log(JSON.stringify({ target }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { target: `${dir}/target.txt` })
	})
})

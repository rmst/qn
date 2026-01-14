import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { platform } from 'node:os'
import { test, $ } from './util.js'

const QJSX_NODE = resolve(`./bin/${platform()}/qjsx-node`)

describe('node:fs shim', () => {
	test('writeFileSync and readFileSync', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			writeFileSync('${dir}/out.txt', 'hello world')
			console.log(JSON.stringify({ content: readFileSync('${dir}/out.txt', 'utf8') }))
		`)

		const output = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'hello world' })
	})

	test('readFileSync with utf-8 encoding variant', ({ dir }) => {
		writeFileSync(`${dir}/data.txt`, 'utf-8 test content')
		writeFileSync(`${dir}/test.js`, `
			import { readFileSync } from 'node:fs'
			console.log(JSON.stringify({ content: readFileSync('${dir}/data.txt', 'utf-8') }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('readFileSync with options object', ({ dir }) => {
		writeFileSync(`${dir}/data.txt`, 'options object test')
		writeFileSync(`${dir}/test.js`, `
			import { readFileSync } from 'node:fs'
			console.log(JSON.stringify({ content: readFileSync('${dir}/data.txt', { encoding: 'utf8' }) }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('writeFileSync with empty string', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			writeFileSync('${dir}/empty.txt', '')
			console.log(JSON.stringify({ content: readFileSync('${dir}/empty.txt', 'utf8') }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('writeFileSync with unicode content', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			writeFileSync('${dir}/unicode.txt', '日本語 émojis 🎉 中文')
			console.log(JSON.stringify({ content: readFileSync('${dir}/unicode.txt', 'utf8') }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('writeFileSync with multiline content', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			writeFileSync('${dir}/multi.txt', 'line1\\nline2\\nline3')
			console.log(JSON.stringify({ content: readFileSync('${dir}/multi.txt', 'utf8') }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('existsSync matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/exists.txt`, 'test')
		writeFileSync(`${dir}/test.js`, `
			import { existsSync } from 'node:fs'
			console.log(JSON.stringify({
				exists: existsSync('${dir}/exists.txt'),
				missing: existsSync('${dir}/missing.txt')
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('existsSync with directories', ({ dir }) => {
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { existsSync } from 'node:fs'
			console.log(JSON.stringify({
				dirExists: existsSync('${dir}/subdir'),
				missingDir: existsSync('${dir}/nonexistent')
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('statSync.isFile matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/file.txt`, 'test')
		writeFileSync(`${dir}/test.js`, `
			import { statSync } from 'node:fs'
			const stats = statSync('${dir}/file.txt')
			console.log(JSON.stringify({
				isFile: stats.isFile(),
				isDirectory: stats.isDirectory()
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('statSync.isDirectory matches Node.js', ({ dir }) => {
		mkdirSync(`${dir}/mydir`)
		writeFileSync(`${dir}/test.js`, `
			import { statSync } from 'node:fs'
			const stats = statSync('${dir}/mydir')
			console.log(JSON.stringify({
				isFile: stats.isFile(),
				isDirectory: stats.isDirectory()
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('statSync size property matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/sized.txt`, 'exactly 20 chars!!!')
		writeFileSync(`${dir}/test.js`, `
			import { statSync } from 'node:fs'
			const stats = statSync('${dir}/sized.txt')
			console.log(JSON.stringify({ size: stats.size }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('lstatSync on regular file matches statSync', ({ dir }) => {
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

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('readdirSync returns files without . and ..', ({ dir }) => {
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

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('readdirSync empty directory', ({ dir }) => {
		mkdirSync(`${dir}/empty`)
		writeFileSync(`${dir}/test.js`, `
			import { readdirSync } from 'node:fs'
			const files = readdirSync('${dir}/empty')
			console.log(JSON.stringify({ count: files.length, files }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('mkdirSync creates directory', ({ dir }) => {
		// Use different paths for Node and qjsx to avoid state conflicts
		writeFileSync(`${dir}/test_node.js`, `
			import { mkdirSync, existsSync, statSync } from 'node:fs'
			mkdirSync('${dir}/newdir_node')
			const exists = existsSync('${dir}/newdir_node')
			const isDir = statSync('${dir}/newdir_node').isDirectory()
			console.log(JSON.stringify({ exists, isDir }))
		`)
		writeFileSync(`${dir}/test_qjsx.js`, `
			import { mkdirSync, existsSync, statSync } from 'node:fs'
			mkdirSync('${dir}/newdir_qjsx')
			const exists = existsSync('${dir}/newdir_qjsx')
			const isDir = statSync('${dir}/newdir_qjsx').isDirectory()
			console.log(JSON.stringify({ exists, isDir }))
		`)

		const nodeOutput = $`node ${dir}/test_node.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test_qjsx.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('mkdirSync recursive creates nested directories', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { mkdirSync, existsSync } from 'node:fs'
			mkdirSync('${dir}/a/b/c', { recursive: true })
			console.log(JSON.stringify({
				aExists: existsSync('${dir}/a'),
				bExists: existsSync('${dir}/a/b'),
				cExists: existsSync('${dir}/a/b/c')
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('mkdirSync recursive with existing parent', ({ dir }) => {
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

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('unlinkSync removes file', ({ dir }) => {
		// Use different files for Node and qjsx to avoid state conflicts
		writeFileSync(`${dir}/toremove_node.txt`, 'remove me')
		writeFileSync(`${dir}/toremove_qjsx.txt`, 'remove me')
		writeFileSync(`${dir}/test_node.js`, `
			import { unlinkSync, existsSync } from 'node:fs'
			const beforeExists = existsSync('${dir}/toremove_node.txt')
			unlinkSync('${dir}/toremove_node.txt')
			const afterExists = existsSync('${dir}/toremove_node.txt')
			console.log(JSON.stringify({ beforeExists, afterExists }))
		`)
		writeFileSync(`${dir}/test_qjsx.js`, `
			import { unlinkSync, existsSync } from 'node:fs'
			const beforeExists = existsSync('${dir}/toremove_qjsx.txt')
			unlinkSync('${dir}/toremove_qjsx.txt')
			const afterExists = existsSync('${dir}/toremove_qjsx.txt')
			console.log(JSON.stringify({ beforeExists, afterExists }))
		`)

		const nodeOutput = $`node ${dir}/test_node.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test_qjsx.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('symlinkSync creates symlink', ({ dir }) => {
		// Use different symlink targets for Node and qjsx to avoid state conflicts
		writeFileSync(`${dir}/original.txt`, 'original content')
		writeFileSync(`${dir}/test_node.js`, `
			import { symlinkSync, readFileSync, lstatSync } from 'node:fs'
			symlinkSync('${dir}/original.txt', '${dir}/link_node.txt')
			const content = readFileSync('${dir}/link_node.txt', 'utf8')
			const isSymlink = lstatSync('${dir}/link_node.txt').isSymbolicLink()
			console.log(JSON.stringify({ content, isSymlink }))
		`)
		writeFileSync(`${dir}/test_qjsx.js`, `
			import { symlinkSync, readFileSync, lstatSync } from 'node:fs'
			symlinkSync('${dir}/original.txt', '${dir}/link_qjsx.txt')
			const content = readFileSync('${dir}/link_qjsx.txt', 'utf8')
			const isSymlink = lstatSync('${dir}/link_qjsx.txt').isSymbolicLink()
			console.log(JSON.stringify({ content, isSymlink }))
		`)

		const nodeOutput = $`node ${dir}/test_node.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test_qjsx.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('rmSync removes file', ({ dir }) => {
		// Use different files for Node and qjsx to avoid state conflicts
		writeFileSync(`${dir}/file_node.txt`, 'delete me')
		writeFileSync(`${dir}/file_qjsx.txt`, 'delete me')
		writeFileSync(`${dir}/test_node.js`, `
			import { rmSync, existsSync } from 'node:fs'
			rmSync('${dir}/file_node.txt')
			console.log(JSON.stringify({ exists: existsSync('${dir}/file_node.txt') }))
		`)
		writeFileSync(`${dir}/test_qjsx.js`, `
			import { rmSync, existsSync } from 'node:fs'
			rmSync('${dir}/file_qjsx.txt')
			console.log(JSON.stringify({ exists: existsSync('${dir}/file_qjsx.txt') }))
		`)

		const nodeOutput = $`node ${dir}/test_node.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test_qjsx.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('rmSync recursive removes directory tree', ({ dir }) => {
		// Use different directories for Node and qjsx to avoid state conflicts
		mkdirSync(`${dir}/tree_node/nested`, { recursive: true })
		mkdirSync(`${dir}/tree_qjsx/nested`, { recursive: true })
		writeFileSync(`${dir}/tree_node/file1.txt`, 'file1')
		writeFileSync(`${dir}/tree_node/nested/file2.txt`, 'file2')
		writeFileSync(`${dir}/tree_qjsx/file1.txt`, 'file1')
		writeFileSync(`${dir}/tree_qjsx/nested/file2.txt`, 'file2')
		writeFileSync(`${dir}/test_node.js`, `
			import { rmSync, existsSync } from 'node:fs'
			rmSync('${dir}/tree_node', { recursive: true })
			console.log(JSON.stringify({ exists: existsSync('${dir}/tree_node') }))
		`)
		writeFileSync(`${dir}/test_qjsx.js`, `
			import { rmSync, existsSync } from 'node:fs'
			rmSync('${dir}/tree_qjsx', { recursive: true })
			console.log(JSON.stringify({ exists: existsSync('${dir}/tree_qjsx') }))
		`)

		const nodeOutput = $`node ${dir}/test_node.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test_qjsx.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('rmSync with force on non-existent file', ({ dir }) => {
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

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})
})

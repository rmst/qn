import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { platform } from 'node:os'
import { test, $ } from './util.js'

const QJSX_NODE = resolve(`./bin/${platform()}/qjsx-node`)

describe('node:path shim', () => {
	test('path.sep and path.delimiter match Node.js', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({ sep: path.sep, delimiter: path.delimiter }))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('path.join matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({
				simple: path.join('foo', 'bar', 'baz'),
				withSlashes: path.join('/foo', 'bar', 'baz'),
				withDots: path.join('foo', '.', 'bar', '..', 'baz'),
				empty: path.join(),
				emptyStrings: path.join('', '', '')
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('path.dirname matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({
				simple: path.dirname('/foo/bar/baz.txt'),
				root: path.dirname('/foo'),
				noDir: path.dirname('foo.txt'),
				empty: path.dirname(''),
				trailingSlash: path.dirname('/foo/bar/')
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('path.basename matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({
				simple: path.basename('/foo/bar/baz.txt'),
				withSuffix: path.basename('/foo/bar/baz.txt', '.txt'),
				noMatch: path.basename('/foo/bar/baz.txt', '.js'),
				trailingSlash: path.basename('/foo/bar/'),
				justFile: path.basename('file.txt')
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('path.extname matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({
				simple: path.extname('file.txt'),
				multiple: path.extname('file.name.txt'),
				hidden: path.extname('.hidden'),
				hiddenExt: path.extname('.hidden.txt'),
				noExt: path.extname('file'),
				dotEnd: path.extname('file.'),
				path: path.extname('/foo/bar/file.txt')
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('path.isAbsolute matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({
				absolute: path.isAbsolute('/foo/bar'),
				relative: path.isAbsolute('foo/bar'),
				dot: path.isAbsolute('./foo'),
				dotdot: path.isAbsolute('../foo'),
				empty: path.isAbsolute('')
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('path.normalize matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({
				dots: path.normalize('/foo/bar/../baz/./qux'),
				doubleSlash: path.normalize('/foo//bar///baz'),
				trailing: path.normalize('/foo/bar/'),
				empty: path.normalize(''),
				dotOnly: path.normalize('.'),
				current: path.normalize('./foo/./bar')
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('path.resolve with absolute paths matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({
				single: path.resolve('/foo/bar'),
				multiple: path.resolve('/foo', 'bar', 'baz'),
				override: path.resolve('/foo', '/bar'),
				withDots: path.resolve('/foo/bar', '../baz')
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('path.relative matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({
				same: path.relative('/foo/bar', '/foo/bar'),
				down: path.relative('/foo', '/foo/bar/baz'),
				up: path.relative('/foo/bar/baz', '/foo'),
				sibling: path.relative('/foo/bar', '/foo/baz'),
				differentRoot: path.relative('/foo', '/bar')
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('path.parse matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({
				full: path.parse('/home/user/file.txt'),
				noExt: path.parse('/home/user/file'),
				hidden: path.parse('/home/user/.hidden'),
				root: path.parse('/'),
				relative: path.parse('file.txt')
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('path.format matches Node.js', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({
				full: path.format({ dir: '/home/user', base: 'file.txt' }),
				rootOnly: path.format({ root: '/', base: 'file.txt' }),
				nameExt: path.format({ name: 'file', ext: '.txt' }),
				dirRoot: path.format({ root: '/', dir: '/home/user', base: 'file.txt' })
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('path.posix exists and matches default', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({
				hasPosix: typeof path.posix === 'object',
				posixSep: path.posix.sep,
				posixJoin: path.posix.join('foo', 'bar')
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('named imports work', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { join, dirname, basename, extname, resolve, normalize, isAbsolute, parse, format, relative, sep, delimiter } from 'node:path'
			console.log(JSON.stringify({
				join: join('foo', 'bar'),
				dirname: dirname('/foo/bar'),
				basename: basename('/foo/bar'),
				extname: extname('file.txt'),
				isAbsolute: isAbsolute('/foo'),
				normalize: normalize('/foo/../bar'),
				sep,
				delimiter
			}))
		`)

		const nodeOutput = $`node ${dir}/test.js`
		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(qjsxOutput), JSON.parse(nodeOutput))
	})

	test('path throws TypeError for non-string inputs', ({ dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			const errors = []
			try { path.join(123) } catch (e) { errors.push(e.name) }
			try { path.dirname(null) } catch (e) { errors.push(e.name) }
			try { path.basename(undefined) } catch (e) { errors.push(e.name) }
			try { path.normalize({}) } catch (e) { errors.push(e.name) }
			console.log(JSON.stringify({ errors }))
		`)

		const qjsxOutput = $`${QJSX_NODE} ${dir}/test.js`
		const result = JSON.parse(qjsxOutput)
		assert.strictEqual(result.errors.length, 4)
		assert.ok(result.errors.every(e => e === 'TypeError'))
	})
})

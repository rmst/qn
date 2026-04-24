import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, $ } from './util.js'

describe('node:path shim', () => {
	test('path.sep and path.delimiter match Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({ sep: path.sep, delimiter: path.delimiter }))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { sep: '/', delimiter: ':' })
	})

	test('path.join matches Node.js', ({ bin, dir }) => {
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

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			simple: 'foo/bar/baz',
			withSlashes: '/foo/bar/baz',
			withDots: 'foo/baz',
			empty: '.',
			emptyStrings: '.'
		})
	})

	test('path.dirname matches Node.js', ({ bin, dir }) => {
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

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			simple: '/foo/bar',
			root: '/',
			noDir: '.',
			empty: '.',
			trailingSlash: '/foo'
		})
	})

	test('path.basename matches Node.js', ({ bin, dir }) => {
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

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			simple: 'baz.txt',
			withSuffix: 'baz',
			noMatch: 'baz.txt',
			trailingSlash: 'bar',
			justFile: 'file.txt'
		})
	})

	test('path.extname matches Node.js', ({ bin, dir }) => {
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

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			simple: '.txt',
			multiple: '.txt',
			hidden: '',
			hiddenExt: '.txt',
			noExt: '',
			dotEnd: '.',
			path: '.txt'
		})
	})

	test('path.isAbsolute matches Node.js', ({ bin, dir }) => {
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

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			absolute: true,
			relative: false,
			dot: false,
			dotdot: false,
			empty: false
		})
	})

	test('path.normalize matches Node.js', ({ bin, dir }) => {
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

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			dots: '/foo/baz/qux',
			doubleSlash: '/foo/bar/baz',
			trailing: '/foo/bar/',
			empty: '.',
			dotOnly: '.',
			current: 'foo/bar'
		})
	})

	test('path.resolve with absolute paths matches Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({
				single: path.resolve('/foo/bar'),
				multiple: path.resolve('/foo', 'bar', 'baz'),
				override: path.resolve('/foo', '/bar'),
				withDots: path.resolve('/foo/bar', '../baz')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			single: '/foo/bar',
			multiple: '/foo/bar/baz',
			override: '/bar',
			withDots: '/foo/baz'
		})
	})

	test('path.relative matches Node.js', ({ bin, dir }) => {
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

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			same: '',
			down: 'bar/baz',
			up: '../..',
			sibling: '../baz',
			differentRoot: '../bar'
		})
	})

	test('path.parse matches Node.js', ({ bin, dir }) => {
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

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			full: { root: '/', dir: '/home/user', base: 'file.txt', ext: '.txt', name: 'file' },
			noExt: { root: '/', dir: '/home/user', base: 'file', ext: '', name: 'file' },
			hidden: { root: '/', dir: '/home/user', base: '.hidden', ext: '', name: '.hidden' },
			root: { root: '/', dir: '/', base: '', ext: '', name: '' },
			relative: { root: '', dir: '', base: 'file.txt', ext: '.txt', name: 'file' }
		})
	})

	test('path.format matches Node.js', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({
				full: path.format({ dir: '/home/user', base: 'file.txt' }),
				rootOnly: path.format({ root: '/', base: 'file.txt' }),
				nameExt: path.format({ name: 'file', ext: '.txt' }),
				dirRoot: path.format({ root: '/', dir: '/home/user', base: 'file.txt' })
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			full: '/home/user/file.txt',
			rootOnly: '/file.txt',
			nameExt: 'file.txt',
			dirRoot: '/home/user/file.txt'
		})
	})

	test('path.posix exists and matches default', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			console.log(JSON.stringify({
				hasPosix: typeof path.posix === 'object',
				posixSep: path.posix.sep,
				posixJoin: path.posix.join('foo', 'bar')
			}))
		`)

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hasPosix: true,
			posixSep: '/',
			posixJoin: 'foo/bar'
		})
	})

	test('named imports work', ({ bin, dir }) => {
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

		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			join: 'foo/bar',
			dirname: '/foo',
			basename: 'bar',
			extname: '.txt',
			isAbsolute: true,
			normalize: '/bar',
			sep: '/',
			delimiter: ':'
		})
	})

	test('path throws TypeError for non-string inputs', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import path from 'node:path'
			const errors = []
			try { path.join(123) } catch (e) { errors.push(e.name) }
			try { path.dirname(null) } catch (e) { errors.push(e.name) }
			try { path.basename(undefined) } catch (e) { errors.push(e.name) }
			try { path.normalize({}) } catch (e) { errors.push(e.name) }
			console.log(JSON.stringify({ errors }))
		`)

		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.errors.length, 4)
		assert.ok(result.errors.every(e => e === 'TypeError'))
	})
})

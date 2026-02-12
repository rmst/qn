import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { test, testQnOnly, $ } from './util.js'

describe('node:fs extended APIs', () => {
	test('accessSync with existing file does not throw', ({ bin, dir }) => {
		writeFileSync(`${dir}/exists.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { accessSync, constants } from 'node:fs'
			let threw = false
			try { accessSync('${dir}/exists.txt') } catch { threw = true }
			console.log(JSON.stringify({ threw }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: false })
	})

	test('accessSync with missing file throws ENOENT', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { accessSync } from 'node:fs'
			let code = null
			try { accessSync('${dir}/missing.txt') } catch (e) { code = e.code }
			console.log(JSON.stringify({ code }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { code: 'ENOENT' })
	})

	test('constants has expected values', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { constants } from 'node:fs'
			console.log(JSON.stringify({
				F_OK: constants.F_OK,
				R_OK: constants.R_OK,
				W_OK: constants.W_OK,
				X_OK: constants.X_OK,
				COPYFILE_FICLONE: constants.COPYFILE_FICLONE,
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_FICLONE: 2,
		})
	})

	test('utimesSync changes file timestamps', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { utimesSync, statSync } from 'node:fs'
			const atime = new Date('2020-01-01T00:00:00Z')
			const mtime = new Date('2021-06-15T12:00:00Z')
			utimesSync('${dir}/file.txt', atime, mtime)
			const stats = statSync('${dir}/file.txt')
			// Check within 1 second tolerance (some FS have second resolution)
			const atimeDiff = Math.abs(stats.atimeMs - atime.getTime())
			const mtimeDiff = Math.abs(stats.mtimeMs - mtime.getTime())
			console.log(JSON.stringify({
				atimeOk: atimeDiff < 1000,
				mtimeOk: mtimeDiff < 1000,
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { atimeOk: true, mtimeOk: true })
	})

	testQnOnly('chownSync changes file ownership (when running as root)', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { chownSync, statSync } from 'node:fs'
			import process from 'node:process'
			const isRoot = process.getuid() === 0
			if (!isRoot) {
				console.log(JSON.stringify({ skipped: true }))
			} else {
				chownSync('${dir}/file.txt', 0, 0)
				const stats = statSync('${dir}/file.txt')
				console.log(JSON.stringify({ uid: stats.uid, gid: stats.gid, skipped: false }))
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		if (!result.skipped) {
			assert.strictEqual(result.uid, 0)
			assert.strictEqual(result.gid, 0)
		}
	})

	testQnOnly('createReadStream reads file content', ({ bin, dir }) => {
		writeFileSync(`${dir}/data.txt`, 'hello from createReadStream')
		writeFileSync(`${dir}/test.js`, `
			import { createReadStream } from 'node:fs'
			const rs = createReadStream('${dir}/data.txt')
			let data = ''
			rs.on('data', (chunk) => { data += chunk.toString() })
			rs.on('end', () => {
				console.log(JSON.stringify({ data }))
			})
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { data: 'hello from createReadStream' })
	})

	testQnOnly('createReadStream with start/end options', ({ bin, dir }) => {
		writeFileSync(`${dir}/data.txt`, '0123456789')
		writeFileSync(`${dir}/test.js`, `
			import { createReadStream } from 'node:fs'
			const rs = createReadStream('${dir}/data.txt', { start: 3, end: 6 })
			let data = ''
			rs.on('data', (chunk) => { data += chunk.toString() })
			rs.on('end', () => {
				console.log(JSON.stringify({ data }))
			})
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { data: '3456' })
	})

	testQnOnly('createWriteStream writes file content', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createWriteStream, readFileSync } from 'node:fs'
			const ws = createWriteStream('${dir}/output.txt')
			ws.write('hello ')
			ws.write('world')
			ws.end()
			ws.on('finish', () => {
				const content = readFileSync('${dir}/output.txt', 'utf8')
				console.log(JSON.stringify({ content }))
			})
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'hello world' })
	})

	testQnOnly('createWriteStream emits open and close events', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { createWriteStream } from 'node:fs'
			const events = []
			const ws = createWriteStream('${dir}/out.txt')
			ws.on('open', () => events.push('open'))
			ws.on('finish', () => events.push('finish'))
			ws.on('close', () => {
				events.push('close')
				console.log(JSON.stringify({ events }))
			})
			ws.end('data')
		`)
		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.ok(result.events.includes('open'))
		assert.ok(result.events.includes('finish'))
		assert.ok(result.events.includes('close'))
	})
})

describe('node:fs/promises', () => {
	testQnOnly('readFile reads file content', ({ bin, dir }) => {
		writeFileSync(`${dir}/data.txt`, 'async content')
		writeFileSync(`${dir}/test.js`, `
			import { readFile } from 'node:fs/promises'
			const content = await readFile('${dir}/data.txt', 'utf8')
			console.log(JSON.stringify({ content }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'async content' })
	})

	testQnOnly('writeFile writes file content', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { writeFile, readFile } from 'node:fs/promises'
			await writeFile('${dir}/out.txt', 'written async')
			const content = await readFile('${dir}/out.txt', 'utf8')
			console.log(JSON.stringify({ content }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'written async' })
	})

	testQnOnly('stat returns stats object', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'test')
		writeFileSync(`${dir}/test.js`, `
			import { stat } from 'node:fs/promises'
			const s = await stat('${dir}/file.txt')
			console.log(JSON.stringify({ isFile: s.isFile(), isDir: s.isDirectory() }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isFile: true, isDir: false })
	})

	testQnOnly('mkdir creates directory', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { mkdir, stat } from 'node:fs/promises'
			await mkdir('${dir}/newdir')
			const s = await stat('${dir}/newdir')
			console.log(JSON.stringify({ isDir: s.isDirectory() }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isDir: true })
	})

	testQnOnly('readdir lists directory', ({ bin, dir }) => {
		writeFileSync(`${dir}/a.txt`, 'a')
		writeFileSync(`${dir}/b.txt`, 'b')
		writeFileSync(`${dir}/test.js`, `
			import { readdir } from 'node:fs/promises'
			const files = await readdir('${dir}')
			console.log(JSON.stringify({ hasA: files.includes('a.txt'), hasB: files.includes('b.txt') }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { hasA: true, hasB: true })
	})

	testQnOnly('readdir with withFileTypes', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'content')
		mkdirSync(`${dir}/subdir`)
		writeFileSync(`${dir}/test.js`, `
			import { readdir } from 'node:fs/promises'
			const entries = await readdir('${dir}', { withFileTypes: true })
			const file = entries.find(e => e.name === 'file.txt')
			const sub = entries.find(e => e.name === 'subdir')
			console.log(JSON.stringify({
				fileIsFile: file.isFile(),
				subdirIsDir: sub.isDirectory(),
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { fileIsFile: true, subdirIsDir: true })
	})

	testQnOnly('access checks file existence', ({ bin, dir }) => {
		writeFileSync(`${dir}/exists.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { access } from 'node:fs/promises'
			let existsOk = false
			let missingCode = null
			try { await access('${dir}/exists.txt'); existsOk = true } catch {}
			try { await access('${dir}/missing.txt') } catch (e) { missingCode = e.code }
			console.log(JSON.stringify({ existsOk, missingCode }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { existsOk: true, missingCode: 'ENOENT' })
	})

	testQnOnly('rename moves file', ({ bin, dir }) => {
		writeFileSync(`${dir}/old.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { rename, readFile } from 'node:fs/promises'
			import { existsSync } from 'node:fs'
			await rename('${dir}/old.txt', '${dir}/new.txt')
			const content = await readFile('${dir}/new.txt', 'utf8')
			console.log(JSON.stringify({ content, oldGone: !existsSync('${dir}/old.txt') }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'content', oldGone: true })
	})

	testQnOnly('rm removes file', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { rm } from 'node:fs/promises'
			import { existsSync } from 'node:fs'
			await rm('${dir}/file.txt')
			console.log(JSON.stringify({ gone: !existsSync('${dir}/file.txt') }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { gone: true })
	})

	testQnOnly('symlink and readlink', ({ bin, dir }) => {
		writeFileSync(`${dir}/target.txt`, 'target content')
		writeFileSync(`${dir}/test.js`, `
			import { symlink, readlink, readFile } from 'node:fs/promises'
			await symlink('${dir}/target.txt', '${dir}/link.txt')
			const target = await readlink('${dir}/link.txt')
			const content = await readFile('${dir}/link.txt', 'utf8')
			console.log(JSON.stringify({ target, content }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { target: `${dir}/target.txt`, content: 'target content' })
	})

	testQnOnly('chmod changes permissions', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { chmod, stat } from 'node:fs/promises'
			await chmod('${dir}/file.txt', 0o755)
			const s = await stat('${dir}/file.txt')
			console.log(JSON.stringify({ mode: (s.mode & 0o777).toString(8) }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { mode: '755' })
	})

	testQnOnly('realpath resolves path', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { realpath } from 'node:fs/promises'
			const resolved = await realpath('${dir}/./file.txt')
			console.log(JSON.stringify({ resolved }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { resolved: `${dir}/file.txt` })
	})

	testQnOnly('lstat on symlink returns symlink stats', ({ bin, dir }) => {
		writeFileSync(`${dir}/target.txt`, 'content')
		symlinkSync(`${dir}/target.txt`, `${dir}/link.txt`)
		writeFileSync(`${dir}/test.js`, `
			import { lstat } from 'node:fs/promises'
			const s = await lstat('${dir}/link.txt')
			console.log(JSON.stringify({ isSymlink: s.isSymbolicLink() }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isSymlink: true })
	})

	testQnOnly('cp copies file', ({ bin, dir }) => {
		writeFileSync(`${dir}/src.txt`, 'source content')
		writeFileSync(`${dir}/test.js`, `
			import { cp, readFile } from 'node:fs/promises'
			await cp('${dir}/src.txt', '${dir}/dst.txt')
			const content = await readFile('${dir}/dst.txt', 'utf8')
			console.log(JSON.stringify({ content }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'source content' })
	})

	testQnOnly('utimes changes timestamps', ({ bin, dir }) => {
		writeFileSync(`${dir}/file.txt`, 'content')
		writeFileSync(`${dir}/test.js`, `
			import { utimes, stat } from 'node:fs/promises'
			const t = new Date('2020-06-15T00:00:00Z')
			await utimes('${dir}/file.txt', t, t)
			const s = await stat('${dir}/file.txt')
			const diff = Math.abs(s.mtimeMs - t.getTime())
			console.log(JSON.stringify({ ok: diff < 1000 }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { ok: true })
	})
})

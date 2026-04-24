import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { test, testQnOnly, $ } from './util.js'

/**
 * fs.watch tests. These run in a subprocess via $`${bin} ...` so the watcher
 * has its own event loop and we can observe its stdout. Each subprocess times
 * out deterministically via a closing setTimeout inside the script.
 */

const MS = 150   // time between actions
const CLOSE_MS = 500  // time from start to close

describe('node:fs fs.watch', () => {
	test('watches a file for changes', ({ bin, dir }) => {
		writeFileSync(`${dir}/target.txt`, 'v1')
		writeFileSync(`${dir}/run.js`, `
			import { watch, writeFileSync } from 'node:fs'
			const events = []
			const w = watch('${dir}/target.txt', (type, name) => events.push(type))
			setTimeout(() => writeFileSync('${dir}/target.txt', 'v2'), ${MS})
			setTimeout(() => writeFileSync('${dir}/target.txt', 'v3'), ${MS * 2})
			setTimeout(() => { w.close(); console.log(JSON.stringify({ count: events.length, first: events[0] })) }, ${CLOSE_MS})
		`)
		const out = JSON.parse($`${bin} ${dir}/run.js`)
		assert.ok(out.count >= 1, `expected ≥1 event, got ${out.count}`)
		assert.ok(['change', 'rename'].includes(out.first), `unexpected eventType: ${out.first}`)
	})

	test('watches a directory and reports filenames', ({ bin, dir }) => {
		mkdirSync(`${dir}/watched`)
		writeFileSync(`${dir}/run.js`, `
			import { watch, writeFileSync } from 'node:fs'
			const names = new Set()
			const w = watch('${dir}/watched', (type, name) => { if (name) names.add(name) })
			setTimeout(() => writeFileSync('${dir}/watched/a.txt', 'a'), ${MS})
			setTimeout(() => writeFileSync('${dir}/watched/b.txt', 'b'), ${MS * 2})
			setTimeout(() => { w.close(); console.log(JSON.stringify([...names].sort())) }, ${CLOSE_MS})
		`)
		const names = JSON.parse($`${bin} ${dir}/run.js`)
		assert.ok(names.includes('a.txt'), `missing a.txt in ${JSON.stringify(names)}`)
		assert.ok(names.includes('b.txt'), `missing b.txt in ${JSON.stringify(names)}`)
	})

	test('listener shortcut receives (eventType, filename)', ({ bin, dir }) => {
		mkdirSync(`${dir}/watched`)
		writeFileSync(`${dir}/run.js`, `
			import { watch, writeFileSync } from 'node:fs'
			let seen = null
			const w = watch('${dir}/watched', (type, name) => { if (!seen) seen = [typeof type, typeof name || typeof name] })
			setTimeout(() => writeFileSync('${dir}/watched/a.txt', 'a'), ${MS})
			setTimeout(() => { w.close(); console.log(JSON.stringify(seen)) }, ${CLOSE_MS})
		`)
		const seen = JSON.parse($`${bin} ${dir}/run.js`)
		assert.strictEqual(seen[0], 'string')
		assert.ok(seen[1] === 'string' || seen[1] === 'object', `filename type: ${seen[1]}`)
	})

	test('close() stops emitting events and fires close event', ({ bin, dir }) => {
		mkdirSync(`${dir}/watched`)
		writeFileSync(`${dir}/run.js`, `
			import { watch, writeFileSync } from 'node:fs'
			let afterClose = 0
			let closeFired = false
			const w = watch('${dir}/watched', () => { if (closeFired) afterClose++ })
			w.on('close', () => { closeFired = true })
			setTimeout(() => w.close(), ${MS})
			setTimeout(() => writeFileSync('${dir}/watched/a.txt', 'a'), ${MS * 2})
			setTimeout(() => console.log(JSON.stringify({ closeFired, afterClose })), ${CLOSE_MS})
		`)
		const out = JSON.parse($`${bin} ${dir}/run.js`)
		assert.strictEqual(out.closeFired, true)
		assert.strictEqual(out.afterClose, 0, 'no events should be delivered after close()')
	})

	test('AbortSignal stops the watcher', ({ bin, dir }) => {
		mkdirSync(`${dir}/watched`)
		writeFileSync(`${dir}/run.js`, `
			import { watch, writeFileSync } from 'node:fs'
			const ac = new AbortController()
			let afterAbort = 0
			let closeFired = false
			const w = watch('${dir}/watched', { signal: ac.signal }, () => { if (closeFired) afterAbort++ })
			w.on('close', () => { closeFired = true })
			setTimeout(() => ac.abort(), ${MS})
			setTimeout(() => writeFileSync('${dir}/watched/a.txt', 'a'), ${MS * 2})
			setTimeout(() => console.log(JSON.stringify({ closeFired, afterAbort })), ${CLOSE_MS})
		`)
		const out = JSON.parse($`${bin} ${dir}/run.js`)
		assert.strictEqual(out.closeFired, true)
		assert.strictEqual(out.afterAbort, 0)
	})

	test('ENOENT on non-existent path throws synchronously', ({ bin, dir }) => {
		writeFileSync(`${dir}/run.js`, `
			import { watch } from 'node:fs'
			let code = null
			try { watch('${dir}/does-not-exist', () => {}) } catch (e) { code = e.code }
			console.log(JSON.stringify({ code }))
		`)
		const out = JSON.parse($`${bin} ${dir}/run.js`)
		assert.strictEqual(out.code, 'ENOENT')
	})

	test('buffer encoding returns Buffer filenames', ({ bin, dir }) => {
		mkdirSync(`${dir}/watched`)
		writeFileSync(`${dir}/run.js`, `
			import { watch, writeFileSync } from 'node:fs'
			let kind = null
			const w = watch('${dir}/watched', { encoding: 'buffer' }, (type, name) => {
				if (!kind && name != null) kind = Buffer.isBuffer(name) ? 'buffer' : typeof name
			})
			setTimeout(() => writeFileSync('${dir}/watched/z.txt', 'z'), ${MS})
			setTimeout(() => { w.close(); console.log(JSON.stringify({ kind })) }, ${CLOSE_MS})
		`)
		const out = JSON.parse($`${bin} ${dir}/run.js`)
		assert.strictEqual(out.kind, 'buffer')
	})

	test('recursive: true reports events from subdirectories', ({ bin, dir }) => {
		mkdirSync(`${dir}/root/sub/deep`, { recursive: true })
		writeFileSync(`${dir}/run.js`, `
			import { watch, writeFileSync } from 'node:fs'
			const names = new Set()
			const w = watch('${dir}/root', { recursive: true }, (type, name) => { if (name) names.add(name) })
			setTimeout(() => writeFileSync('${dir}/root/sub/deep/a.txt', 'a'), ${MS})
			setTimeout(() => { w.close(); console.log(JSON.stringify([...names])) }, ${CLOSE_MS})
		`)
		const names = JSON.parse($`${bin} ${dir}/run.js`)
		/* Filename normalization differs between OS backends (macOS FSEvents
		 * emits full relative path; inotify-emulation emits it too). We just
		 * check that some path mentioning the deep file surfaced. */
		const joined = names.join('|')
		assert.ok(joined.includes('a.txt'), `expected a.txt in events, got ${joined}`)
	})

	testQnOnly('recursive emulation picks up newly-created subdirectories (Linux)', async ({ bin, dir }) => {
		mkdirSync(`${dir}/root`)
		writeFileSync(`${dir}/run.js`, `
			import { watch, writeFileSync, mkdirSync } from 'node:fs'
			const names = new Set()
			const w = watch('${dir}/root', { recursive: true }, (type, name) => { if (name) names.add(name) })
			setTimeout(() => mkdirSync('${dir}/root/fresh'), ${MS})
			setTimeout(() => writeFileSync('${dir}/root/fresh/inside.txt', 'x'), ${MS * 2})
			setTimeout(() => { w.close(); console.log(JSON.stringify([...names])) }, ${CLOSE_MS + 100})
		`)
		const names = JSON.parse($`${bin} ${dir}/run.js`)
		const joined = names.join('|')
		assert.ok(joined.includes('fresh'), `expected 'fresh' directory event, got ${joined}`)
		/* The file-inside-newly-created-dir event depends on add-watcher latency.
		 * We don't strictly assert it because Node exhibits the same race. */
	})
})

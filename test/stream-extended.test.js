import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { testQnOnly, $ } from './util.js'

describe('node:stream/promises', () => {
	testQnOnly('pipeline connects readable to writable', ({ bin, dir }) => {
		writeFileSync(`${dir}/input.txt`, 'pipeline content')
		writeFileSync(`${dir}/test.js`, `
			import { pipeline } from 'node:stream/promises'
			import { createReadStream, createWriteStream, readFileSync } from 'node:fs'
			const src = createReadStream('${dir}/input.txt')
			const dst = createWriteStream('${dir}/output.txt')
			await pipeline(src, dst)
			const content = readFileSync('${dir}/output.txt', 'utf8')
			console.log(JSON.stringify({ content }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { content: 'pipeline content' })
	})

	testQnOnly('Readable.toWeb converts Node Readable to async iterable', ({ bin, dir }) => {
		writeFileSync(`${dir}/input.txt`, 'hello from toWeb')
		writeFileSync(`${dir}/test.js`, `
			import { createReadStream } from 'node:fs'
			import { Readable } from 'node:stream'
			const nodeStream = createReadStream('${dir}/input.txt')
			const webStream = Readable.toWeb(nodeStream)
			const response = new Response(webStream, { status: 200 })
			const text = await response.text()
			console.log(JSON.stringify({ text }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { text: 'hello from toWeb' })
	})

	testQnOnly('Readable.toWeb getReader works', ({ bin, dir }) => {
		writeFileSync(`${dir}/input.txt`, 'reader test data')
		writeFileSync(`${dir}/test.js`, `
			import { createReadStream } from 'node:fs'
			import { Readable } from 'node:stream'
			const nodeStream = createReadStream('${dir}/input.txt')
			const webStream = Readable.toWeb(nodeStream)
			const reader = webStream.getReader()
			let result = ''
			while (true) {
				const { value, done } = await reader.read()
				if (done) break
				result += value.toString()
			}
			console.log(JSON.stringify({ result }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { result: 'reader test data' })
	})

	testQnOnly('Readable.fromWeb converts web stream to Node Readable', ({ bin, dir }) => {
		writeFileSync(`${dir}/input.txt`, 'fromWeb test content')
		writeFileSync(`${dir}/test.js`, `
			import { createReadStream } from 'node:fs'
			import { Readable } from 'node:stream'
			// Create a web stream from a node stream first
			const nodeStream = createReadStream('${dir}/input.txt')
			const webStream = Readable.toWeb(nodeStream)
			// Now convert back to node Readable
			const backToNode = Readable.fromWeb(webStream)
			let result = ''
			backToNode.on('data', chunk => { result += chunk.toString() })
			await new Promise((resolve, reject) => {
				backToNode.on('end', resolve)
				backToNode.on('error', reject)
			})
			console.log(JSON.stringify({ result }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { result: 'fromWeb test content' })
	})
})

describe('node:sqlite setReadBigInts', () => {
	testQnOnly('setReadBigInts returns BigInt values', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE t (id INTEGER, val INTEGER)')
			db.prepare('INSERT INTO t VALUES (?, ?)').run(1, 42)
			db.prepare('INSERT INTO t VALUES (?, ?)').run(2, 9007199254740993)
			const stmt = db.prepare('SELECT * FROM t WHERE id = ?')
			stmt.setReadBigInts(true)
			const row = stmt.get(1)
			console.log(JSON.stringify({
				idType: typeof row.id,
				valType: typeof row.val,
				idValue: row.id.toString(),
				valValue: row.val.toString(),
			}))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.idType, 'bigint')
		assert.strictEqual(result.valType, 'bigint')
		assert.strictEqual(result.idValue, '1')
		assert.strictEqual(result.valValue, '42')
	})

	testQnOnly('setReadBigInts(false) returns numbers', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE t (id INTEGER, val INTEGER)')
			db.prepare('INSERT INTO t VALUES (?, ?)').run(1, 42)
			const stmt = db.prepare('SELECT * FROM t WHERE id = ?')
			stmt.setReadBigInts(true)
			stmt.setReadBigInts(false)
			const row = stmt.get(1)
			console.log(JSON.stringify({
				idType: typeof row.id,
				valType: typeof row.val,
			}))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		const result = JSON.parse(output)
		assert.strictEqual(result.idType, 'number')
		assert.strictEqual(result.valType, 'number')
	})
})

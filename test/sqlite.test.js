import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, $ } from './util.js'

describe('node:sqlite DatabaseSync', () => {
	test('opens in-memory database', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			console.log(JSON.stringify({ isOpen: db.isOpen }))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { isOpen: true })
	})

	test('exec creates table', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')
			db.exec("INSERT INTO test (name) VALUES ('hello')")
			const stmt = db.prepare('SELECT COUNT(*) as count FROM test')
			const row = stmt.get()
			console.log(JSON.stringify(row))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { count: 1 })
	})

	test('prepare and run with parameters', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)')
			const insert = db.prepare('INSERT INTO users (name, age) VALUES (?, ?)')
			const result = insert.run('Alice', 30)
			console.log(JSON.stringify({
				changes: result.changes,
				hasRowid: typeof result.lastInsertRowid === 'number'
			}))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { changes: 1, hasRowid: true })
	})

	test('get returns single row', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
			db.exec("INSERT INTO users (name) VALUES ('Alice'), ('Bob')")
			const stmt = db.prepare('SELECT * FROM users WHERE id = ?')
			const row = stmt.get(1)
			console.log(JSON.stringify(row))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { id: 1, name: 'Alice' })
	})

	test('get returns undefined for no match', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
			const stmt = db.prepare('SELECT * FROM users WHERE id = ?')
			const row = stmt.get(999)
			console.log(row === undefined ? 'undefined' : 'not undefined')
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'undefined')
	})

	test('all returns array of rows', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
			db.exec("INSERT INTO users (name) VALUES ('Alice'), ('Bob'), ('Charlie')")
			const stmt = db.prepare('SELECT * FROM users ORDER BY id')
			const rows = stmt.all()
			console.log(JSON.stringify(rows))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), [
			{ id: 1, name: 'Alice' },
			{ id: 2, name: 'Bob' },
			{ id: 3, name: 'Charlie' }
		])
	})

	test('all returns empty array for no matches', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
			const stmt = db.prepare('SELECT * FROM users')
			const rows = stmt.all()
			console.log(JSON.stringify(rows))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), [])
	})

	test('handles null values', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)')
			const insert = db.prepare('INSERT INTO test (value) VALUES (?)')
			insert.run(null)
			const stmt = db.prepare('SELECT * FROM test WHERE id = 1')
			const row = stmt.get()
			console.log(JSON.stringify(row))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { id: 1, value: null })
	})

	test('handles numeric types', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE test (i INTEGER, f REAL)')
			const insert = db.prepare('INSERT INTO test (i, f) VALUES (?, ?)')
			insert.run(42, 3.14)
			const stmt = db.prepare('SELECT * FROM test')
			const row = stmt.get()
			console.log(JSON.stringify(row))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { i: 42, f: 3.14 })
	})

	test('reuses prepared statements', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)')
			const insert = db.prepare('INSERT INTO test (value) VALUES (?)')
			insert.run('first')
			insert.run('second')
			insert.run('third')
			const stmt = db.prepare('SELECT COUNT(*) as count FROM test')
			const row = stmt.get()
			console.log(JSON.stringify(row))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { count: 3 })
	})

	test('file-based database', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const dbPath = '${dir}/test.db'

			// Create and populate
			const db1 = new DatabaseSync(dbPath)
			db1.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)')
			db1.exec("INSERT INTO test (value) VALUES ('persisted')")
			db1.close()

			// Reopen and read
			const db2 = new DatabaseSync(dbPath)
			const stmt = db2.prepare('SELECT * FROM test')
			const row = stmt.get()
			console.log(JSON.stringify(row))
			db2.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { id: 1, value: 'persisted' })
	})

	test('open option delays opening', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:', { open: false })
			console.log(JSON.stringify({ isOpenBefore: db.isOpen }))
			db.open()
			console.log(JSON.stringify({ isOpenAfter: db.isOpen }))
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		const lines = output.split('\n')
		assert.deepStrictEqual(JSON.parse(lines[0]), { isOpenBefore: false })
		assert.deepStrictEqual(JSON.parse(lines[1]), { isOpenAfter: true })
	})

	test('throws on SQL error', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			try {
				db.exec('INVALID SQL')
				console.log('no error')
			} catch (e) {
				console.log('error thrown')
			}
			db.close()
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'error thrown')
	})

	test('throws on closed database', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { DatabaseSync } from 'node:sqlite'
			const db = new DatabaseSync(':memory:')
			db.close()
			try {
				db.exec('SELECT 1')
				console.log('no error')
			} catch (e) {
				console.log('error thrown')
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output, 'error thrown')
	})
})

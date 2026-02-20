import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, testQnOnly, $ } from './util.js'

describe('node:module shim', () => {
	test('stripTypeScriptTypes strips type annotations preserving positions', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'const x: number = 42'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.strictEqual(output, 'const x         = 42')
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes strips interfaces', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'interface Foo { bar: string }'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.ok(!output.includes('interface'))
		assert.strictEqual(output.trim(), '')
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes strips generics preserving positions', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'function identity<T>(x: T): T { return x }'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.strictEqual(output, 'function identity   (x   )    { return x }')
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes preserves line count on multiline input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'interface Foo {\\n  bar: string\\n  baz: number\\n}'
			const output = stripTypeScriptTypes(input)
			const inputLines = input.split('\\n').length
			const outputLines = output.split('\\n').length
			console.log(JSON.stringify({ inputLines, outputLines, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { inputLines, outputLines, lenMatch } = JSON.parse(result)
		assert.strictEqual(inputLines, outputLines)
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes blanks import type', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'import type { Foo } from "bar"'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.strictEqual(output.trim(), '')
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes throws on enum in strip mode', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			try {
				stripTypeScriptTypes('enum Color { Red, Green, Blue }')
				console.log(JSON.stringify({ threw: false }))
			} catch (e) {
				console.log(JSON.stringify({ threw: true, isSyntax: e instanceof SyntaxError }))
			}
		`)

		const result = $`${bin} ${dir}/test.js`
		const { threw, isSyntax } = JSON.parse(result)
		assert.strictEqual(threw, true)
		assert.strictEqual(isSyntax, true)
	})

	testQnOnly('stripTypeScriptTypes transform mode handles enums', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const output = stripTypeScriptTypes('enum Color { Red, Green, Blue }', { mode: 'transform' })
			console.log(JSON.stringify({ output }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output } = JSON.parse(result)
		assert.ok(output.includes('Color'))
		assert.ok(!output.includes('enum'))
	})

	test('stripTypeScriptTypes strips as expression', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'const x = y as string'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.strictEqual(output, 'const x = y          ')
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes strips satisfies expression', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'const x = y satisfies string'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.strictEqual(output, 'const x = y                 ')
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes handles export type without from clause', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'export type { Foo }\\nexport { Bar } from "baz"'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.ok(output.includes('export { Bar }'))
		assert.ok(!output.includes('Foo'))
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes preserves string contents with type keywords', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'const x = "interface Foo { bar: string }"'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output } = JSON.parse(result)
		assert.strictEqual(output, 'const x = "interface Foo { bar: string }"')
	})

	test('stripTypeScriptTypes handles empty input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const output = stripTypeScriptTypes('')
			console.log(JSON.stringify({ output }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output } = JSON.parse(result)
		assert.strictEqual(output, '')
	})

	test('stripTypeScriptTypes handles pure JS unchanged', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'const x = 42\\nfunction foo() { return x }'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output } = JSON.parse(result)
		assert.strictEqual(output, 'const x = 42\nfunction foo() { return x }')
	})

	test('stripTypeScriptTypes handles nested generics', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'const x: Map<string, Array<number>> = new Map()'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.ok(output.includes('= new Map()'))
		assert.ok(!output.includes('Map<'))
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes handles complex multiline function', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'function f(\\n  x: number,\\n  y: string\\n): boolean {\\n  return true\\n}'
			const output = stripTypeScriptTypes(input)
			const inputLines = input.split('\\n').length
			const outputLines = output.split('\\n').length
			console.log(JSON.stringify({ inputLines, outputLines, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { inputLines, outputLines, lenMatch } = JSON.parse(result)
		assert.strictEqual(inputLines, outputLines)
		assert.strictEqual(lenMatch, true)
	})

	test('stripTypeScriptTypes strips declare statement', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { stripTypeScriptTypes } from 'node:module'
			const input = 'declare const x: number'
			const output = stripTypeScriptTypes(input)
			console.log(JSON.stringify({ output, lenMatch: input.length === output.length }))
		`)

		const result = $`${bin} ${dir}/test.js`
		const { output, lenMatch } = JSON.parse(result)
		assert.strictEqual(output.trim(), '')
		assert.strictEqual(lenMatch, true)
	})
})

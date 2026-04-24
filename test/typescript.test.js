import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { testQnOnly, $, QNC, mktempdir } from './util.js'

const ROOT = resolve(dirname(import.meta.filename), '..')

describe('TypeScript execution', () => {
	testQnOnly('runs .ts file with type annotations', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			const x: number = 42
			const y: string = "hello"
			console.log(x, y)
		`)
		const result = $`${bin} ${dir}/main.ts`
		assert.strictEqual(result, '42 hello')
	})

	testQnOnly('runs .ts file with interfaces and generics', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			interface User { name: string; age: number }
			function greet<T extends User>(user: T): string {
				return user.name + ":" + user.age
			}
			console.log(greet({ name: "Alice", age: 30 }))
		`)
		const result = $`${bin} ${dir}/main.ts`
		assert.strictEqual(result, 'Alice:30')
	})

	testQnOnly('runs .ts file with enums (falls back to transform)', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			enum Color { Red, Green, Blue }
			console.log(Color.Green)
		`)
		const result = $`${bin} ${dir}/main.ts`
		assert.strictEqual(result, '1')
	})

	testQnOnly('imports .ts from .ts with explicit extension', ({ bin, dir }) => {
		writeFileSync(`${dir}/lib.ts`, `
			export function add(a: number, b: number): number {
				return a + b
			}
		`)
		writeFileSync(`${dir}/main.ts`, `
			import { add } from "./lib.ts"
			console.log(add(10, 32))
		`)
		const result = $`${bin} ${dir}/main.ts`
		assert.strictEqual(result, '42')
	})

	testQnOnly('imports .ts from .ts with extensionless import', ({ bin, dir }) => {
		writeFileSync(`${dir}/lib.ts`, `
			export const value: number = 99
		`)
		writeFileSync(`${dir}/main.ts`, `
			import { value } from "./lib"
			console.log(value)
		`)
		const result = $`${bin} ${dir}/main.ts`
		assert.strictEqual(result, '99')
	})

	testQnOnly('imports .ts from .js', ({ bin, dir }) => {
		writeFileSync(`${dir}/lib.ts`, `
			export function mul(a: number, b: number): number {
				return a * b
			}
		`)
		writeFileSync(`${dir}/main.js`, `
			import { mul } from "./lib.ts"
			console.log(mul(6, 7))
		`)
		const result = $`${bin} ${dir}/main.js`
		assert.strictEqual(result, '42')
	})

	testQnOnly('preserves source locations in strip mode', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, [
			'const x: number = 1',
			'const y: string = "hello"',
			'const z: boolean = true',
			'throw new Error("test error")',
		].join('\n'))
		try {
			$`${bin} ${dir}/main.ts`
			assert.fail('should have thrown')
		} catch (e) {
			assert.ok(e.message.includes('main.ts:4'), 'error should reference line 4')
		}
	})

	testQnOnly('directory with package.json main pointing to .ts', ({ bin, dir }) => {
		const pkgDir = `${dir}/mypkg`
		mkdirSync(pkgDir)
		writeFileSync(`${pkgDir}/package.json`, JSON.stringify({
			main: "entry.ts"
		}))
		writeFileSync(`${pkgDir}/entry.ts`, `
			console.log("from ts entry")
		`)
		const result = $`${bin} ${pkgDir}`
		assert.strictEqual(result, 'from ts entry')
	})

	testQnOnly('directory with index.ts (no package.json)', ({ bin, dir }) => {
		const pkgDir = `${dir}/mypkg`
		mkdirSync(pkgDir)
		writeFileSync(`${pkgDir}/index.ts`, `
			console.log("index ts")
		`)
		const result = $`${bin} ${pkgDir}`
		assert.strictEqual(result, 'index ts')
	})

	testQnOnly('directory with index.js takes precedence over index.ts', ({ bin, dir }) => {
		const pkgDir = `${dir}/mypkg`
		mkdirSync(pkgDir)
		writeFileSync(`${pkgDir}/index.js`, `console.log("index js")`)
		writeFileSync(`${pkgDir}/index.ts`, `console.log("index ts")`)
		const result = $`${bin} ${pkgDir}`
		assert.strictEqual(result, 'index js')
	})

	testQnOnly('.ts file with import type is properly stripped', ({ bin, dir }) => {
		writeFileSync(`${dir}/types.ts`, `
			export interface Foo { x: number }
			export type Bar = string
		`)
		writeFileSync(`${dir}/main.ts`, `
			import type { Foo } from "./types.ts"
			const obj = { x: 42 }
			console.log(obj.x)
		`)
		const result = $`${bin} ${dir}/main.ts`
		assert.strictEqual(result, '42')
	})

	testQnOnly('strips class modifiers (override/public/private/readonly/abstract/declare)', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, [
			'class Base { name = "base" }',
			'abstract class Mid extends Base {',
			'	public pub = 1',
			'	private priv = 2',
			'	protected prot = 3',
			'	readonly ro = 4',
			'	declare maybe: number',
			'	override name = "mid"',
			'}',
			'class Leaf extends Mid {}',
			'const x = new Leaf()',
			'console.log(x.name, x.pub, x.priv, x.prot, x.ro)',
		].join('\n'))
		const result = $`${bin} ${dir}/main.ts`
		assert.strictEqual(result, 'mid 1 2 3 4')
	})

	testQnOnly('strips non-null assertion', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, [
			'let a: number | null = 7',
			'console.log(a! + 1)',
		].join('\n'))
		const result = $`${bin} ${dir}/main.ts`
		assert.strictEqual(result, '8')
	})

	testQnOnly('parameter property falls back to transform', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, [
			'class A {',
			'	constructor(private x: number, public y: number) {}',
			'	sum(): number { return this.x + this.y }',
			'}',
			'console.log(new A(10, 32).sum())',
		].join('\n'))
		const result = $`${bin} ${dir}/main.ts`
		assert.strictEqual(result, '42')
	})

	testQnOnly('.ts with NODE_PATH bare import', ({ bin, dir }) => {
		const libDir = `${dir}/libs`
		mkdirSync(libDir)
		mkdirSync(`${libDir}/mylib`)
		writeFileSync(`${libDir}/mylib/index.ts`, `
			export const greeting: string = "hi from ts lib"
		`)
		writeFileSync(`${dir}/main.ts`, `
			import { greeting } from "mylib"
			console.log(greeting)
		`)
		const $env = $({ env: { ...process.env, NODE_PATH: libDir, NO_COLOR: '1' } })
		const result = $env`${bin} ${dir}/main.ts`
		assert.strictEqual(result, 'hi from ts lib')
	})
})

describe('TypeScript compilation (qnc)', { concurrency: true }, () => {
	const nodeDir = resolve(ROOT, 'node')
	const $qnc = $({ env: { ...process.env, NODE_PATH: nodeDir, NO_COLOR: '1' } })

	testQnOnly('compiles .ts entry point to executable', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			const x: number = 42
			console.log(x)
		`)
		$qnc`${QNC()} -o ${dir}/app ${dir}/main.ts`
		const result = $`${dir}/app`
		assert.strictEqual(result, '42')
	})

	testQnOnly('compiles .ts with imports to other .ts files', ({ bin, dir }) => {
		writeFileSync(`${dir}/lib.ts`, `
			export function double(n: number): number { return n * 2 }
		`)
		writeFileSync(`${dir}/main.ts`, `
			import { double } from "./lib.ts"
			console.log(double(21))
		`)
		$qnc`${QNC()} -o ${dir}/app ${dir}/main.ts`
		const result = $`${dir}/app`
		assert.strictEqual(result, '42')
	})

	testQnOnly('compiles .ts with enums (transform fallback)', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			enum Direction { Up, Down, Left, Right }
			console.log(Direction.Right)
		`)
		$qnc`${QNC()} -o ${dir}/app ${dir}/main.ts`
		const result = $`${dir}/app`
		assert.strictEqual(result, '3')
	})

	testQnOnly('embeds .ts module via -D flag', ({ bin, dir }) => {
		mkdirSync(`${dir}/mylib`)
		writeFileSync(`${dir}/mylib/index.ts`, `
			export const answer: number = 42
		`)
		writeFileSync(`${dir}/main.js`, `
			import { answer } from "mylib"
			console.log(answer)
		`)
		const $d = $({ env: { ...process.env, NODE_PATH: `${nodeDir}:${dir}`, NO_COLOR: '1' } })
		$d`${QNC()} -D mylib -o ${dir}/app ${dir}/main.js`
		const result = $`${dir}/app`
		assert.strictEqual(result, '42')
	})

	testQnOnly('compiles .ts with import type (type-only imports stripped)', ({ bin, dir }) => {
		writeFileSync(`${dir}/types.ts`, `
			export interface Config { port: number }
			export const defaultPort: number = 8080
		`)
		writeFileSync(`${dir}/main.ts`, `
			import type { Config } from "./types.ts"
			import { defaultPort } from "./types.ts"
			console.log(defaultPort)
		`)
		$qnc`${QNC()} -o ${dir}/app ${dir}/main.ts`
		const result = $`${dir}/app`
		assert.strictEqual(result, '8080')
	})
})

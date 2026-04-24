import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { testQnOnly, $, QNC } from './util.js'

describe('TypeScript namespace desugaring', () => {
	testQnOnly('bag of functions and export const', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			export namespace Foo {
				export function bar(x: number): number { return x + 1 }
				export const DEFAULT = 7
				export function baz(): number { return bar(DEFAULT) }
			}
			console.log(Foo.bar(1), Foo.DEFAULT, Foo.baz())
		`)
		assert.strictEqual($`${bin} ${dir}/main.ts`, '2 7 8')
	})

	testQnOnly('interface and namespace merging (same name)', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			export interface Event<T> { (l: (e: T) => void): void }
			export namespace Event {
				export const None: Event<any> = (() => {}) as any
				export function emit<T>(e: Event<T>): void { e(null as any) }
			}
			Event.emit(Event.None)
			console.log("ok")
		`)
		assert.strictEqual($`${bin} ${dir}/main.ts`, 'ok')
	})

	testQnOnly('non-exported locals stay local', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			namespace It {
				const _empty = Object.freeze([])
				export function empty() { return _empty }
				export function* single<T>(x: T): Iterable<T> { yield x }
			}
			console.log(It.empty().length, [...It.single(42)][0])
		`)
		assert.strictEqual($`${bin} ${dir}/main.ts`, '0 42')
	})

	testQnOnly('cross-namespace reference + template literal in body', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, [
			'export namespace channels {',
			'	export function toCss(r: number, g: number, b: number): string {',
			'		return `#${r.toString(16).padStart(2,"0")}${g.toString(16).padStart(2,"0")}${b.toString(16).padStart(2,"0")}`',
			'	}',
			'}',
			'export namespace color {',
			'	export function blend(): string { return channels.toCss(16, 32, 48) }',
			'}',
			'console.log(color.blend())',
		].join('\n'))
		assert.strictEqual($`${bin} ${dir}/main.ts`, '#102030')
	})

	testQnOnly('self-reference via Name.member inside body', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			export namespace X {
				export const base = 10
				export function next(): number { return X.base + 1 }
			}
			console.log(X.next())
		`)
		assert.strictEqual($`${bin} ${dir}/main.ts`, '11')
	})

	testQnOnly('function overloads (signature + impl)', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			export namespace U {
				export function any<T>(x: T): T;
				export function any(x: string): string;
				export function any(x: any): any { return x }
			}
			console.log(U.any(42), U.any("hi"))
		`)
		assert.strictEqual($`${bin} ${dir}/main.ts`, '42 hi')
	})

	testQnOnly('bitshift operators inside body (Sucrase mistokenization workaround)', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			export namespace bits {
				export function pack(r: number, g: number, b: number, a: number): number {
					return (r << 24 | g << 16 | b << 8 | a) >>> 0
				}
			}
			console.log(bits.pack(1, 2, 3, 4).toString(16))
		`)
		assert.strictEqual($`${bin} ${dir}/main.ts`, '1020304')
	})

	testQnOnly('export class inside namespace', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			export namespace N {
				export class C { val = 42 }
			}
			console.log(new N.C().val)
		`)
		assert.strictEqual($`${bin} ${dir}/main.ts`, '42')
	})

	testQnOnly('non-exported namespace (no module export)', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			namespace P {
				export const x = 5
			}
			console.log(P.x)
		`)
		assert.strictEqual($`${bin} ${dir}/main.ts`, '5')
	})

	testQnOnly('type-only exports in namespace (interface) work alongside values', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			namespace I {
				export interface Foo { x: number }
				export const make = (): Foo => ({ x: 1 })
			}
			console.log(I.make().x)
		`)
		assert.strictEqual($`${bin} ${dir}/main.ts`, '1')
	})

	testQnOnly('declare namespace is erased (no runtime effect)', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			declare namespace Absent {
				export function gone(): void
			}
			const x = 1
			console.log(x)
		`)
		assert.strictEqual($`${bin} ${dir}/main.ts`, '1')
	})

	testQnOnly('namespace imported from another .ts file', ({ bin, dir }) => {
		writeFileSync(`${dir}/lib.ts`, `
			export namespace utils {
				export function double(n: number): number { return n * 2 }
				export const FACTOR = 10
			}
		`)
		writeFileSync(`${dir}/main.ts`, `
			import { utils } from "./lib.ts"
			console.log(utils.double(utils.FACTOR))
		`)
		assert.strictEqual($`${bin} ${dir}/main.ts`, '20')
	})

	const rejectCases = [
		{ name: 'nested namespace', src: 'namespace A { export namespace B { export const x = 1 } }', msg: 'nested' },
		{ name: 'export default', src: 'namespace A { export default 1 }', msg: 'export default' },
		{ name: 'export =', src: 'namespace A { export = 1 }', msg: 'export =' },
		{ name: 'export enum', src: 'namespace A { export enum E { X } }', msg: 'export enum' },
		{ name: 'export { ... }', src: 'namespace A { const x = 1; export { x } }', msg: 'export { ... }' },
		{ name: 'destructured binding', src: 'namespace A { export const { x, y } = { x: 1, y: 2 } }', msg: 'destructured' },
		{ name: 'multi-binding', src: 'namespace A { export const x = 1, y = 2 }', msg: 'multi-binding' },
		{ name: 'qualified name', src: 'namespace A.B { export const x = 1 }', msg: 'qualified' },
	]
	for (const c of rejectCases) {
		testQnOnly(`rejects: ${c.name}`, ({ bin, dir }) => {
			writeFileSync(`${dir}/main.ts`, c.src)
			try {
				$`${bin} ${dir}/main.ts`
				assert.fail('should have thrown')
			} catch (e) {
				const out = (e.stderr ?? '') + (e.stdout ?? '')
				assert.ok(
					out.toLowerCase().includes(c.msg.toLowerCase()),
					`expected stderr to mention "${c.msg}", got: ${out}`,
				)
			}
		})
	}
})

describe('TypeScript namespace compilation (qnc)', { concurrency: true }, () => {
	testQnOnly('qnc compiles .ts with namespace', ({ bin, dir }) => {
		writeFileSync(`${dir}/main.ts`, `
			export namespace Helpers {
				export function add(a: number, b: number): number { return a + b }
			}
			console.log(Helpers.add(2, 3))
		`)
		$`${QNC()} -o ${dir}/app ${dir}/main.ts`
		assert.strictEqual($`${dir}/app`, '5')
	})
})

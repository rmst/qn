import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { testQnOnly, $ } from './util.js'

describe('std.getClosureVars', () => {
    testQnOnly('returns closure variables for a simple closure', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import * as std from "std";
            let foo = 3;
            let bar = "hello";
            let f = () => { console.log(foo, bar); };
            console.log(JSON.stringify(std.getClosureVars(f)));
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.deepStrictEqual(JSON.parse(output), { foo: 3, bar: "hello" })
    })

    testQnOnly('only returns variables actually captured', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import * as std from "std";
            let a = 1, b = 2, c = 3;
            let f = () => a + c;
            console.log(JSON.stringify(std.getClosureVars(f)));
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.deepStrictEqual(JSON.parse(output), { a: 1, c: 3 })
    })

    testQnOnly('returns current value after mutation', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import * as std from "std";
            let counter = 0;
            let increment = () => ++counter;
            increment();
            increment();
            console.log(JSON.stringify(std.getClosureVars(increment)));
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.deepStrictEqual(JSON.parse(output), { counter: 2 })
    })

    testQnOnly('handles nested closures', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import * as std from "std";
            let outer = 100;
            let makeInner = () => {
                let inner = 200;
                return () => outer + inner;
            };
            let innerFn = makeInner();
            console.log(JSON.stringify(std.getClosureVars(innerFn)));
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.deepStrictEqual(JSON.parse(output), { outer: 100, inner: 200 })
    })

    testQnOnly('returns empty object for function with no closure', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import * as std from "std";
            function plain() { return 42; }
            console.log(JSON.stringify(std.getClosureVars(plain)));
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.deepStrictEqual(JSON.parse(output), {})
    })

    testQnOnly('captures object references', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import * as std from "std";
            let obj = { x: 10, y: 20 };
            let f = () => obj.x;
            console.log(JSON.stringify(std.getClosureVars(f)));
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.deepStrictEqual(JSON.parse(output), { obj: { x: 10, y: 20 } })
    })

    testQnOnly('returns undefined for non-function values', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import * as std from "std";
            console.log(JSON.stringify({
                num: std.getClosureVars(42),
                str: std.getClosureVars("hello"),
                nil: std.getClosureVars(null),
                obj: std.getClosureVars({})
            }));
        `)
        const output = $`${bin} ${dir}/test.js`
        const result = JSON.parse(output)
        assert.strictEqual(result.num, undefined)
        assert.strictEqual(result.str, undefined)
        assert.strictEqual(result.nil, undefined)
        assert.strictEqual(result.obj, undefined)
    })
})

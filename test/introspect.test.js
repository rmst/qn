import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { testQnOnly, $ } from './util.js'

describe('qn:introspect getClosureVars', () => {
    testQnOnly('returns closure variables for a simple closure', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { getClosureVars } from "qn:introspect";
            let foo = 3;
            let bar = "hello";
            let f = () => { console.log(foo, bar); };
            console.log(JSON.stringify(getClosureVars(f)));
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.deepStrictEqual(JSON.parse(output), { foo: 3, bar: "hello" })
    })

    testQnOnly('only returns variables actually captured', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { getClosureVars } from "qn:introspect";
            let a = 1, b = 2, c = 3;
            let f = () => a + c;
            console.log(JSON.stringify(getClosureVars(f)));
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.deepStrictEqual(JSON.parse(output), { a: 1, c: 3 })
    })

    testQnOnly('returns current value after mutation', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { getClosureVars } from "qn:introspect";
            let counter = 0;
            let increment = () => ++counter;
            increment();
            increment();
            console.log(JSON.stringify(getClosureVars(increment)));
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.deepStrictEqual(JSON.parse(output), { counter: 2 })
    })

    testQnOnly('handles nested closures', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { getClosureVars } from "qn:introspect";
            let outer = 100;
            let makeInner = () => {
                let inner = 200;
                return () => outer + inner;
            };
            let innerFn = makeInner();
            console.log(JSON.stringify(getClosureVars(innerFn)));
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.deepStrictEqual(JSON.parse(output), { outer: 100, inner: 200 })
    })

    testQnOnly('returns empty object for function with no closure', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { getClosureVars } from "qn:introspect";
            function plain() { return 42; }
            console.log(JSON.stringify(getClosureVars(plain)));
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.deepStrictEqual(JSON.parse(output), {})
    })

    testQnOnly('returns undefined for non-function values', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { getClosureVars } from "qn:introspect";
            console.log(JSON.stringify({
                num: getClosureVars(42),
                str: getClosureVars("hello"),
                nil: getClosureVars(null),
                obj: getClosureVars({})
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

describe('qn:introspect serialize/deserialize', () => {
    testQnOnly('serializes and deserializes a simple closure', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize, deserialize } from 'qn:introspect';
            let foo = 3;
            let bar = "hello";
            let f = () => foo + bar.length;
            const serialized = serialize(f);
            const restored = deserialize(serialized);
            console.log(JSON.stringify({
                original: f(),
                restored: restored(),
                match: f() === restored()
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 8)
        assert.strictEqual(output.restored, 8)
        assert.strictEqual(output.match, true)
    })

    testQnOnly('serializes function with nested function closure', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize, deserialize } from 'qn:introspect';
            let helper = (x) => x * 2;
            let outer = (x) => helper(x) + 1;
            const serialized = serialize(outer);
            const restored = deserialize(serialized);
            console.log(JSON.stringify({
                original: outer(5),
                restored: restored(5)
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 11)
        assert.strictEqual(output.restored, 11)
    })

    testQnOnly('serializes multiple levels of nested functions', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize, deserialize } from 'qn:introspect';
            let a = (x) => x + 1;
            let b = (x) => a(x) * 2;
            let c = (x) => b(x) + 3;
            const serialized = serialize(c);
            const restored = deserialize(serialized);
            console.log(JSON.stringify({
                original: c(5),
                restored: restored(5)
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 15)
        assert.strictEqual(output.restored, 15)
    })

    testQnOnly('handles mixed function and non-function closure vars', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize, deserialize } from 'qn:introspect';
            let factor = 10;
            let transform = (x) => x * 2;
            let compute = (x) => transform(x) + factor;
            const serialized = serialize(compute);
            const restored = deserialize(serialized);
            console.log(JSON.stringify({
                original: compute(5),
                restored: restored(5)
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 20)
        assert.strictEqual(output.restored, 20)
    })

    testQnOnly('works with functions that have no closure', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize, deserialize } from 'qn:introspect';
            let add = (a, b) => a + b;
            const serialized = serialize(add);
            const restored = deserialize(serialized);
            console.log(JSON.stringify({
                original: add(3, 4),
                restored: restored(3, 4)
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 7)
        assert.strictEqual(output.restored, 7)
    })

    testQnOnly('throws on non-JSON-serializable closure vars', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize } from 'qn:introspect';
            let circular = {};
            circular.self = circular;
            let f = () => circular;
            try {
                serialize(f);
                console.log("NO_ERROR");
            } catch (e) {
                console.log("ERROR:" + (e.message.includes('not JSON-serializable') ? 'correct' : e.message));
            }
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.strictEqual(output, "ERROR:correct")
    })

    testQnOnly('throws on non-function input', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize } from 'qn:introspect';
            try {
                serialize("not a function");
                console.log("NO_ERROR");
            } catch (e) {
                console.log("ERROR:" + e.name);
            }
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.strictEqual(output, "ERROR:TypeError")
    })

    testQnOnly('detects circular function references', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize } from 'qn:introspect';
            let a, b;
            a = () => b();
            b = () => a();
            try {
                serialize(a);
                console.log("NO_ERROR");
            } catch (e) {
                console.log("ERROR:" + (e.message.includes('Circular') ? 'correct' : e.message));
            }
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.strictEqual(output, "ERROR:correct")
    })
})

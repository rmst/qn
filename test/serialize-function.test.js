import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { testQnOnly, $ } from './util.js'

describe('serializeFunction (basic)', () => {
    testQnOnly('serializes and deserializes a simple closure', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serializeFunction, deserializeFunction } from 'node:serialize-function';
            let foo = 3;
            let bar = "hello";
            let f = () => foo + bar.length;
            const serialized = serializeFunction(f);
            const restored = deserializeFunction(serialized);
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

    testQnOnly('serializes and deserializes functions with parameters', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serializeFunction, deserializeFunction } from 'node:serialize-function';
            let multiplier = 10;
            let multiply = (x) => x * multiplier;
            const serialized = serializeFunction(multiply);
            const restored = deserializeFunction(serialized);
            console.log(JSON.stringify({
                original: multiply(5),
                restored: restored(5),
                match: multiply(5) === restored(5)
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 50)
        assert.strictEqual(output.restored, 50)
        assert.strictEqual(output.match, true)
    })

    testQnOnly('serializes object closure variables', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serializeFunction, deserializeFunction } from 'node:serialize-function';
            let config = { factor: 2, offset: 10 };
            let compute = (x) => x * config.factor + config.offset;
            const serialized = serializeFunction(compute);
            const restored = deserializeFunction(serialized);
            console.log(JSON.stringify({
                original: compute(5),
                restored: restored(5)
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 20)
        assert.strictEqual(output.restored, 20)
    })

    testQnOnly('stringifyFunction and parseFunction work correctly', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { stringifyFunction, parseFunction } from 'node:serialize-function';
            let x = 5;
            let f = () => x * 2;
            const json = stringifyFunction(f);
            const restored = parseFunction(json);
            console.log(JSON.stringify({
                json: json,
                original: f(),
                restored: restored()
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 10)
        assert.strictEqual(output.restored, 10)
        // Verify JSON is valid
        const parsed = JSON.parse(output.json)
        assert.ok(parsed.code)
        assert.ok(typeof parsed.closureVars === 'object')
    })

    testQnOnly('works with functions that have no closure', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serializeFunction, deserializeFunction } from 'node:serialize-function';
            let add = (a, b) => a + b;
            const serialized = serializeFunction(add);
            const restored = deserializeFunction(serialized);
            console.log(JSON.stringify({
                original: add(3, 4),
                restored: restored(3, 4),
                hasEmptyClosure: Object.keys(serialized.closureVars).length === 0
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 7)
        assert.strictEqual(output.restored, 7)
        assert.strictEqual(output.hasEmptyClosure, true)
    })

    testQnOnly('throws on non-JSON-serializable closure vars', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serializeFunction } from 'node:serialize-function';
            let circular = {};
            circular.self = circular;
            let f = () => circular;
            try {
                serializeFunction(f);
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
            import { serializeFunction } from 'node:serialize-function';
            try {
                serializeFunction("not a function");
                console.log("NO_ERROR");
            } catch (e) {
                console.log("ERROR:" + e.name);
            }
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.strictEqual(output, "ERROR:TypeError")
    })

    testQnOnly('works with array closure variables', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serializeFunction, deserializeFunction } from 'node:serialize-function';
            let items = [1, 2, 3, 4, 5];
            let sum = () => items.reduce((a, b) => a + b, 0);
            const serialized = serializeFunction(sum);
            const restored = deserializeFunction(serialized);
            console.log(JSON.stringify({
                original: sum(),
                restored: restored()
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 15)
        assert.strictEqual(output.restored, 15)
    })
})

describe('serializeFunctionDeep (nested closures)', () => {
    testQnOnly('serializes function with nested function closure', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serializeFunctionDeep, deserializeFunctionDeep } from 'node:serialize-function';
            let helper = (x) => x * 2;
            let outer = (x) => helper(x) + 1;
            const serialized = serializeFunctionDeep(outer);
            const restored = deserializeFunctionDeep(serialized);
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
            import { serializeFunctionDeep, deserializeFunctionDeep } from 'node:serialize-function';
            let a = (x) => x + 1;
            let b = (x) => a(x) * 2;
            let c = (x) => b(x) + 3;
            const serialized = serializeFunctionDeep(c);
            const restored = deserializeFunctionDeep(serialized);
            console.log(JSON.stringify({
                original: c(5),
                restored: restored(5)
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 15)  // ((5+1)*2)+3 = 15
        assert.strictEqual(output.restored, 15)
    })

    testQnOnly('stringifyFunctionDeep and parseFunctionDeep work correctly', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { stringifyFunctionDeep, parseFunctionDeep } from 'node:serialize-function';
            let mult = (x) => x * 3;
            let add = (x) => mult(x) + 10;
            const json = stringifyFunctionDeep(add);
            const parsed = parseFunctionDeep(json);
            console.log(JSON.stringify({
                original: add(5),
                parsed: parsed(5),
                hasNestedFunction: json.includes('__serialized_function__')
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 25)
        assert.strictEqual(output.parsed, 25)
        assert.strictEqual(output.hasNestedFunction, true)
    })

    testQnOnly('handles mixed function and non-function closure vars', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serializeFunctionDeep, deserializeFunctionDeep } from 'node:serialize-function';
            let factor = 10;
            let transform = (x) => x * 2;
            let compute = (x) => transform(x) + factor;
            const serialized = serializeFunctionDeep(compute);
            const restored = deserializeFunctionDeep(serialized);
            console.log(JSON.stringify({
                original: compute(5),
                restored: restored(5)
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 20)
        assert.strictEqual(output.restored, 20)
    })

    testQnOnly('detects circular function references', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serializeFunctionDeep } from 'node:serialize-function';
            // Create a circular reference through closures
            let a, b;
            a = () => b();
            b = () => a();
            try {
                serializeFunctionDeep(a);
                console.log("NO_ERROR");
            } catch (e) {
                console.log("ERROR:" + (e.message.includes('Circular') ? 'correct' : e.message));
            }
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.strictEqual(output, "ERROR:correct")
    })
})

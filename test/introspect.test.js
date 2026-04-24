import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { testQnOnly, $ } from './util.js'

describe('qn:introspect getClosureVars', () => {
    testQnOnly('returns closure variables with type metadata', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { getClosureVars } from "qn:introspect";
            let foo = 3;
            let bar = "hello";
            let f = () => { console.log(foo, bar); };
            const vars = getClosureVars(f);
            console.log(JSON.stringify({
                foo: vars.foo,
                bar: vars.bar,
            }));
        `)
        const output = $`${bin} ${dir}/test.js`
        const result = JSON.parse(output)
        assert.deepStrictEqual(result.foo, { value: 3, type: "ref" })
        assert.deepStrictEqual(result.bar, { value: "hello", type: "ref" })
    })

    testQnOnly('only returns variables actually captured', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { getClosureVars } from "qn:introspect";
            let a = 1, b = 2, c = 3;
            let f = () => a + c;
            const vars = getClosureVars(f);
            console.log(JSON.stringify({ a: vars.a, c: vars.c, hasB: 'b' in vars }));
        `)
        const output = $`${bin} ${dir}/test.js`
        const result = JSON.parse(output)
        assert.deepStrictEqual(result.a, { value: 1, type: "ref" })
        assert.deepStrictEqual(result.c, { value: 3, type: "ref" })
        assert.strictEqual(result.hasB, false)
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
        const result = JSON.parse(output)
        assert.deepStrictEqual(result.counter, { value: 2, type: "ref" })
    })

    testQnOnly('includes globals with type "global"', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { getClosureVars } from "qn:introspect";
            let x = 1;
            let f = () => console.log(x);
            const vars = getClosureVars(f);
            console.log(JSON.stringify({
                xType: vars.x?.type,
                consoleType: vars.console?.type,
            }));
        `)
        const output = $`${bin} ${dir}/test.js`
        const result = JSON.parse(output)
        assert.notStrictEqual(result.xType, "global")
        assert.strictEqual(result.consoleType, "global")
    })

    testQnOnly('returns undefined for non-function values', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { getClosureVars } from "qn:introspect";
            console.log(JSON.stringify({
                num: getClosureVars(42),
                str: getClosureVars("hello")
            }));
        `)
        const output = $`${bin} ${dir}/test.js`
        const result = JSON.parse(output)
        assert.strictEqual(result.num, undefined)
        assert.strictEqual(result.str, undefined)
    })
})

describe('qn:introspect closureToSource', () => {
    testQnOnly('returns a string', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { closureToSource } from 'qn:introspect';
            let x = 5;
            let f = () => x * 2;
            const code = closureToSource(f);
            console.log(typeof code === 'string' ? 'OK' : 'FAIL');
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.strictEqual(output, 'OK')
    })

    testQnOnly('produces working code for simple closure', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { closureToSource } from 'qn:introspect';
            let foo = 3;
            let bar = 5;
            let f = () => foo + bar;
            const code = closureToSource(f);
            const restored = eval(code);
            console.log(JSON.stringify({
                original: f(),
                restored: restored()
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 8)
        assert.strictEqual(output.restored, 8)
    })

    testQnOnly('handles nested function closures', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { closureToSource } from 'qn:introspect';
            let helper = (x) => x * 2;
            let outer = (x) => helper(x) + 1;
            const code = closureToSource(outer);
            const restored = eval(code);
            console.log(JSON.stringify({
                original: outer(5),
                restored: restored(5)
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 11)
        assert.strictEqual(output.restored, 11)
    })

    testQnOnly('handles multiple levels of nested functions', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { closureToSource } from 'qn:introspect';
            let a = (x) => x + 1;
            let b = (x) => a(x) * 2;
            let c = (x) => b(x) + 3;
            const code = closureToSource(c);
            const restored = eval(code);
            console.log(JSON.stringify({
                original: c(5),
                restored: restored(5)
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 15)
        assert.strictEqual(output.restored, 15)
    })

    testQnOnly('handles arrays and objects in closures', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { closureToSource } from 'qn:introspect';
            let items = [1, 2, 3];
            let config = { multiplier: 2 };
            let process = () => items.map(x => x * config.multiplier);
            const code = closureToSource(process);
            const restored = eval(code);
            console.log(JSON.stringify({
                original: process(),
                restored: restored()
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.deepStrictEqual(output.original, [2, 4, 6])
        assert.deepStrictEqual(output.restored, [2, 4, 6])
    })

    testQnOnly('handles null and undefined in closures', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { closureToSource } from 'qn:introspect';
            let n = null;
            let u = undefined;
            let f = () => ({ n, u });
            const code = closureToSource(f);
            const restored = eval(code);
            const result = restored();
            console.log(JSON.stringify({
                nIsNull: result.n === null,
                uIsUndefined: result.u === undefined
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.nIsNull, true)
        assert.strictEqual(output.uIsUndefined, true)
    })

    testQnOnly('throws on non-function input', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { closureToSource } from 'qn:introspect';
            try {
                closureToSource("not a function");
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
            import { closureToSource } from 'qn:introspect';
            let a, b;
            a = () => b();
            b = () => a();
            try {
                closureToSource(a);
                console.log("NO_ERROR");
            } catch (e) {
                console.log("ERROR:" + (e.message.includes('Circular') ? 'correct' : e.message));
            }
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.strictEqual(output, "ERROR:correct")
    })

    testQnOnly('handles imported functions with their closures', ({ bin, dir }) => {
        writeFileSync(`${dir}/utils.js`, `
            let secret = 42;
            export function helper(x) { return x + secret; }
        `)
        writeFileSync(`${dir}/test.js`, `
            import { closureToSource } from 'qn:introspect';
            import { helper } from './utils.js';
            let f = (x) => helper(x) + 100;
            const code = closureToSource(f);
            const restored = eval(code);
            console.log(JSON.stringify({
                original: f(10),
                restored: restored(10)
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 152)
        assert.strictEqual(output.restored, 152)
    })

    testQnOnly('produces nicely formatted output', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { closureToSource } from 'qn:introspect';
            let x = 5;
            let f = () => x * 2;
            const code = closureToSource(f);
            // Check it has proper formatting
            const hasNewlines = code.includes('\\n');
            const hasIndent = code.includes('  let');
            const hasIIFE = code.startsWith('(() =>');
            console.log(JSON.stringify({ hasNewlines, hasIndent, hasIIFE }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.hasNewlines, true)
        assert.strictEqual(output.hasIndent, true)
        assert.strictEqual(output.hasIIFE, true)
    })

    testQnOnly('function without closures returns just the code', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { closureToSource } from 'qn:introspect';
            let f = (x) => x * 2;
            const code = closureToSource(f);
            console.log(code);
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.strictEqual(output, '(x) => x * 2')
    })

    testQnOnly('throws for non-plain objects instead of silent failure', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { closureToSource } from 'qn:introspect';
            let errors = [];

            for (let [name, val] of [
                ['RegExp', /test/],
                ['Date', new Date()],
                ['Map', new Map()],
                ['Set', new Set()],
            ]) {
                try {
                    closureToSource(() => val);
                    errors.push(name + ':no_error');
                } catch (e) {
                    errors.push(name + ':' + e.message.includes(name));
                }
            }
            console.log(errors.join(','));
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.strictEqual(output, 'RegExp:true,Date:true,Map:true,Set:true')
    })

    testQnOnly('handles BigInt correctly', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { closureToSource } from 'qn:introspect';
            let big = 123n;
            let f = () => big * 2n;
            const code = closureToSource(f);
            const restored = eval(code);
            console.log(String(restored()));
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.strictEqual(output, '246')
    })
})

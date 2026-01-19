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

describe('qn:introspect serialize/deserialize', () => {
    testQnOnly('serialize returns a string', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize } from 'qn:introspect';
            let x = 5;
            let f = () => x * 2;
            const str = serialize(f);
            console.log(JSON.stringify({ isString: typeof str === 'string' }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.isString, true)
    })

    testQnOnly('serializes and deserializes a simple closure', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize, deserialize } from 'qn:introspect';
            let foo = 3;
            let bar = "hello";
            let f = () => foo + bar.length;
            const str = serialize(f);
            const restored = deserialize(str);
            console.log(JSON.stringify({
                original: f(),
                restored: restored()
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 8)
        assert.strictEqual(output.restored, 8)
    })

    testQnOnly('serializes nested function closures', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize, deserialize } from 'qn:introspect';
            let helper = (x) => x * 2;
            let outer = (x) => helper(x) + 1;
            const str = serialize(outer);
            const restored = deserialize(str);
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
            const str = serialize(c);
            const restored = deserialize(str);
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
            import { serialize, deserialize } from 'qn:introspect';
            let items = [1, 2, 3];
            let config = { multiplier: 2 };
            let process = () => items.map(x => x * config.multiplier);
            const str = serialize(process);
            const restored = deserialize(str);
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
            import { serialize, deserialize } from 'qn:introspect';
            let n = null;
            let u = undefined;
            let f = () => ({ n, u });
            const str = serialize(f);
            const restored = deserialize(str);
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

describe('qn:introspect replacer/reviver', () => {
    testQnOnly('custom replacer handles Date objects', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize, deserialize } from 'qn:introspect';
            let timestamp = new Date('2024-01-15T12:00:00Z');
            let getTime = () => timestamp.getTime();

            const str = serialize(getTime, {
                replacer: (value) => {
                    if (value instanceof Date) {
                        return { t: 'Date', iso: value.toISOString() };
                    }
                }
            });

            const restored = deserialize(str, {
                reviver: (type, data) => {
                    if (type === 'Date') return new Date(data.iso);
                }
            });

            console.log(JSON.stringify({
                original: getTime(),
                restored: restored()
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.original, 1705320000000)
        assert.strictEqual(output.restored, 1705320000000)
    })

    testQnOnly('custom replacer handles Map objects', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize, deserialize } from 'qn:introspect';
            let lookup = new Map([['a', 1], ['b', 2]]);
            let getValue = (key) => lookup.get(key);

            const str = serialize(getValue, {
                replacer: (value) => {
                    if (value instanceof Map) {
                        return { t: 'Map', entries: [...value.entries()] };
                    }
                }
            });

            const restored = deserialize(str, {
                reviver: (type, data) => {
                    if (type === 'Map') return new Map(data.entries);
                }
            });

            console.log(JSON.stringify({
                originalA: getValue('a'),
                restoredA: restored('a'),
                originalB: getValue('b'),
                restoredB: restored('b')
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.originalA, 1)
        assert.strictEqual(output.restoredA, 1)
        assert.strictEqual(output.originalB, 2)
        assert.strictEqual(output.restoredB, 2)
    })

    testQnOnly('custom replacer handles Set objects', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize, deserialize } from 'qn:introspect';
            let items = new Set([1, 2, 3]);
            let hasItem = (x) => items.has(x);

            const str = serialize(hasItem, {
                replacer: (value) => {
                    if (value instanceof Set) {
                        return { t: 'Set', values: [...value] };
                    }
                }
            });

            const restored = deserialize(str, {
                reviver: (type, data) => {
                    if (type === 'Set') return new Set(data.values);
                }
            });

            console.log(JSON.stringify({
                has2: hasItem(2),
                restored2: restored(2),
                has5: hasItem(5),
                restored5: restored(5)
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.strictEqual(output.has2, true)
        assert.strictEqual(output.restored2, true)
        assert.strictEqual(output.has5, false)
        assert.strictEqual(output.restored5, false)
    })

    testQnOnly('replacer must return object with t property', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize } from 'qn:introspect';
            let d = new Date();
            let f = () => d;
            try {
                serialize(f, {
                    replacer: (value) => {
                        if (value instanceof Date) {
                            return { invalid: 'no t property' };
                        }
                    }
                });
                console.log("NO_ERROR");
            } catch (e) {
                console.log("ERROR:" + (e.message.includes('"t"') ? 'correct' : e.message));
            }
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.strictEqual(output, "ERROR:correct")
    })

    testQnOnly('unknown type without reviver throws', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize, deserialize } from 'qn:introspect';
            let d = new Date();
            let f = () => d;
            const str = serialize(f, {
                replacer: (value) => {
                    if (value instanceof Date) {
                        return { t: 'CustomDate', iso: value.toISOString() };
                    }
                }
            });
            try {
                deserialize(str); // no reviver
                console.log("NO_ERROR");
            } catch (e) {
                console.log("ERROR:" + (e.message.includes('Unknown type') ? 'correct' : e.message));
            }
        `)
        const output = $`${bin} ${dir}/test.js`
        assert.strictEqual(output, "ERROR:correct")
    })

    testQnOnly('nested custom types work correctly', ({ bin, dir }) => {
        writeFileSync(`${dir}/test.js`, `
            import { serialize, deserialize } from 'qn:introspect';
            let dates = [new Date('2024-01-01'), new Date('2024-06-15')];
            let getYears = () => dates.map(d => d.getFullYear());

            const str = serialize(getYears, {
                replacer: (value) => {
                    if (value instanceof Date) {
                        return { t: 'Date', iso: value.toISOString() };
                    }
                }
            });

            const restored = deserialize(str, {
                reviver: (type, data) => {
                    if (type === 'Date') return new Date(data.iso);
                }
            });

            console.log(JSON.stringify({
                original: getYears(),
                restored: restored()
            }));
        `)
        const output = JSON.parse($`${bin} ${dir}/test.js`)
        assert.deepStrictEqual(output.original, [2024, 2024])
        assert.deepStrictEqual(output.restored, [2024, 2024])
    })
})

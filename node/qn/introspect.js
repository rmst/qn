import * as std from 'std';

/**
 * Get the closure variables of a function.
 *
 * @param {Function} fn - The function to inspect
 * @returns {Record<string, any> | undefined} Object with variable names and values, or undefined if not a function
 */
export function getClosureVars(fn) {
    return std.getClosureVars(fn);
}

/**
 * Encode a value into tagged format.
 * @param {any} value
 * @param {Function} [replacer]
 * @param {WeakSet} [seenFunctions]
 * @returns {{ t: string, [key: string]: any }}
 */
function encode(value, replacer, seenFunctions = new WeakSet()) {
    // Try custom replacer first
    if (replacer) {
        const custom = replacer(value);
        if (custom !== undefined) {
            // Validate custom result has a type tag
            if (!custom || typeof custom.t !== 'string') {
                throw new Error('Replacer must return an object with a "t" property');
            }
            return custom;
        }
    }

    // Handle null
    if (value === null) {
        return { t: 'null' };
    }

    // Handle undefined
    if (value === undefined) {
        return { t: 'undefined' };
    }

    // Handle primitives
    const type = typeof value;
    if (type === 'boolean' || type === 'number' || type === 'string') {
        return { t: type, v: value };
    }

    // Handle functions
    if (type === 'function') {
        if (seenFunctions.has(value)) {
            throw new Error('Circular function reference detected');
        }
        seenFunctions.add(value);

        const code = value.toString();
        const rawClosureVars = std.getClosureVars(value) || {};
        const closureVars = {};

        for (const [name, v] of Object.entries(rawClosureVars)) {
            closureVars[name] = encode(v, replacer, seenFunctions);
        }

        return { t: 'function', code, closureVars };
    }

    // Handle arrays
    if (Array.isArray(value)) {
        return { t: 'array', v: value.map(v => encode(v, replacer, seenFunctions)) };
    }

    // Handle plain objects
    if (type === 'object') {
        const encoded = {};
        for (const [k, v] of Object.entries(value)) {
            encoded[k] = encode(v, replacer, seenFunctions);
        }
        return { t: 'object', v: encoded };
    }

    throw new Error(`Cannot serialize value of type ${type}`);
}

/**
 * Decode a tagged value back to its original form.
 * @param {{ t: string, [key: string]: any }} tagged
 * @param {Function} [reviver]
 * @returns {any}
 */
function decode(tagged, reviver) {
    if (!tagged || typeof tagged.t !== 'string') {
        throw new Error('Invalid tagged value: missing "t" property');
    }

    const { t: type, ...data } = tagged;

    // Try custom reviver first for non-builtin types
    if (reviver && !['null', 'undefined', 'boolean', 'number', 'string', 'array', 'object', 'function'].includes(type)) {
        const custom = reviver(type, data);
        if (custom !== undefined) {
            return custom;
        }
        throw new Error(`Unknown type "${type}" and reviver returned undefined`);
    }

    // Handle built-in types
    switch (type) {
        case 'null':
            return null;
        case 'undefined':
            return undefined;
        case 'boolean':
        case 'number':
        case 'string':
            return data.v;
        case 'array':
            return data.v.map(v => decode(v, reviver));
        case 'object': {
            const decoded = {};
            for (const [k, v] of Object.entries(data.v)) {
                decoded[k] = decode(v, reviver);
            }
            return decoded;
        }
        case 'function': {
            const closureVars = {};
            for (const [name, v] of Object.entries(data.closureVars)) {
                closureVars[name] = decode(v, reviver);
            }
            const varNames = Object.keys(closureVars);
            const varValues = Object.values(closureVars);
            const factory = new Function(...varNames, `return ${data.code}`);
            return factory(...varValues);
        }
        default:
            // Unknown type without reviver
            if (reviver) {
                const custom = reviver(type, data);
                if (custom !== undefined) {
                    return custom;
                }
            }
            throw new Error(`Unknown type "${type}"`);
    }
}

/**
 * Serialize a function including its closure variables.
 * Returns a JSON string with all values tagged by type.
 *
 * @param {Function} fn - The function to serialize
 * @param {{ replacer?: (value: any) => { t: string, [key: string]: any } | undefined }} [options]
 * @returns {string} JSON string
 * @throws {TypeError} If fn is not a function
 * @throws {Error} If circular function references are detected or values are not serializable
 */
export function serialize(fn, options = {}) {
    if (typeof fn !== 'function') {
        throw new TypeError('Expected a function');
    }
    const encoded = encode(fn, options.replacer);
    return JSON.stringify(encoded);
}

/**
 * Deserialize a function from its serialized string form.
 *
 * @param {string} str - The serialized string
 * @param {{ reviver?: (type: string, data: object) => any | undefined }} [options]
 * @returns {Function} The restored function
 * @throws {TypeError} If str is not a string
 * @throws {Error} If the format is invalid or types cannot be revived
 */
export function deserialize(str, options = {}) {
    if (typeof str !== 'string') {
        throw new TypeError('Expected a string');
    }
    const tagged = JSON.parse(str);
    return decode(tagged, options.reviver);
}

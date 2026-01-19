import * as std from 'std';

const FUNCTION_MARKER = '__serialized_function__';

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
 * Serialize a function including its closure variables.
 * Recursively serializes any function-valued closure variables.
 *
 * @param {Function} fn - The function to serialize
 * @returns {{ code: string, closureVars: Record<string, any> }} Serialized form
 * @throws {TypeError} If fn is not a function
 * @throws {Error} If circular function references are detected or closure vars are not serializable
 */
export function serialize(fn, _seen = new WeakSet()) {
    if (typeof fn !== 'function') {
        throw new TypeError('Expected a function');
    }

    if (_seen.has(fn)) {
        throw new Error('Circular function reference detected');
    }
    _seen.add(fn);

    const code = fn.toString();
    const rawClosureVars = std.getClosureVars(fn) || {};
    const closureVars = {};

    for (const [name, value] of Object.entries(rawClosureVars)) {
        if (typeof value === 'function') {
            closureVars[name] = {
                [FUNCTION_MARKER]: true,
                ...serialize(value, _seen)
            };
        } else {
            try {
                JSON.stringify(value);
            } catch (e) {
                throw new Error(`Closure variable '${name}' is not JSON-serializable: ${e.message}`);
            }
            closureVars[name] = value;
        }
    }

    return { code, closureVars };
}

/**
 * Deserialize a function from its serialized form.
 * Recursively deserializes any function-valued closure variables.
 *
 * @param {{ code: string, closureVars: Record<string, any> }} serialized
 * @returns {Function} The restored function
 * @throws {TypeError} If the serialized form is invalid
 */
export function deserialize({ code, closureVars }) {
    if (typeof code !== 'string') {
        throw new TypeError('Expected code to be a string');
    }
    if (typeof closureVars !== 'object' || closureVars === null) {
        throw new TypeError('Expected closureVars to be an object');
    }

    const resolvedClosureVars = {};
    for (const [name, value] of Object.entries(closureVars)) {
        if (value && typeof value === 'object' && value[FUNCTION_MARKER]) {
            const { [FUNCTION_MARKER]: _, ...funcData } = value;
            resolvedClosureVars[name] = deserialize(funcData);
        } else {
            resolvedClosureVars[name] = value;
        }
    }

    const varNames = Object.keys(resolvedClosureVars);
    const varValues = Object.values(resolvedClosureVars);

    const factory = new Function(...varNames, `return ${code}`);
    return factory(...varValues);
}

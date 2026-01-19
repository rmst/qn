import * as std from 'std';

const FUNCTION_MARKER = '__serialized_function__';

/**
 * Serialize a function including its closure variables.
 * Does not recursively serialize function-valued closure variables.
 *
 * @param {Function} fn - The function to serialize
 * @returns {{ code: string, closureVars: Record<string, any> }} Serialized form
 * @throws {Error} If the function or its closure variables cannot be serialized
 */
export function serializeFunction(fn) {
    if (typeof fn !== 'function') {
        throw new TypeError('Expected a function');
    }

    const code = fn.toString();
    const closureVars = std.getClosureVars(fn) || {};

    // Validate all closure variables are JSON-serializable
    for (const [name, value] of Object.entries(closureVars)) {
        try {
            JSON.stringify(value);
        } catch (e) {
            throw new Error(`Closure variable '${name}' is not JSON-serializable: ${e.message}`);
        }
    }

    return { code, closureVars };
}

/**
 * Serialize a function including its closure variables, recursively serializing
 * any function-valued closure variables.
 *
 * @param {Function} fn - The function to serialize
 * @param {WeakSet<Function>} [seen] - Set of already-serialized functions (cycle detection)
 * @returns {{ code: string, closureVars: Record<string, any> }} Serialized form
 * @throws {Error} If the function or its closure variables cannot be serialized
 */
export function serializeFunctionDeep(fn, seen = new WeakSet()) {
    if (typeof fn !== 'function') {
        throw new TypeError('Expected a function');
    }

    if (seen.has(fn)) {
        throw new Error('Circular function reference detected');
    }
    seen.add(fn);

    const code = fn.toString();
    const rawClosureVars = std.getClosureVars(fn) || {};
    const closureVars = {};

    for (const [name, value] of Object.entries(rawClosureVars)) {
        if (typeof value === 'function') {
            // Recursively serialize function-valued closure variables
            closureVars[name] = {
                [FUNCTION_MARKER]: true,
                ...serializeFunctionDeep(value, seen)
            };
        } else {
            // Validate non-function values are JSON-serializable
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
 *
 * @param {{ code: string, closureVars: Record<string, any> }} serialized
 * @returns {Function} The restored function
 */
export function deserializeFunction({ code, closureVars }) {
    if (typeof code !== 'string') {
        throw new TypeError('Expected code to be a string');
    }
    if (typeof closureVars !== 'object' || closureVars === null) {
        throw new TypeError('Expected closureVars to be an object');
    }

    const varNames = Object.keys(closureVars);
    const varValues = Object.values(closureVars);

    // Create a factory function that defines closure vars and returns the original function
    // Using Function constructor: new Function(arg1, arg2, ..., body)
    // The body returns the serialized function code, which will have access to the args
    const factory = new Function(...varNames, `return ${code}`);
    return factory(...varValues);
}

/**
 * Deserialize a function from its serialized form, recursively deserializing
 * any function-valued closure variables.
 *
 * @param {{ code: string, closureVars: Record<string, any> }} serialized
 * @returns {Function} The restored function
 */
export function deserializeFunctionDeep({ code, closureVars }) {
    if (typeof code !== 'string') {
        throw new TypeError('Expected code to be a string');
    }
    if (typeof closureVars !== 'object' || closureVars === null) {
        throw new TypeError('Expected closureVars to be an object');
    }

    // Recursively deserialize function-valued closure variables
    const resolvedClosureVars = {};
    for (const [name, value] of Object.entries(closureVars)) {
        if (value && typeof value === 'object' && value[FUNCTION_MARKER]) {
            // This is a serialized function - deserialize it recursively
            const { [FUNCTION_MARKER]: _, ...funcData } = value;
            resolvedClosureVars[name] = deserializeFunctionDeep(funcData);
        } else {
            resolvedClosureVars[name] = value;
        }
    }

    const varNames = Object.keys(resolvedClosureVars);
    const varValues = Object.values(resolvedClosureVars);

    const factory = new Function(...varNames, `return ${code}`);
    return factory(...varValues);
}

/**
 * Serialize a function to a JSON string.
 *
 * @param {Function} fn - The function to serialize
 * @returns {string} JSON string representation
 */
export function stringifyFunction(fn) {
    return JSON.stringify(serializeFunction(fn));
}

/**
 * Deserialize a function from a JSON string.
 *
 * @param {string} json - The JSON string
 * @returns {Function} The restored function
 */
export function parseFunction(json) {
    return deserializeFunction(JSON.parse(json));
}

/**
 * Serialize a function to a JSON string, recursively serializing nested functions.
 *
 * @param {Function} fn - The function to serialize
 * @returns {string} JSON string representation
 */
export function stringifyFunctionDeep(fn) {
    return JSON.stringify(serializeFunctionDeep(fn));
}

/**
 * Deserialize a function from a JSON string, recursively deserializing nested functions.
 *
 * @param {string} json - The JSON string
 * @returns {Function} The restored function
 */
export function parseFunctionDeep(json) {
    return deserializeFunctionDeep(JSON.parse(json));
}

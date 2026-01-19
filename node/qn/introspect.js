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
 * Re-indent code to match target indentation.
 * @param {string} code
 * @param {string} targetIndent
 * @returns {string}
 */
function reindent(code, targetIndent) {
    const lines = code.split('\n');
    if (lines.length === 1) return code;

    // Find minimum indentation (ignoring empty lines and first line)
    let minIndent = Infinity;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') continue;
        const match = line.match(/^(\s*)/);
        if (match && match[1].length < minIndent) {
            minIndent = match[1].length;
        }
    }
    if (minIndent === Infinity) minIndent = 0;

    // Re-indent: strip base indent, add target indent
    return lines.map((line, i) => {
        if (i === 0) return line;
        if (line.trim() === '') return '';
        return targetIndent + line.slice(minIndent);
    }).join('\n');
}

/**
 * Convert a value to JavaScript source code.
 * @param {any} value
 * @param {string} indent
 * @param {WeakSet} seenFunctions
 * @returns {string}
 */
function toSource(value, indent = '', seenFunctions = new WeakSet()) {
    // Handle null
    if (value === null) {
        return 'null';
    }

    // Handle undefined
    if (value === undefined) {
        return 'undefined';
    }

    const type = typeof value;

    // Handle primitives
    if (type === 'boolean' || type === 'number') {
        return String(value);
    }

    if (type === 'string') {
        return JSON.stringify(value);
    }

    if (type === 'bigint') {
        return `${value}n`;
    }

    if (type === 'symbol') {
        throw new Error('Symbol cannot be converted to source');
    }

    // Handle functions
    if (type === 'function') {
        if (seenFunctions.has(value)) {
            throw new Error('Circular function reference detected');
        }
        seenFunctions.add(value);

        const code = value.toString();
        const closureVars = std.getClosureVars(value) || {};
        const varNames = Object.keys(closureVars);

        // No closure vars - just return the function code
        if (varNames.length === 0) {
            return code;
        }

        // Has closure vars - wrap in IIFE
        const innerIndent = indent + '  ';
        const reindentedCode = reindent(code, innerIndent);
        let result = '(() => {\n';
        for (const name of varNames) {
            let varSource = toSource(closureVars[name], innerIndent, seenFunctions);
            // Reindent multi-line values for proper alignment
            if (varSource.includes('\n')) {
                varSource = reindent(varSource, innerIndent);
            }
            result += `${innerIndent}let ${name} = ${varSource};\n`;
        }
        result += `${innerIndent}return ${reindentedCode};\n`;
        result += `${indent}})()`;
        return result;
    }

    // Handle arrays
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return '[]';
        }
        const innerIndent = indent + '  ';
        const items = value.map(v => toSource(v, innerIndent, seenFunctions));
        // Simple arrays on one line, complex on multiple
        const oneLine = '[' + items.join(', ') + ']';
        if (oneLine.length < 60 && !oneLine.includes('\n')) {
            return oneLine;
        }
        return '[\n' + items.map(item => innerIndent + item).join(',\n') + '\n' + indent + ']';
    }

    // Handle plain objects only - reject other object types
    if (type === 'object') {
        const proto = Object.getPrototypeOf(value);
        if (proto !== null && proto !== Object.prototype) {
            const name = value.constructor?.name || 'object';
            throw new Error(`${name} cannot be converted to source`);
        }
        const entries = Object.entries(value);
        if (entries.length === 0) {
            return '{}';
        }
        const innerIndent = indent + '  ';
        const props = entries.map(([k, v]) => {
            const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
            const valSource = toSource(v, innerIndent, seenFunctions);
            return `${key}: ${valSource}`;
        });
        // Simple objects on one line, complex on multiple
        const oneLine = '{ ' + props.join(', ') + ' }';
        if (oneLine.length < 60 && !oneLine.includes('\n')) {
            return oneLine;
        }
        return '{\n' + props.map(prop => innerIndent + prop).join(',\n') + '\n' + indent + '}';
    }

    throw new Error(`Cannot convert value of type ${type} to source`);
}

/**
 * Convert a function to standalone JavaScript source code.
 * The returned code, when evaluated, produces the function with all
 * closure variables embedded.
 *
 * @param {Function} fn - The function to convert
 * @returns {string} JavaScript source code
 * @throws {TypeError} If fn is not a function
 * @throws {Error} If circular function references are detected or values cannot be converted
 */
export function closureToSource(fn) {
    if (typeof fn !== 'function') {
        throw new TypeError('Expected a function');
    }
    return toSource(fn);
}

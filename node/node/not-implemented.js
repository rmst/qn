/**
 * Helper for unimplemented node:* module stubs.
 * Throws a NodeCompatibilityError with a clear message at import time.
 */
import { NodeCompatibilityError } from './errors.js'
export { NodeCompatibilityError }

export function notImplemented(moduleName) {
	throw new NodeCompatibilityError(
		`"${moduleName}" is not implemented in qn. See https://github.com/rmst/qn/blob/main/node/node-compatibility.md for supported modules.`
	)
}

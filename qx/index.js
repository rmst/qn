/**
 * qx - Minimal zx-compatible shell scripting for QuickJS
 *
 * @example
 * import { $ } from 'qx'
 * const result = await $`echo "Hello"`
 */

export { $, ProcessPromise, ProcessOutput, glob, retry } from './core.js'
export { default } from './core.js'

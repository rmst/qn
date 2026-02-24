/*
 * Qn Sandbox - Sandboxed Worker Implementation
 *
 * Provides os.SandboxedWorker class for running JavaScript code in a
 * restricted environment without access to std/os modules.
 *
 * Features:
 * - No std or os modules (pure JavaScript only)
 * - Optional module imports (can be disabled)
 * - Memory and stack limits
 * - CPU timeout via interrupt handler
 * - Communication via postMessage/onmessage only
 */

#ifndef SANDBOXED_WORKER_H
#define SANDBOXED_WORKER_H

#include "quickjs/quickjs.h"

#ifdef USE_SANDBOX

/*
 * Accessor for the port_list in JSThreadState.
 * Defined in quickjs-libc.c to avoid exposing internal structure layout.
 *
 * @param rt - JSRuntime to get the port list from
 * @return Pointer to the port_list, or NULL if thread state not initialized
 */
struct list_head *js_std_get_port_list(JSRuntime *rt);

/*
 * Initialize the SandboxedWorker class and add it to the os module.
 * Called from quickjs-libc.c during os module initialization.
 *
 * @param ctx - JSContext for the module
 * @param m - The os module definition
 */
void js_sandbox_init(JSContext *ctx, JSModuleDef *m);

/*
 * Add the SandboxedWorker export to the os module.
 * Called during module export setup.
 *
 * @param ctx - JSContext for the module
 * @param m - The os module definition
 */
void js_sandbox_add_export(JSContext *ctx, JSModuleDef *m);

/*
 * Set the function used to create new contexts for sandboxed workers.
 * This allows the caller to customize context creation (e.g., for NODE_PATH).
 *
 * @param func - Function pointer that creates a new JSContext from a JSRuntime
 */
void js_sandbox_set_context_func(JSContext *(*func)(JSRuntime *rt));

#endif /* USE_SANDBOX */

#endif /* SANDBOXED_WORKER_H */

/*
 * qn-worker.h - Web Worker API backed by libuv threads + socketpair
 *
 * Each worker gets its own JSRuntime, JSContext, and uv_loop_t on a
 * dedicated thread. Communication uses length-prefixed messages over
 * uv_socketpair() pipes, serialized with JS_WriteObject2/JS_ReadObject2.
 */

#ifndef QN_WORKER_H
#define QN_WORKER_H

#include "quickjs/quickjs.h"

/*
 * Callbacks the generated main() uses to tell the worker module how to
 * configure a fresh runtime and create a context with embedded modules.
 *
 * rt_init:    configure a fresh JSRuntime (handlers, module loader)
 * ctx_init:   create a JSContext with intrinsics and embedded modules registered
 * ctx_setup:  post-init context setup (eval node-globals, source transform, etc.)
 */
typedef void (*qn_worker_runtime_init_fn)(JSRuntime *rt);
typedef JSContext *(*qn_worker_context_init_fn)(JSRuntime *rt);
typedef void (*qn_worker_context_setup_fn)(JSContext *ctx);

/*
 * Store the runtime/context/setup factory functions.
 * Called once from main() before any workers are created.
 */
void qn_worker_set_init(qn_worker_runtime_init_fn rt_init,
                         qn_worker_context_init_fn ctx_init,
                         qn_worker_context_setup_fn ctx_setup);

/*
 * Module init function for the qn_worker native module.
 * Exports: _create, _postMessage, _terminate
 */
JSModuleDef *js_init_module_qn_worker(JSContext *ctx, const char *module_name);

#endif /* QN_WORKER_H */

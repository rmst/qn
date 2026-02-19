/*
 * qn-vm.h - Event loop ownership, eval, and core async primitives
 *
 * Owns the libuv event loop and provides setTimeout/clearTimeout and
 * setReadHandler/setWriteHandler backed by uv_timer_t and uv_poll_t.
 * Also provides qn_vm_eval_binary/qn_vm_loop as replacements for
 * js_std_eval_binary/js_std_loop, using the three-handle pattern
 * (uv_prepare + uv_idle + uv_check) for microtask draining.
 */

#ifndef QN_VM_H
#define QN_VM_H

#include "quickjs/quickjs.h"

/*
 * Initialize the event loop. Must be called after JS_NewContext()
 * and before qn_vm_eval_binary().
 *
 * - Allocates the uv_loop_t
 * - Initializes the three-handle pattern (prepare/idle/check)
 * - Sets up promise rejection tracking
 */
void qn_vm_init(JSContext *ctx);

/*
 * Clean up the event loop. Must be called before JS_FreeContext().
 *
 * - Frees all timers and poll handles
 * - Closes three-handle pattern handles
 * - Closes and frees the uv_loop_t
 */
void qn_vm_free(JSRuntime *rt);

/*
 * Evaluate pre-compiled bytecode. Replacement for js_std_eval_binary().
 *
 * If load_only is true, registers the module but doesn't execute it.
 * If load_only is false, evaluates the module/script.
 *
 * Unlike js_std_eval_binary, does NOT call js_std_await — promise
 * resolution happens in qn_vm_loop via the three-handle pattern.
 */
void qn_vm_eval_binary(JSContext *ctx, const uint8_t *buf, size_t buf_len,
                        int load_only);

/*
 * Evaluate a pre-compiled JSON module. Replacement for js_std_eval_binary_json_module().
 */
void qn_vm_eval_binary_json_module(JSContext *ctx,
                                    const uint8_t *buf, size_t buf_len,
                                    const char *module_name);

/*
 * Run the event loop until all handles are closed and no jobs remain.
 * Replacement for js_std_loop().
 *
 * Uses uv_run(UV_RUN_DEFAULT) with the three-handle pattern to drain
 * JS microtasks between I/O polls.
 */
void qn_vm_loop(JSContext *ctx);

/*
 * Module init function for the qn_vm native module.
 * Exports: setTimeout, clearTimeout, setReadHandler, setWriteHandler
 */
JSModuleDef *js_init_module_qn_vm(JSContext *ctx, const char *module_name);

#endif /* QN_VM_H */

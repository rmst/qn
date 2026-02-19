/*
 * qn-vm.h - Event loop ownership and core async primitives
 *
 * Owns the libuv event loop and provides setTimeout/clearTimeout and
 * setReadHandler/setWriteHandler backed by uv_timer_t and uv_poll_t.
 * Replaces quickjs-libc.c's select()-based event loop with uv_run.
 */

#ifndef QN_VM_H
#define QN_VM_H

#include "quickjs/quickjs.h"

/*
 * Initialize the event loop. Must be called after js_std_init_handlers()
 * and before js_std_eval_binary().
 *
 * - Allocates the uv_loop_t
 * - Installs the uv_run-based poll function via js_set_os_poll_func()
 */
void qn_vm_init(JSContext *ctx);

/*
 * Clean up the event loop. Must be called before js_std_free_handlers().
 *
 * - Frees all timers and poll handles
 * - Closes and frees the uv_loop_t
 */
void qn_vm_free(JSRuntime *rt);

/*
 * Module init function for the qn_vm native module.
 * Exports: setTimeout, clearTimeout, setReadHandler, setWriteHandler
 */
JSModuleDef *js_init_module_qn_vm(JSContext *ctx, const char *module_name);

#endif /* QN_VM_H */

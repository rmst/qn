/*
 * qn-uv-utils - Shared utility infrastructure for libuv-based native modules
 *
 * Adapted from txiki.js by Saul Ibarra Corretge
 * Copyright (c) 2019-present Saul Ibarra Corretge <s@saghul.net>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

#ifndef QN_UV_UTILS_H
#define QN_UV_UTILS_H

#include "quickjs/quickjs.h"
#include "quickjs/cutils.h"
#include <uv.h>
#include <stdbool.h>
#include <stdlib.h>

/* --------------------------------------------------------------------------
 * CHECK macros — assertion helpers with file/line info
 * -------------------------------------------------------------------------- */

#define QN__STRINGIFY_(x)  #x
#define QN__STRINGIFY(x)   QN__STRINGIFY_(x)

#ifdef __GNUC__
#define QN__LIKELY(expr)          __builtin_expect(!!(expr), 1)
#define QN__UNLIKELY(expr)        __builtin_expect(!!(expr), 0)
#define QN__PRETTY_FUNCTION_NAME  __PRETTY_FUNCTION__
#else
#define QN__LIKELY(expr)          expr
#define QN__UNLIKELY(expr)        expr
#define QN__PRETTY_FUNCTION_NAME  ""
#endif

struct QNAssertionInfo {
	const char *file_line;
	const char *message;
	const char *function;
};

void qn_assert(const struct QNAssertionInfo info);

#define QN__ERROR_AND_ABORT(expr) \
	do { \
		static const struct QNAssertionInfo args = { \
			__FILE__ ":" QN__STRINGIFY(__LINE__), #expr, QN__PRETTY_FUNCTION_NAME \
		}; \
		qn_assert(args); \
	} while (0)

#define QN_CHECK(expr) \
	do { \
		if (QN__UNLIKELY(!(expr))) { \
			QN__ERROR_AND_ABORT(expr); \
		} \
	} while (0)

#define QN_CHECK_EQ(a, b)       QN_CHECK((a) == (b))
#define QN_CHECK_GE(a, b)       QN_CHECK((a) >= (b))
#define QN_CHECK_GT(a, b)       QN_CHECK((a) > (b))
#define QN_CHECK_LE(a, b)       QN_CHECK((a) <= (b))
#define QN_CHECK_LT(a, b)       QN_CHECK((a) < (b))
#define QN_CHECK_NE(a, b)       QN_CHECK((a) != (b))
#define QN_CHECK_NULL(val)      QN_CHECK((val) == NULL)
#define QN_CHECK_NOT_NULL(val)  QN_CHECK((val) != NULL)

/* --------------------------------------------------------------------------
 * Promise helpers
 * -------------------------------------------------------------------------- */

typedef struct {
	JSValue p;
	JSValue rfuncs[2];
} QNPromise;

JSValue qn_promise_init(JSContext *ctx, QNPromise *p);
bool qn_promise_is_pending(JSContext *ctx, QNPromise *p);
void qn_promise_free(JSContext *ctx, QNPromise *p);
void qn_promise_free_rt(JSRuntime *rt, QNPromise *p);
void qn_promise_clear(JSContext *ctx, QNPromise *p);
void qn_promise_mark(JSRuntime *rt, QNPromise *p, JS_MarkFunc *mark_func);
void qn_promise_settle(JSContext *ctx, QNPromise *p, bool is_reject, int argc, JSValue *argv);
void qn_promise_resolve(JSContext *ctx, QNPromise *p, int argc, JSValue *argv);
void qn_promise_reject(JSContext *ctx, QNPromise *p, int argc, JSValue *argv);
JSValue qn_new_resolved_promise(JSContext *ctx, int argc, JSValue *argv);
JSValue qn_new_rejected_promise(JSContext *ctx, int argc, JSValue *argv);

/* --------------------------------------------------------------------------
 * Error helpers
 * -------------------------------------------------------------------------- */

/* Create an error object from a uv errno (e.g. UV_ENOENT).
 * Sets message (e.g. "ENOENT: no such file or directory"),
 * code (e.g. "ENOENT"), and errno (the numeric value). */
JSValue qn_new_error(JSContext *ctx, int err);

/* Create and throw a uv error. */
JSValue qn_throw_errno(JSContext *ctx, int err);

/* Create a Node.js-style fs error with message, code, errno, syscall,
 * and optionally path properties. Pass NULL for path to omit it. */
JSValue qn_new_fs_error(JSContext *ctx, int err, const char *syscall, const char *path);

/* --------------------------------------------------------------------------
 * Uint8Array helper
 * -------------------------------------------------------------------------- */

/* Create a Uint8Array wrapping data allocated with js_malloc.
 * The data will be freed with js_free_rt when the buffer is collected. */
JSValue qn_new_uint8array(JSContext *ctx, uint8_t *data, size_t size);

/* --------------------------------------------------------------------------
 * Loop accessor (defined in quickjs-libc.c via libuv.patch)
 * -------------------------------------------------------------------------- */

extern uv_loop_t *js_uv_loop(JSContext *ctx);

/* --------------------------------------------------------------------------
 * Convenience macros for JSCFunctionListEntry definitions
 * -------------------------------------------------------------------------- */

#define QN_CFUNC_DEF(name, length, func1) \
	{ name, JS_PROP_C_W_E, JS_DEF_CFUNC, 0, \
	  .u = { .func = { length, JS_CFUNC_generic, { .generic = func1 } } } }

#define QN_CFUNC_MAGIC_DEF(name, length, func1, magic) \
	{ name, JS_PROP_C_W_E, JS_DEF_CFUNC, magic, \
	  .u = { .func = { length, JS_CFUNC_generic_magic, { .generic_magic = func1 } } } }

#define QN_CGETSET_DEF(name, fgetter, fsetter) \
	{ name, JS_PROP_CONFIGURABLE, JS_DEF_CGETSET, 0, \
	  .u = { .getset = { .get = { .getter = fgetter }, .set = { .setter = fsetter } } } }

#define QN_UVCONST(x)  JS_PROP_INT32_DEF(#x, UV_##x, JS_PROP_ENUMERABLE)
#define QN_CONST(x)    JS_PROP_INT32_DEF(#x, x, JS_PROP_ENUMERABLE)
#define QN_CONST2(name, val) JS_PROP_INT32_DEF(name, val, JS_PROP_ENUMERABLE)

/* --------------------------------------------------------------------------
 * Address helpers (for networking)
 * -------------------------------------------------------------------------- */

/* Parse a JS object { ip: "...", port: N } into a sockaddr_storage.
 * Returns 0 on success, -1 on error (throws a JS exception). */
int qn_obj2addr(JSContext *ctx, JSValue obj, struct sockaddr_storage *ss);

/* Populate a JS object with family, ip, port (and flowInfo/scopeId for IPv6)
 * from a sockaddr. If skip_port is true, port is omitted. */
void qn_addr2obj(JSContext *ctx, JSValue obj, const struct sockaddr *sa, bool skip_port);

/* --------------------------------------------------------------------------
 * Signal map (signal name <-> number conversion)
 * -------------------------------------------------------------------------- */

extern const char *qn_signal_map[];
extern size_t qn_signal_map_count;

/* Return the signal name for a signal number, or NULL if unknown. */
const char *qn_getsig(int sig);

/* Return the signal number for a signal name, or -1 if unknown. */
int qn_getsignum(const char *sig_str);

/* --------------------------------------------------------------------------
 * call_handler wrapper
 * -------------------------------------------------------------------------- */

/* Call a JS function safely: dups func before calling (in case the handler
 * frees itself during execution) and dumps any exception to stderr. */
void qn_call_handler(JSContext *ctx, JSValue func, int argc, JSValue *argv);

/* --------------------------------------------------------------------------
 * Error dump helpers
 * -------------------------------------------------------------------------- */

void qn_dump_error(JSContext *ctx);
void qn_dump_error1(JSContext *ctx, JSValue exception_val);

/* --------------------------------------------------------------------------
 * JS array ↔ C string array helpers
 * -------------------------------------------------------------------------- */

/* Convert a JS array of strings to a NULL-terminated C string array.
 * Each element is obtained via JS_ToCString (must be freed with JS_FreeCString).
 * The array itself is allocated with js_malloc. Returns NULL on error.
 * If out_count is non-NULL, it receives the number of strings (excluding NULL). */
char **qn_js_strings(JSContext *ctx, JSValue arr, int *out_count);

/* Free a string array returned by qn_js_strings. */
void qn_free_strings(JSContext *ctx, char **strs, int count);

#endif /* QN_UV_UTILS_H */

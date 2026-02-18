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

#include "qn-uv-utils.h"

#include <stdio.h>
#include <string.h>
#include <signal.h>

/* ==========================================================================
 * CHECK macros — assertion implementation
 * ========================================================================== */

void qn_assert(const struct QNAssertionInfo info) {
	fprintf(stderr,
		"%s:%s%s Assertion `%s' failed.\n",
		info.file_line,
		info.function,
		*info.function ? ":" : "",
		info.message);
	fflush(stderr);
	abort();
}

/* ==========================================================================
 * Error dump helpers
 * ========================================================================== */

static void qn__dump_obj(JSContext *ctx, FILE *f, JSValue val) {
	const char *str = JS_ToCString(ctx, val);
	if (str) {
		fprintf(f, "%s\n", str);
		JS_FreeCString(ctx, str);
	} else {
		fprintf(f, "[exception]\n");
	}
}

void qn_dump_error(JSContext *ctx) {
	JSValue exception_val = JS_GetException(ctx);
	qn_dump_error1(ctx, exception_val);
	JS_FreeValue(ctx, exception_val);
}

void qn_dump_error1(JSContext *ctx, JSValue exception_val) {
	int is_error = JS_IsError(ctx, exception_val);
	qn__dump_obj(ctx, stderr, exception_val);
	if (is_error) {
		JSValue val = JS_GetPropertyStr(ctx, exception_val, "stack");
		if (!JS_IsUndefined(val)) {
			qn__dump_obj(ctx, stderr, val);
		}
		JS_FreeValue(ctx, val);
	}
	fflush(stderr);
}

/* ==========================================================================
 * Promise helpers
 * ========================================================================== */

JSValue qn_promise_init(JSContext *ctx, QNPromise *p) {
	JSValue rfuncs[2];
	p->p = JS_NewPromiseCapability(ctx, rfuncs);
	if (JS_IsException(p->p)) {
		return JS_EXCEPTION;
	}
	p->rfuncs[0] = rfuncs[0];
	p->rfuncs[1] = rfuncs[1];
	return JS_DupValue(ctx, p->p);
}

bool qn_promise_is_pending(JSContext *ctx, QNPromise *p) {
	return !JS_IsUndefined(p->p);
}

void qn_promise_free(JSContext *ctx, QNPromise *p) {
	JS_FreeValue(ctx, p->rfuncs[0]);
	JS_FreeValue(ctx, p->rfuncs[1]);
	JS_FreeValue(ctx, p->p);
}

void qn_promise_free_rt(JSRuntime *rt, QNPromise *p) {
	JS_FreeValueRT(rt, p->rfuncs[0]);
	JS_FreeValueRT(rt, p->rfuncs[1]);
	JS_FreeValueRT(rt, p->p);
}

void qn_promise_clear(JSContext *ctx, QNPromise *p) {
	p->p = JS_UNDEFINED;
	p->rfuncs[0] = JS_UNDEFINED;
	p->rfuncs[1] = JS_UNDEFINED;
}

void qn_promise_mark(JSRuntime *rt, QNPromise *p, JS_MarkFunc *mark_func) {
	JS_MarkValue(rt, p->p, mark_func);
	JS_MarkValue(rt, p->rfuncs[0], mark_func);
	JS_MarkValue(rt, p->rfuncs[1], mark_func);
}

void qn_promise_settle(JSContext *ctx, QNPromise *p, bool is_reject, int argc, JSValue *argv) {
	JSValue ret = JS_Call(ctx, p->rfuncs[is_reject], JS_UNDEFINED, argc, argv);
	for (int i = 0; i < argc; i++) {
		JS_FreeValue(ctx, argv[i]);
	}
	JS_FreeValue(ctx, ret);
	/* Free all three values (rfuncs + promise). Don't call qn_promise_free
	 * separately — that would double-free rfuncs[0] and rfuncs[1]. */
	JS_FreeValue(ctx, p->rfuncs[0]);
	JS_FreeValue(ctx, p->rfuncs[1]);
	JS_FreeValue(ctx, p->p);
}

void qn_promise_resolve(JSContext *ctx, QNPromise *p, int argc, JSValue *argv) {
	qn_promise_settle(ctx, p, false, argc, argv);
}

void qn_promise_reject(JSContext *ctx, QNPromise *p, int argc, JSValue *argv) {
	qn_promise_settle(ctx, p, true, argc, argv);
}

static inline JSValue qn__settled_promise(JSContext *ctx, bool is_reject, int argc, JSValue *argv) {
	JSValue promise, resolving_funcs[2], ret;

	promise = JS_NewPromiseCapability(ctx, resolving_funcs);
	if (JS_IsException(promise)) {
		return JS_EXCEPTION;
	}

	ret = JS_Call(ctx, resolving_funcs[is_reject], JS_UNDEFINED, argc, argv);

	for (int i = 0; i < argc; i++) {
		JS_FreeValue(ctx, argv[i]);
	}
	JS_FreeValue(ctx, ret);
	JS_FreeValue(ctx, resolving_funcs[0]);
	JS_FreeValue(ctx, resolving_funcs[1]);

	return promise;
}

JSValue qn_new_resolved_promise(JSContext *ctx, int argc, JSValue *argv) {
	return qn__settled_promise(ctx, false, argc, argv);
}

JSValue qn_new_rejected_promise(JSContext *ctx, int argc, JSValue *argv) {
	return qn__settled_promise(ctx, true, argc, argv);
}

/* ==========================================================================
 * Error helpers
 * ========================================================================== */

JSValue qn_new_error(JSContext *ctx, int err) {
	char buf[256];
	JSValue obj;

	snprintf(buf, sizeof(buf), "%s: %s", uv_err_name(err), uv_strerror(err));

	obj = JS_NewError(ctx);
	JS_DefinePropertyValueStr(ctx, obj, "message",
		JS_NewString(ctx, buf),
		JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	JS_DefinePropertyValueStr(ctx, obj, "code",
		JS_NewString(ctx, uv_err_name(err)),
		JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	JS_DefinePropertyValueStr(ctx, obj, "errno",
		JS_NewInt32(ctx, err),
		JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);

	return obj;
}

JSValue qn_throw_errno(JSContext *ctx, int err) {
	JSValue obj;
	obj = qn_new_error(ctx, err);
	if (JS_IsException(obj)) {
		obj = JS_NULL;
	}
	return JS_Throw(ctx, obj);
}

JSValue qn_new_fs_error(JSContext *ctx, int err, const char *syscall, const char *path) {
	char buf[512];
	JSValue obj;

	if (path) {
		snprintf(buf, sizeof(buf), "%s: %s, %s '%s'",
			uv_err_name(err), uv_strerror(err), syscall, path);
	} else {
		snprintf(buf, sizeof(buf), "%s: %s, %s",
			uv_err_name(err), uv_strerror(err), syscall);
	}

	obj = JS_NewError(ctx);
	JS_DefinePropertyValueStr(ctx, obj, "message",
		JS_NewString(ctx, buf),
		JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	JS_DefinePropertyValueStr(ctx, obj, "code",
		JS_NewString(ctx, uv_err_name(err)),
		JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	JS_DefinePropertyValueStr(ctx, obj, "errno",
		JS_NewInt32(ctx, err),
		JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	JS_DefinePropertyValueStr(ctx, obj, "syscall",
		JS_NewString(ctx, syscall),
		JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	if (path) {
		JS_DefinePropertyValueStr(ctx, obj, "path",
			JS_NewString(ctx, path),
			JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	}

	return obj;
}

/* ==========================================================================
 * Uint8Array helper
 * ========================================================================== */

static void qn__buf_free(JSRuntime *rt, void *opaque, void *ptr) {
	js_free_rt(rt, ptr);
}

JSValue qn_new_uint8array(JSContext *ctx, uint8_t *data, size_t size) {
	JSValue abuf, u8arr, args[3];

	/* Create an ArrayBuffer that wraps the data with our free callback */
	abuf = JS_NewArrayBuffer(ctx, data, size, qn__buf_free, NULL, false);
	if (JS_IsException(abuf))
		return JS_EXCEPTION;

	/* Create Uint8Array from the ArrayBuffer */
	args[0] = abuf;
	args[1] = JS_NewInt32(ctx, 0);
	args[2] = JS_NewInt64(ctx, size);

	JSValue global = JS_GetGlobalObject(ctx);
	JSValue uint8array_ctor = JS_GetPropertyStr(ctx, global, "Uint8Array");
	u8arr = JS_CallConstructor(ctx, uint8array_ctor, 3, args);

	JS_FreeValue(ctx, uint8array_ctor);
	JS_FreeValue(ctx, global);
	JS_FreeValue(ctx, abuf);
	JS_FreeValue(ctx, args[1]);
	JS_FreeValue(ctx, args[2]);

	return u8arr;
}

/* ==========================================================================
 * Address helpers
 * ========================================================================== */

int qn_obj2addr(JSContext *ctx, JSValue obj, struct sockaddr_storage *ss) {
	JSValue js_ip;
	JSValue js_port;
	const char *ip;
	uint32_t port = 0;
	int r;
	int ret = 0;

	js_ip = JS_GetPropertyStr(ctx, obj, "ip");
	ip = JS_ToCString(ctx, js_ip);
	JS_FreeValue(ctx, js_ip);
	if (!ip) {
		return -1;
	}

	js_port = JS_GetPropertyStr(ctx, obj, "port");
	r = JS_ToUint32(ctx, &port, js_port);
	JS_FreeValue(ctx, js_port);
	if (r != 0) {
		ret = -1;
		goto end;
	}

	memset(ss, 0, sizeof(*ss));

	if (uv_inet_pton(AF_INET, ip, &((struct sockaddr_in *) ss)->sin_addr) == 0) {
		ss->ss_family = AF_INET;
		((struct sockaddr_in *) ss)->sin_port = htons(port);
	} else if (uv_inet_pton(AF_INET6, ip, &((struct sockaddr_in6 *) ss)->sin6_addr) == 0) {
		ss->ss_family = AF_INET6;
		((struct sockaddr_in6 *) ss)->sin6_port = htons(port);
	} else {
		qn_throw_errno(ctx, UV_EAFNOSUPPORT);
		ret = -1;
	}

end:
	JS_FreeCString(ctx, ip);
	return ret;
}

void qn_addr2obj(JSContext *ctx, JSValue obj, const struct sockaddr *sa, bool skip_port) {
	char buf[INET6_ADDRSTRLEN + 1];

	switch (sa->sa_family) {
		case AF_INET: {
			struct sockaddr_in *addr4 = (struct sockaddr_in *) sa;
			uv_ip4_name(addr4, buf, sizeof(buf));

			JS_DefinePropertyValueStr(ctx, obj, "family",
				JS_NewInt32(ctx, 4), JS_PROP_C_W_E);
			JS_DefinePropertyValueStr(ctx, obj, "ip",
				JS_NewString(ctx, buf), JS_PROP_C_W_E);
			if (!skip_port) {
				JS_DefinePropertyValueStr(ctx, obj, "port",
					JS_NewInt32(ctx, ntohs(addr4->sin_port)), JS_PROP_C_W_E);
			}

			break;
		}

		case AF_INET6: {
			struct sockaddr_in6 *addr6 = (struct sockaddr_in6 *) sa;
			uv_ip6_name(addr6, buf, sizeof(buf));

			JS_DefinePropertyValueStr(ctx, obj, "family",
				JS_NewInt32(ctx, 6), JS_PROP_C_W_E);
			JS_DefinePropertyValueStr(ctx, obj, "ip",
				JS_NewString(ctx, buf), JS_PROP_C_W_E);
			if (!skip_port) {
				JS_DefinePropertyValueStr(ctx, obj, "port",
					JS_NewInt32(ctx, ntohs(addr6->sin6_port)), JS_PROP_C_W_E);
			}
			JS_DefinePropertyValueStr(ctx, obj, "flowInfo",
				JS_NewInt32(ctx, ntohl(addr6->sin6_flowinfo)), JS_PROP_C_W_E);
			JS_DefinePropertyValueStr(ctx, obj, "scopeId",
				JS_NewInt32(ctx, addr6->sin6_scope_id), JS_PROP_C_W_E);

			break;
		}
	}
}

/* ==========================================================================
 * Signal map
 * ========================================================================== */

const char *qn_signal_map[] = {
#ifdef SIGHUP
	[SIGHUP] = "SIGHUP",
#endif
#ifdef SIGINT
	[SIGINT] = "SIGINT",
#endif
#ifdef SIGQUIT
	[SIGQUIT] = "SIGQUIT",
#endif
#ifdef SIGILL
	[SIGILL] = "SIGILL",
#endif
#ifdef SIGTRAP
	[SIGTRAP] = "SIGTRAP",
#endif
#ifdef SIGABRT
	[SIGABRT] = "SIGABRT",
#endif
#ifdef SIGBUS
	[SIGBUS] = "SIGBUS",
#endif
#ifdef SIGFPE
	[SIGFPE] = "SIGFPE",
#endif
#ifdef SIGKILL
	[SIGKILL] = "SIGKILL",
#endif
#ifdef SIGUSR1
	[SIGUSR1] = "SIGUSR1",
#endif
#ifdef SIGSEGV
	[SIGSEGV] = "SIGSEGV",
#endif
#ifdef SIGUSR2
	[SIGUSR2] = "SIGUSR2",
#endif
#ifdef SIGPIPE
	[SIGPIPE] = "SIGPIPE",
#endif
#ifdef SIGALRM
	[SIGALRM] = "SIGALRM",
#endif
#ifdef SIGTERM
	[SIGTERM] = "SIGTERM",
#endif
#ifdef SIGSTKFLT
	[SIGSTKFLT] = "SIGSTKFLT",
#endif
#ifdef SIGCHLD
	[SIGCHLD] = "SIGCHLD",
#endif
#ifdef SIGCONT
	[SIGCONT] = "SIGCONT",
#endif
#ifdef SIGSTOP
	[SIGSTOP] = "SIGSTOP",
#endif
#ifdef SIGTSTP
	[SIGTSTP] = "SIGTSTP",
#endif
#ifdef SIGBREAK
	[SIGBREAK] = "SIGBREAK",
#endif
#ifdef SIGTTIN
	[SIGTTIN] = "SIGTTIN",
#endif
#ifdef SIGTTOU
	[SIGTTOU] = "SIGTTOU",
#endif
#ifdef SIGURG
	[SIGURG] = "SIGURG",
#endif
#ifdef SIGXCPU
	[SIGXCPU] = "SIGXCPU",
#endif
#ifdef SIGXFSZ
	[SIGXFSZ] = "SIGXFSZ",
#endif
#ifdef SIGVTALRM
	[SIGVTALRM] = "SIGVTALRM",
#endif
#ifdef SIGPROF
	[SIGPROF] = "SIGPROF",
#endif
#ifdef SIGWINCH
	[SIGWINCH] = "SIGWINCH",
#endif
#ifdef SIGPOLL
	[SIGPOLL] = "SIGPOLL",
#endif
#ifdef SIGLOST
	[SIGLOST] = "SIGLOST",
#endif
#ifdef SIGPWR
	[SIGPWR] = "SIGPWR",
#endif
#ifdef SIGINFO
	[SIGINFO] = "SIGINFO",
#endif
#ifdef SIGSYS
	[SIGSYS] = "SIGSYS",
#endif
};

size_t qn_signal_map_count = countof(qn_signal_map);

const char *qn_getsig(int sig) {
	if (sig < 0 || (size_t)sig >= qn_signal_map_count || !qn_signal_map[sig]) {
		return NULL;
	}
	return qn_signal_map[sig];
}

int qn_getsignum(const char *sig_str) {
	for (size_t i = 0; i < qn_signal_map_count; i++) {
		const char *s = qn_signal_map[i];
		if (s && strcmp(sig_str, s) == 0) {
			return (int)i;
		}
	}
	return -1;
}

/* ==========================================================================
 * call_handler wrapper
 * ========================================================================== */

void qn_call_handler(JSContext *ctx, JSValue func, int argc, JSValue *argv) {
	JSValue ret, func1;
	/* 'func' might be destroyed when calling itself (if it frees the
	   handler), so must take extra care */
	func1 = JS_DupValue(ctx, func);
	ret = JS_Call(ctx, func1, JS_UNDEFINED, argc, argv);
	JS_FreeValue(ctx, func1);
	if (JS_IsException(ret)) {
		qn_dump_error(ctx);
	}
	JS_FreeValue(ctx, ret);
}

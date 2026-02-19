/*
 * qn-vm.c - Event loop ownership, eval, and core async primitives
 *
 * Owns the libuv event loop and provides:
 * - Timer/poll primitives (setTimeout, setReadHandler, etc.)
 * - qn_vm_eval_binary / qn_vm_loop to replace js_std_eval_binary / js_std_loop
 * - Promise rejection tracking
 *
 * Uses the three-handle pattern from txiki.js (uv_prepare + uv_idle + uv_check)
 * to integrate microtask draining into uv_run. No patches to quickjs-libc.c needed.
 *
 * Adapted from txiki.js by Saul Ibarra Corretge (MIT License).
 */

#include "qn-vm.h"
#include "qn-uv-utils.h"
#include "quickjs/quickjs-libc.h"

#include <string.h>

/* --------------------------------------------------------------------------
 * Loop ownership
 * -------------------------------------------------------------------------- */

static uv_loop_t *g_loop = NULL;
static JSContext *g_ctx = NULL;

/* Three-handle pattern for microtask draining during uv_run */
static uv_prepare_t g_prepare;
static uv_idle_t g_idle;
static uv_check_t g_check;

uv_loop_t *js_uv_loop(JSContext *ctx) {
	(void)ctx;
	return g_loop;
}

/* --------------------------------------------------------------------------
 * Promise rejection tracking
 *
 * We track unhandled rejections ourselves via JS_SetHostPromiseRejectionTracker.
 * If any remain unhandled when the loop is about to sleep, we report and exit.
 * -------------------------------------------------------------------------- */

typedef struct QNRejection {
	struct QNRejection *next;
	JSValue promise;
	JSValue reason;
} QNRejection;

static QNRejection *rejection_head = NULL;

static void rejection_tracker(JSContext *ctx, JSValueConst promise,
                               JSValueConst reason, JS_BOOL is_handled,
                               void *opaque) {
	(void)opaque;

	if (!is_handled) {
		/* Add new unhandled rejection */
		QNRejection *r = malloc(sizeof(QNRejection));
		if (!r) return;
		r->promise = JS_DupValue(ctx, promise);
		r->reason = JS_DupValue(ctx, reason);
		r->next = rejection_head;
		rejection_head = r;
	} else {
		/* Rejection was handled — remove from list */
		QNRejection **pp = &rejection_head;
		while (*pp) {
			if (JS_SameValue(ctx, (*pp)->promise, promise)) {
				QNRejection *r = *pp;
				*pp = r->next;
				JS_FreeValue(ctx, r->promise);
				JS_FreeValue(ctx, r->reason);
				free(r);
				return;
			}
			pp = &(*pp)->next;
		}
	}
}

static void rejection_check(JSContext *ctx) {
	if (!rejection_head) return;

	for (QNRejection *r = rejection_head; r; r = r->next) {
		fprintf(stderr, "Possibly unhandled promise rejection: ");
		JSValue err_str = JS_ToString(ctx, r->reason);
		const char *s = JS_ToCString(ctx, err_str);
		if (s) {
			fprintf(stderr, "%s\n", s);
			JS_FreeCString(ctx, s);
		}
		JS_FreeValue(ctx, err_str);

		/* Also print stack if available */
		if (JS_IsObject(r->reason)) {
			JSValue stack = JS_GetPropertyStr(ctx, r->reason, "stack");
			if (!JS_IsUndefined(stack)) {
				const char *stack_str = JS_ToCString(ctx, stack);
				if (stack_str) {
					fprintf(stderr, "%s\n", stack_str);
					JS_FreeCString(ctx, stack_str);
				}
			}
			JS_FreeValue(ctx, stack);
		}
	}
	exit(1);
}

static void rejection_free_all(JSRuntime *rt) {
	while (rejection_head) {
		QNRejection *r = rejection_head;
		rejection_head = r->next;
		JS_FreeValueRT(rt, r->promise);
		JS_FreeValueRT(rt, r->reason);
		free(r);
	}
}

/* --------------------------------------------------------------------------
 * Timer system — setTimeout / clearTimeout backed by uv_timer_t
 * -------------------------------------------------------------------------- */

typedef struct QNTimer {
	struct QNTimer *next;
	uv_timer_t handle;
	JSContext *ctx;
	JSValue func;
	int id;
	bool closed;
} QNTimer;

static QNTimer *timer_head = NULL;
static int next_timer_id = 1;

static void timer_unlink(QNTimer *t) {
	QNTimer **pp = &timer_head;
	while (*pp) {
		if (*pp == t) { *pp = t->next; return; }
		pp = &(*pp)->next;
	}
}

static void timer_close_cb(uv_handle_t *h) {
	QNTimer *t = h->data;
	timer_unlink(t);
	js_free_rt(JS_GetRuntime(t->ctx), t);
}

static void timer_cb(uv_timer_t *h) {
	QNTimer *t = h->data;
	JSContext *ctx = t->ctx;

	/* Take ownership of the callback, then destroy the timer */
	JSValue func = t->func;
	t->func = JS_UNDEFINED;
	t->closed = true;
	uv_timer_stop(&t->handle);
	uv_close((uv_handle_t *)&t->handle, timer_close_cb);

	/* Call the handler (may re-enter) */
	qn_call_handler(ctx, func, 0, NULL);
	JS_FreeValue(ctx, func);
}

static QNTimer *timer_find(int id) {
	for (QNTimer *t = timer_head; t; t = t->next) {
		if (t->id == id && !t->closed) return t;
	}
	return NULL;
}

/* JS: setTimeout(func, delay) → timer_id */
static JSValue js_vm_setTimeout(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	JSValue func = argv[0];
	if (!JS_IsFunction(ctx, func))
		return JS_ThrowTypeError(ctx, "setTimeout: first argument must be a function");

	int64_t delay = 0;
	if (argc > 1) JS_ToInt64(ctx, &delay, argv[1]);
	if (delay < 0) delay = 0;

	QNTimer *t = js_malloc(ctx, sizeof(QNTimer));
	if (!t) return JS_EXCEPTION;

	t->id = next_timer_id++;
	t->ctx = ctx;
	t->func = JS_DupValue(ctx, func);
	t->closed = false;
	t->next = timer_head;
	timer_head = t;

	uv_timer_init(g_loop, &t->handle);
	t->handle.data = t;
	/* Refresh the loop's cached "now" so the timer deadline is based on
	   current wall-clock time, not the (possibly stale) value from the
	   start of this loop iteration.  Without this, timers started from
	   JS callbacks can fire early by the amount of time spent in JS
	   since the last uv_run poll.  See libuv/libuv#1105. */
	uv_update_time(g_loop);
	uv_timer_start(&t->handle, timer_cb, (uint64_t)delay, 0);

	return JS_NewInt32(ctx, t->id);
}

/* JS: clearTimeout(timer_id) */
static JSValue js_vm_clearTimeout(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
	int id;
	if (JS_ToInt32(ctx, &id, argv[0]))
		return JS_EXCEPTION;

	QNTimer *t = timer_find(id);
	if (t) {
		JS_FreeValue(ctx, t->func);
		t->func = JS_UNDEFINED;
		t->closed = true;
		uv_timer_stop(&t->handle);
		uv_close((uv_handle_t *)&t->handle, timer_close_cb);
	}
	return JS_UNDEFINED;
}

/* --------------------------------------------------------------------------
 * Poll system — setReadHandler / setWriteHandler backed by uv_poll_t
 * -------------------------------------------------------------------------- */

typedef struct QNPoll {
	struct QNPoll *next;
	uv_poll_t handle;
	JSContext *ctx;
	JSValue rw_func[2]; /* [0]=read, [1]=write */
	int fd;
	bool handle_inited;
} QNPoll;

static QNPoll *poll_head = NULL;

static QNPoll *poll_find(int fd) {
	for (QNPoll *p = poll_head; p; p = p->next) {
		if (p->fd == fd) return p;
	}
	return NULL;
}

static void poll_unlink(QNPoll *p) {
	QNPoll **pp = &poll_head;
	while (*pp) {
		if (*pp == p) { *pp = p->next; return; }
		pp = &(*pp)->next;
	}
}

static void poll_close_cb(uv_handle_t *h) {
	QNPoll *p = h->data;
	/* Entry was already unlinked in poll_free_entry; just free */
	js_free_rt(JS_GetRuntime(p->ctx), p);
}

static void poll_cb(uv_poll_t *h, int status, int events) {
	QNPoll *p = h->data;
	JSContext *ctx = p->ctx;
	if (status < 0) return;

	if ((events & UV_READABLE) && !JS_IsNull(p->rw_func[0]))
		qn_call_handler(ctx, p->rw_func[0], 0, NULL);
	if ((events & UV_WRITABLE) && !JS_IsNull(p->rw_func[1]))
		qn_call_handler(ctx, p->rw_func[1], 0, NULL);
}

static void poll_update(QNPoll *p) {
	int events = 0;
	if (!JS_IsNull(p->rw_func[0])) events |= UV_READABLE;
	if (!JS_IsNull(p->rw_func[1])) events |= UV_WRITABLE;

	if (events == 0) {
		if (p->handle_inited) {
			uv_poll_stop(&p->handle);
		}
		return;
	}
	if (!p->handle_inited) {
		uv_poll_init(g_loop, &p->handle, p->fd);
		p->handle.data = p;
		p->handle_inited = true;
	}
	uv_poll_start(&p->handle, events, poll_cb);
}

static void poll_free_entry(JSRuntime *rt, QNPoll *p) {
	JS_FreeValueRT(rt, p->rw_func[0]);
	JS_FreeValueRT(rt, p->rw_func[1]);
	/* Unlink immediately so poll_find() won't return a stale/closing entry */
	poll_unlink(p);
	if (p->handle_inited) {
		uv_poll_stop(&p->handle);
		uv_close((uv_handle_t *)&p->handle, poll_close_cb);
	} else {
		js_free_rt(rt, p);
	}
}

/* JS: setReadHandler(fd, func|null)  — magic=0
 * JS: setWriteHandler(fd, func|null) — magic=1 */
static JSValue js_vm_setRWHandler(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv, int magic) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	JSValue func = (argc > 1) ? argv[1] : JS_NULL;
	if (JS_IsUndefined(func)) func = JS_NULL;
	if (!JS_IsNull(func) && !JS_IsFunction(ctx, func))
		return JS_ThrowTypeError(ctx, "handler must be a function or null");

	QNPoll *p = poll_find(fd);

	if (JS_IsNull(func)) {
		/* Clearing a handler */
		if (p) {
			JS_FreeValue(ctx, p->rw_func[magic]);
			p->rw_func[magic] = JS_NULL;
			if (JS_IsNull(p->rw_func[0]) && JS_IsNull(p->rw_func[1])) {
				/* Both handlers cleared — remove entry */
				poll_free_entry(JS_GetRuntime(ctx), p);
			} else {
				poll_update(p);
			}
		}
	} else {
		/* Setting a handler */
		if (!p) {
			p = js_malloc(ctx, sizeof(QNPoll));
			if (!p) return JS_EXCEPTION;
			p->fd = fd;
			p->ctx = ctx;
			p->rw_func[0] = JS_NULL;
			p->rw_func[1] = JS_NULL;
			p->handle_inited = false;
			p->next = poll_head;
			poll_head = p;
		}
		JS_FreeValue(ctx, p->rw_func[magic]);
		p->rw_func[magic] = JS_DupValue(ctx, func);
		poll_update(p);
	}

	return JS_UNDEFINED;
}

/* --------------------------------------------------------------------------
 * Three-handle pattern for microtask draining
 *
 * Like txiki.js: uv_prepare + uv_idle + uv_check integrate JS job execution
 * into libuv's event loop. The idle handle prevents libuv from blocking in
 * I/O poll when there are pending JS jobs.
 * -------------------------------------------------------------------------- */

static void execute_jobs(JSContext *ctx) {
	int err;
	for (;;) {
		err = JS_ExecutePendingJob(JS_GetRuntime(ctx), NULL);
		if (err <= 0) {
			if (err < 0)
				js_std_dump_error(ctx);
			break;
		}
	}
}

static void idle_cb(uv_idle_t *handle) {
	/* noop — just prevents uv_run from blocking */
}

static void maybe_idle(void) {
	JSRuntime *rt = JS_GetRuntime(g_ctx);
	if (JS_IsJobPending(rt))
		uv_idle_start(&g_idle, idle_cb);
	else
		uv_idle_stop(&g_idle);
}

static void prepare_cb(uv_prepare_t *handle) {
	maybe_idle();
}

static void check_cb(uv_check_t *handle) {
	execute_jobs(g_ctx);
	rejection_check(g_ctx);
	maybe_idle();
}

/* --------------------------------------------------------------------------
 * randomFill(size) → Uint8Array
 *
 * Fills a new buffer with cryptographically strong random bytes via uv_random()
 * (getrandom(2) on Linux, getentropy() on macOS, BCryptGenRandom on Windows).
 * Replaces the /dev/urandom approach in node:crypto.
 *
 * Uses NULL loop for synchronous operation (same as txiki.js).
 * Node.js uses OpenSSL's RAND_bytes instead since it already bundles OpenSSL.
 * -------------------------------------------------------------------------- */

static JSValue js_vm_randomFill(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
	int64_t size;
	if (JS_ToInt64(ctx, &size, argv[0]))
		return JS_EXCEPTION;
	if (size < 0 || size > 256 * 1024)
		return JS_ThrowRangeError(ctx, "size must be 0..262144");

	uint8_t *buf = js_malloc(ctx, size ? size : 1);
	if (!buf) return JS_EXCEPTION;

	if (size > 0) {
		int r = uv_random(NULL, NULL, buf, (size_t)size, 0, NULL);
		if (r != 0) {
			js_free(ctx, buf);
			return qn_throw_errno(ctx, r);
		}
	}

	return qn_new_uint8array(ctx, buf, (size_t)size);
}

/* --------------------------------------------------------------------------
 * JS module: qn_vm
 * -------------------------------------------------------------------------- */

static const JSCFunctionListEntry vm_funcs[] = {
	QN_CFUNC_DEF("setTimeout", 2, js_vm_setTimeout),
	QN_CFUNC_DEF("clearTimeout", 1, js_vm_clearTimeout),
	QN_CFUNC_MAGIC_DEF("setReadHandler", 2, js_vm_setRWHandler, 0),
	QN_CFUNC_MAGIC_DEF("setWriteHandler", 2, js_vm_setRWHandler, 1),
	QN_CFUNC_DEF("randomFill", 1, js_vm_randomFill),
};

static int js_vm_module_init(JSContext *ctx, JSModuleDef *m) {
	return JS_SetModuleExportList(ctx, m, vm_funcs, countof(vm_funcs));
}

JSModuleDef *js_init_module_qn_vm(JSContext *ctx, const char *module_name) {
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_vm_module_init);
	if (!m) return NULL;
	JS_AddModuleExportList(ctx, m, vm_funcs, countof(vm_funcs));
	return m;
}

/* --------------------------------------------------------------------------
 * Eval and loop — replacements for js_std_eval_binary / js_std_loop
 * -------------------------------------------------------------------------- */

void qn_vm_eval_binary(JSContext *ctx, const uint8_t *buf, size_t buf_len,
                        int load_only) {
	JSValue obj, val;
	obj = JS_ReadObject(ctx, buf, buf_len, JS_READ_OBJ_BYTECODE);
	if (JS_IsException(obj))
		goto exception;
	if (load_only) {
		if (JS_VALUE_GET_TAG(obj) == JS_TAG_MODULE) {
			js_module_set_import_meta(ctx, obj, FALSE, FALSE);
		}
		JS_FreeValue(ctx, obj);
	} else {
		if (JS_VALUE_GET_TAG(obj) == JS_TAG_MODULE) {
			if (JS_ResolveModule(ctx, obj) < 0) {
				JS_FreeValue(ctx, obj);
				goto exception;
			}
			js_module_set_import_meta(ctx, obj, FALSE, TRUE);
		}
		val = JS_EvalFunction(ctx, obj);
		/* Don't call js_std_await — the three-handle pattern in qn_vm_loop
		   will drain jobs and resolve promises via uv_run. */
		if (JS_IsException(val)) {
		exception:
			js_std_dump_error(ctx);
			exit(1);
		}
		JS_FreeValue(ctx, val);
	}
}

void qn_vm_eval_binary_json_module(JSContext *ctx,
                                    const uint8_t *buf, size_t buf_len,
                                    const char *module_name) {
	JSValue obj = JS_ParseJSON2(ctx, (const char *)buf, buf_len, module_name,
	                             JS_PARSE_JSON_EXT);
	if (JS_IsException(obj))
		goto exception;
	JSModuleDef *m = JS_NewCModule(ctx, module_name, NULL);
	if (!m) {
		JS_FreeValue(ctx, obj);
		goto exception;
	}
	JS_AddModuleExport(ctx, m, "default");
	/* Note: JS_SetModuleExport steals the reference to obj */
	JS_SetModuleExport(ctx, m, "default", obj);
	return;
exception:
	js_std_dump_error(ctx);
	exit(1);
}

void qn_vm_loop(JSContext *ctx) {
	JSRuntime *rt = JS_GetRuntime(ctx);

	/* Start the three-handle pattern */
	uv_prepare_start(&g_prepare, prepare_cb);
	uv_unref((uv_handle_t *)&g_prepare);
	uv_check_start(&g_check, check_cb);
	uv_unref((uv_handle_t *)&g_check);

	/* Drain any jobs that were queued by eval_binary */
	execute_jobs(ctx);
	rejection_check(ctx);

	/* Main event loop */
	int r;
	do {
		maybe_idle();
		r = uv_run(g_loop, UV_RUN_DEFAULT);
	} while (r == 0 && JS_IsJobPending(rt));

	/* Final check for unhandled exceptions */
	if (JS_HasException(ctx)) {
		js_std_dump_error(ctx);
	}
}

/* --------------------------------------------------------------------------
 * Lifecycle
 * -------------------------------------------------------------------------- */

void qn_vm_init(JSContext *ctx) {
	g_ctx = ctx;
	g_loop = malloc(sizeof(uv_loop_t));
	if (!g_loop) {
		fprintf(stderr, "qn_vm_init: could not allocate uv_loop_t\n");
		abort();
	}
	uv_loop_init(g_loop);

	/* Initialize three-handle pattern handles */
	uv_prepare_init(g_loop, &g_prepare);
	uv_idle_init(g_loop, &g_idle);
	uv_check_init(g_loop, &g_check);

	/* Set up promise rejection tracking */
	JS_SetHostPromiseRejectionTracker(JS_GetRuntime(ctx),
	                                  rejection_tracker, NULL);
}

void qn_vm_free(JSRuntime *rt) {
	/* Close three-handle pattern handles */
	uv_close((uv_handle_t *)&g_prepare, NULL);
	uv_close((uv_handle_t *)&g_idle, NULL);
	uv_close((uv_handle_t *)&g_check, NULL);

	/* Free all timers */
	while (timer_head) {
		QNTimer *t = timer_head;
		timer_head = t->next;
		JS_FreeValueRT(rt, t->func);
		if (!t->closed) {
			uv_timer_stop(&t->handle);
		}
		js_free_rt(rt, t);
	}

	/* Free all poll handles */
	while (poll_head) {
		QNPoll *p = poll_head;
		poll_head = p->next;
		JS_FreeValueRT(rt, p->rw_func[0]);
		JS_FreeValueRT(rt, p->rw_func[1]);
		if (p->handle_inited) {
			uv_poll_stop(&p->handle);
		}
		js_free_rt(rt, p);
	}

	/* Free rejection tracking entries */
	rejection_free_all(rt);

	if (g_loop) {
		/* Run to let pending close callbacks fire */
		uv_run(g_loop, UV_RUN_NOWAIT);
		uv_loop_close(g_loop);
		free(g_loop);
		g_loop = NULL;
	}

	g_ctx = NULL;
}

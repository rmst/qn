/*
 * qn-vm.c - Event loop ownership and core async primitives
 *
 * Owns the libuv event loop and provides timer/poll primitives that replace
 * quickjs-libc.c's os.setTimeout/os.setReadHandler with native libuv handles.
 * This eliminates the need to patch quickjs-libc.c's internals — we just
 * install our own poll function via js_set_os_poll_func().
 *
 * Adapted from txiki.js by Saul Ibarra Corretge (MIT License).
 */

#include "qn-vm.h"
#include "qn-uv-utils.h"

#include <string.h>

/* --------------------------------------------------------------------------
 * Loop ownership
 * -------------------------------------------------------------------------- */

static uv_loop_t *g_loop = NULL;

uv_loop_t *js_uv_loop(JSContext *ctx) {
	(void)ctx;
	return g_loop;
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
	poll_unlink(p);
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
	if (p->handle_inited) {
		uv_poll_stop(&p->handle);
		uv_close((uv_handle_t *)&p->handle, poll_close_cb);
	} else {
		poll_unlink(p);
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
 * Poll function — replaces js_os_poll via js_set_os_poll_func
 * -------------------------------------------------------------------------- */

static int qn_vm_poll(JSContext *ctx) {
	if (!uv_loop_alive(g_loop))
		return -1; /* no more events */

	g_loop->data = ctx;
	uv_run(g_loop, UV_RUN_ONCE);
	return 0;
}

/* --------------------------------------------------------------------------
 * JS module: qn_vm
 * -------------------------------------------------------------------------- */

static const JSCFunctionListEntry vm_funcs[] = {
	QN_CFUNC_DEF("setTimeout", 2, js_vm_setTimeout),
	QN_CFUNC_DEF("clearTimeout", 1, js_vm_clearTimeout),
	QN_CFUNC_MAGIC_DEF("setReadHandler", 2, js_vm_setRWHandler, 0),
	QN_CFUNC_MAGIC_DEF("setWriteHandler", 2, js_vm_setRWHandler, 1),
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
 * Lifecycle
 * -------------------------------------------------------------------------- */

/* Declared in quickjs-libc.c, exposed via js_set_os_poll_func patch */
extern void js_set_os_poll_func(int (*func)(JSContext *ctx));

void qn_vm_init(JSContext *ctx) {
	(void)ctx;
	g_loop = malloc(sizeof(uv_loop_t));
	if (!g_loop) {
		fprintf(stderr, "qn_vm_init: could not allocate uv_loop_t\n");
		abort();
	}
	uv_loop_init(g_loop);
	js_set_os_poll_func(qn_vm_poll);
}

void qn_vm_free(JSRuntime *rt) {
	/* Free all timers */
	while (timer_head) {
		QNTimer *t = timer_head;
		timer_head = t->next;
		JS_FreeValueRT(rt, t->func);
		if (!t->closed) {
			uv_timer_stop(&t->handle);
			/* Can't use close callback since we're shutting down — just stop */
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

	if (g_loop) {
		/* Run one last time to let pending close callbacks fire */
		uv_run(g_loop, UV_RUN_NOWAIT);
		uv_loop_close(g_loop);
		free(g_loop);
		g_loop = NULL;
	}
}

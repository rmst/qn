/*
 * qn_uv_fs_event - Filesystem watching via libuv uv_fs_event_t
 *
 * Exposes a minimal single-dispatch API: fsWatch(path, recursive, cb) returns
 * an opaque handle whose .close() stops the watcher. The callback is invoked
 * with (events_bitmask, filename_or_null). All eventType / encoding / AbortSignal
 * / EventEmitter plumbing lives in node:fs JS, keeping this layer thin.
 *
 * Recursive watching: pass-through to libuv, which natively supports it on
 * macOS (FSEvents) and Windows (ReadDirectoryChangesW). On Linux (inotify),
 * libuv returns UV_ENOSYS for recursive — the JS layer emulates it by
 * registering one watcher per directory in the tree.
 *
 * Lifetime: follows the qn-uv-signals pattern. JS_DupValue-stored this_val
 * keeps the JS wrapper alive while libuv owns the handle; we drop that ref
 * in the uv_close callback. The gc_mark deliberately does NOT mark this_val
 * (see CLAUDE.md note on QuickJS self-ref cycles).
 */

#include "qn-uv-utils.h"

#include <string.h>

/*
 * Lifetime flags:
 *   closed   — uv_close has completed; the libuv handle memory is reusable.
 *   detached — JS side no longer holds a reference to this struct. Either the
 *              finalizer ran, or a startup-error path decided C should own
 *              cleanup. Free happens in close_cb once both flags are set.
 *              Note: same pattern recurs in qn-uv-signals.c / qn-uv-stream.c;
 *              extracting a shared helper is worthwhile if a 4th case arises.
 */
typedef struct {
	JSContext *ctx;
	int closed;
	int detached;
	uv_fs_event_t handle;
	JSValue func;
	JSValue this_val;
} QNFsEvent;

static JSClassID qn_fs_event_class_id;

static void uv__fs_event_close_cb(uv_handle_t *handle) {
	QNFsEvent *fe = handle->data;
	if (!fe) return;
	fe->closed = 1;
	/* Drop the prevent-GC self-ref unless the finalizer already did it. */
	if (!fe->detached && !JS_IsUndefined(fe->this_val)) {
		JSValue tmp = fe->this_val;
		fe->this_val = JS_UNDEFINED;
		JS_FreeValue(fe->ctx, tmp);
		/* JS_FreeValue may drop the last ref → GC → finalizer → free(fe).
		 * Do not touch fe after this point. */
		return;
	}
	if (fe->detached)
		js_free(fe->ctx, fe);
}

static void qn_fs_event_finalizer(JSRuntime *rt, JSValue val) {
	QNFsEvent *fe = JS_GetOpaque(val, qn_fs_event_class_id);
	if (!fe) return;
	JS_FreeValueRT(rt, fe->func);
	JS_FreeValueRT(rt, fe->this_val);
	fe->func = JS_UNDEFINED;
	fe->this_val = JS_UNDEFINED;
	fe->detached = 1;
	if (!fe->closed) {
		if (!uv_is_closing((uv_handle_t *)&fe->handle))
			uv_close((uv_handle_t *)&fe->handle, uv__fs_event_close_cb);
	} else {
		js_free(fe->ctx, fe);
	}
}

static void qn_fs_event_mark(JSRuntime *rt, JSValue val, JS_MarkFunc *mark_func) {
	QNFsEvent *fe = JS_GetOpaque(val, qn_fs_event_class_id);
	if (!fe) return;
	JS_MarkValue(rt, fe->func, mark_func);
	/* Intentionally NOT marking this_val — it's a self-ref that would let the
	 * cycle collector reclaim us while libuv still holds the handle. */
}

static JSClassDef qn_fs_event_class = {
	"FsEventHandle",
	.finalizer = qn_fs_event_finalizer,
	.gc_mark = qn_fs_event_mark,
};

static void uv__fs_event_cb(uv_fs_event_t *handle, const char *filename,
                             int events, int status) {
	QNFsEvent *fe = handle->data;
	if (!fe || JS_IsUndefined(fe->func)) return;
	JSContext *ctx = fe->ctx;
	JSValue argv[2];
	if (status < 0) {
		argv[0] = JS_NewInt32(ctx, status);  /* negative uv errno */
		argv[1] = JS_NULL;
	} else {
		argv[0] = JS_NewInt32(ctx, events);
		argv[1] = filename ? JS_NewString(ctx, filename) : JS_NULL;
	}
	qn_call_handler(ctx, fe->func, 2, argv);
	for (int i = 0; i < 2; i++)
		JS_FreeValue(ctx, argv[i]);
}

/* fsWatch(path, recursive, func) → FsEventHandle */
static JSValue js_uv_fs_watch(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	int recursive = JS_ToBool(ctx, argv[1]);
	JSValue func = argv[2];
	if (!JS_IsFunction(ctx, func)) {
		JS_FreeCString(ctx, path);
		return JS_ThrowTypeError(ctx, "not a function");
	}

	JSValue obj = JS_NewObjectClass(ctx, qn_fs_event_class_id);
	if (JS_IsException(obj)) {
		JS_FreeCString(ctx, path);
		return obj;
	}

	QNFsEvent *fe = js_mallocz(ctx, sizeof(*fe));
	if (!fe) {
		JS_FreeValue(ctx, obj);
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	int r = uv_fs_event_init(js_uv_loop(ctx), &fe->handle);
	if (r != 0) {
		JS_FreeValue(ctx, obj);
		JS_FreeCString(ctx, path);
		js_free(ctx, fe);
		return qn_throw_errno(ctx, r);
	}

	fe->ctx = ctx;
	fe->handle.data = fe;
	fe->func = JS_DupValue(ctx, func);
	fe->this_val = JS_UNDEFINED;

	unsigned int flags = recursive ? UV_FS_EVENT_RECURSIVE : 0;
	r = uv_fs_event_start(&fe->handle, uv__fs_event_cb, path, flags);
	JS_FreeCString(ctx, path);
	if (r != 0) {
		JS_FreeValue(ctx, fe->func);
		fe->func = JS_UNDEFINED;
		JS_FreeValue(ctx, obj);
		/* Handle was uv_fs_event_init'd — must close via uv_close.
		 * Mark detached so close_cb takes over freeing. */
		fe->detached = 1;
		uv_close((uv_handle_t *)&fe->handle, uv__fs_event_close_cb);
		return qn_throw_errno(ctx, r);
	}

	JS_SetOpaque(obj, fe);
	/* prevent GC while libuv holds the handle */
	fe->this_val = JS_DupValue(ctx, obj);
	return obj;
}

static QNFsEvent *qn_fs_event_get(JSContext *ctx, JSValue obj) {
	return JS_GetOpaque2(ctx, obj, qn_fs_event_class_id);
}

static JSValue js_uv_fs_event_close(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
	QNFsEvent *fe = qn_fs_event_get(ctx, this_val);
	if (!fe) return JS_EXCEPTION;
	if (!uv_is_closing((uv_handle_t *)&fe->handle))
		uv_close((uv_handle_t *)&fe->handle, uv__fs_event_close_cb);
	return JS_UNDEFINED;
}

static JSValue js_uv_fs_event_ref(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
	QNFsEvent *fe = qn_fs_event_get(ctx, this_val);
	if (!fe) return JS_EXCEPTION;
	uv_ref((uv_handle_t *)&fe->handle);
	return JS_UNDEFINED;
}

static JSValue js_uv_fs_event_unref(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
	QNFsEvent *fe = qn_fs_event_get(ctx, this_val);
	if (!fe) return JS_EXCEPTION;
	uv_unref((uv_handle_t *)&fe->handle);
	return JS_UNDEFINED;
}

static const JSCFunctionListEntry qn_fs_event_proto_funcs[] = {
	QN_CFUNC_DEF("close", 0, js_uv_fs_event_close),
	QN_CFUNC_DEF("ref", 0, js_uv_fs_event_ref),
	QN_CFUNC_DEF("unref", 0, js_uv_fs_event_unref),
};

static const JSCFunctionListEntry js_uv_fs_event_funcs[] = {
	QN_CFUNC_DEF("fsWatch", 3, js_uv_fs_watch),
	QN_CONST2("UV_RENAME", UV_RENAME),
	QN_CONST2("UV_CHANGE", UV_CHANGE),
};

static int js_uv_fs_event_init(JSContext *ctx, JSModuleDef *m) {
	JS_NewClassID(&qn_fs_event_class_id);
	JSRuntime *rt = JS_GetRuntime(ctx);
	JS_NewClass(rt, qn_fs_event_class_id, &qn_fs_event_class);
	JSValue proto = JS_NewObject(ctx);
	JS_SetPropertyFunctionList(ctx, proto, qn_fs_event_proto_funcs,
		sizeof(qn_fs_event_proto_funcs) / sizeof(qn_fs_event_proto_funcs[0]));
	JS_SetClassProto(ctx, qn_fs_event_class_id, proto);

	return JS_SetModuleExportList(ctx, m, js_uv_fs_event_funcs,
		sizeof(js_uv_fs_event_funcs) / sizeof(js_uv_fs_event_funcs[0]));
}

JSModuleDef *js_init_module_qn_uv_fs_event(JSContext *ctx, const char *module_name) {
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_uv_fs_event_init);
	if (!m) return NULL;
	JS_AddModuleExportList(ctx, m, js_uv_fs_event_funcs,
		sizeof(js_uv_fs_event_funcs) / sizeof(js_uv_fs_event_funcs[0]));
	return m;
}

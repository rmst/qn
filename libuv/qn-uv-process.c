/*
 * qn_uv_process - Child process spawning via libuv uv_spawn
 *
 * Single-dispatch design following qn-uv-stream.c / qn-uv-fs.c pattern.
 * Two-phase destruction (closed + finalized) for the process handle.
 * Stdio pipes are QNStream objects from qn-uv-stream.
 */

#include "qn-uv-stream.h"
#include <string.h>

/* ---- Process handle struct ---- */

typedef struct QNProcess {
	JSContext *ctx;
	int closed;
	int finalized;
	uv_process_t handle;
	JSValue on_exit;   /* function(exit_code, term_signal) */
	JSValue this_val;  /* prevent GC while libuv holds a reference */
} QNProcess;

static JSClassID qn_process_class_id;

static void qn_process_maybe_free(QNProcess *p) {
	if (p->closed && p->finalized)
		free(p);
}

static void qn_process_close_cb(uv_handle_t *handle) {
	QNProcess *p = handle->data;
	p->closed = 1;
	qn_process_maybe_free(p);
}

static void qn_process_finalizer(JSRuntime *rt, JSValue val) {
	QNProcess *p = JS_GetOpaque(val, qn_process_class_id);
	if (!p) return;

	JS_FreeValueRT(rt, p->on_exit);
	JS_FreeValueRT(rt, p->this_val);

	p->finalized = 1;
	if (!p->closed) {
		if (!uv_is_closing((uv_handle_t *)&p->handle))
			uv_close((uv_handle_t *)&p->handle, qn_process_close_cb);
	} else {
		qn_process_maybe_free(p);
	}
}

static void qn_process_gc_mark(JSRuntime *rt, JSValueConst val,
                                JS_MarkFunc *mark_func) {
	QNProcess *p = JS_GetOpaque(val, qn_process_class_id);
	if (!p) return;
	JS_MarkValue(rt, p->on_exit, mark_func);
	JS_MarkValue(rt, p->this_val, mark_func);
}

static JSClassDef qn_process_class = {
	"Process",
	.finalizer = qn_process_finalizer,
	.gc_mark = qn_process_gc_mark,
};

/* ---- Exit callback ---- */

static void qn_exit_cb(uv_process_t *handle, int64_t exit_status, int term_signal) {
	QNProcess *p = handle->data;
	JSContext *ctx = p->ctx;

	if (!JS_IsUndefined(p->on_exit)) {
		JSValue args[2];
		args[0] = JS_NewInt64(ctx, exit_status);
		args[1] = JS_NewInt32(ctx, term_signal);
		qn_call_handler(ctx, p->on_exit, 2, args);
		JS_FreeValue(ctx, args[0]);
		JS_FreeValue(ctx, args[1]);
	}

	/* Close the process handle after exit */
	if (!uv_is_closing((uv_handle_t *)&p->handle)) {
		uv_close((uv_handle_t *)&p->handle, qn_process_close_cb);
		JS_FreeValue(ctx, p->this_val);
		p->this_val = JS_UNDEFINED;
	}
}

/* ---- Opcodes ---- */

enum {
	PROC_SPAWN = 0,
	PROC_KILL,
	PROC_GET_PID,
	PROC_SET_ON_EXIT,
	PROC_CLOSE,
};

/* ---- Helper: convert JS string array to C string array ---- */

static char **js_array_to_cstrings(JSContext *ctx, JSValue arr, int *out_count) {
	int64_t len;
	JSValue val = JS_GetPropertyStr(ctx, arr, "length");
	JS_ToInt64(ctx, &len, val);
	JS_FreeValue(ctx, val);

	char **result = js_malloc(ctx, sizeof(char *) * (len + 1));
	if (!result) return NULL;

	for (int64_t i = 0; i < len; i++) {
		JSValue elem = JS_GetPropertyUint32(ctx, arr, i);
		const char *str = JS_ToCString(ctx, elem);
		JS_FreeValue(ctx, elem);
		if (!str) {
			/* Cleanup on error */
			for (int64_t j = 0; j < i; j++)
				JS_FreeCString(ctx, result[j]);
			js_free(ctx, result);
			return NULL;
		}
		result[i] = (char *)str;
	}
	result[len] = NULL;
	if (out_count) *out_count = (int)len;
	return result;
}

static void free_cstrings(JSContext *ctx, char **strs, int count) {
	for (int i = 0; i < count; i++)
		JS_FreeCString(ctx, strs[i]);
	js_free(ctx, strs);
}

/* ---- Single dispatch ---- */

static JSValue js_uv_process_op(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
	int32_t op;
	if (JS_ToInt32(ctx, &op, argv[0]))
		return JS_EXCEPTION;

	int nargs = argc - 1;
	JSValueConst *args = argv + 1;
	uv_loop_t *loop = js_uv_loop(ctx);

	switch (op) {

	case PROC_SPAWN: {
		/*
		 * spawn(file, args_array, options)
		 * options: { cwd, env_array, stdio: [stdin_handle, stdout_handle, stderr_handle],
		 *            detached, uid, gid }
		 * stdio handles: null = ignore, undefined = inherit, QNStream = pipe
		 */
		const char *file = JS_ToCString(ctx, args[0]);
		if (!file) return JS_EXCEPTION;

		/* Build args array: [file, ...args] */
		int args_count = 0;
		char **c_args = NULL;
		if (!JS_IsUndefined(args[1])) {
			c_args = js_array_to_cstrings(ctx, args[1], &args_count);
			if (!c_args) { JS_FreeCString(ctx, file); return JS_EXCEPTION; }
		}

		/* Prepend file to args for uv_spawn (argv[0] = file) */
		char **spawn_args = js_malloc(ctx, sizeof(char *) * (args_count + 2));
		if (!spawn_args) {
			if (c_args) free_cstrings(ctx, c_args, args_count);
			JS_FreeCString(ctx, file);
			return JS_EXCEPTION;
		}
		spawn_args[0] = (char *)file;
		for (int i = 0; i < args_count; i++)
			spawn_args[i + 1] = c_args ? c_args[i] : NULL;
		spawn_args[args_count + 1] = NULL;

		/* Options */
		JSValue opts = nargs > 2 ? args[2] : JS_UNDEFINED;
		const char *cwd = NULL;
		char **env = NULL;
		int env_count = 0;
		int detached = 0;

		if (!JS_IsUndefined(opts)) {
			JSValue v;

			v = JS_GetPropertyStr(ctx, opts, "cwd");
			if (!JS_IsUndefined(v) && !JS_IsNull(v))
				cwd = JS_ToCString(ctx, v);
			JS_FreeValue(ctx, v);

			v = JS_GetPropertyStr(ctx, opts, "env");
			if (!JS_IsUndefined(v) && !JS_IsNull(v)) {
				env = js_array_to_cstrings(ctx, v, &env_count);
			}
			JS_FreeValue(ctx, v);

			v = JS_GetPropertyStr(ctx, opts, "detached");
			detached = JS_ToBool(ctx, v);
			JS_FreeValue(ctx, v);
		}

		/* Setup stdio */
		uv_stdio_container_t child_stdio[3];

		JSValue stdio_arr = JS_UNDEFINED;
		if (!JS_IsUndefined(opts))
			stdio_arr = JS_GetPropertyStr(ctx, opts, "stdio");

		for (int i = 0; i < 3; i++) {
			JSValue sval = JS_UNDEFINED;
			if (!JS_IsUndefined(stdio_arr))
				sval = JS_GetPropertyUint32(ctx, stdio_arr, i);

			if (JS_IsNull(sval)) {
				/* null = ignore */
				child_stdio[i].flags = UV_IGNORE;
			} else if (JS_IsUndefined(sval)) {
				/* undefined = inherit */
				child_stdio[i].flags = UV_INHERIT_FD;
				child_stdio[i].data.fd = i;
			} else {
				/* QNStream pipe handle */
				QNStream *s = JS_GetOpaque2(ctx, sval, qn_stream_class_id);
				if (!s) {
					/* Might be a numeric fd */
					int32_t fd;
					if (JS_ToInt32(ctx, &fd, sval) == 0) {
						child_stdio[i].flags = UV_INHERIT_FD;
						child_stdio[i].data.fd = fd;
					} else {
						child_stdio[i].flags = UV_IGNORE;
					}
				} else {
					int flags = UV_CREATE_PIPE;
					if (i == 0)
						flags |= UV_READABLE_PIPE;
					else
						flags |= UV_WRITABLE_PIPE;
					child_stdio[i].flags = flags;
					child_stdio[i].data.stream = &s->h.stream;
				}
			}
			JS_FreeValue(ctx, sval);
		}
		JS_FreeValue(ctx, stdio_arr);

		/* Create process handle */
		QNProcess *proc = calloc(1, sizeof(*proc));
		if (!proc) {
			js_free(ctx, spawn_args);
			if (c_args) free_cstrings(ctx, c_args, args_count);
			JS_FreeCString(ctx, file);
			if (cwd) JS_FreeCString(ctx, cwd);
			if (env) free_cstrings(ctx, env, env_count);
			return JS_ThrowOutOfMemory(ctx);
		}
		proc->ctx = ctx;
		proc->on_exit = JS_UNDEFINED;
		proc->this_val = JS_UNDEFINED;
		proc->handle.data = proc;

		/* Setup spawn options */
		uv_process_options_t popts;
		memset(&popts, 0, sizeof(popts));
		popts.exit_cb = qn_exit_cb;
		popts.file = file;
		popts.args = spawn_args;
		popts.cwd = cwd;
		popts.env = env;
		popts.flags = 0;
		if (detached) popts.flags |= UV_PROCESS_DETACHED;
		popts.stdio_count = 3;
		popts.stdio = child_stdio;

		int r = uv_spawn(loop, &proc->handle, &popts);

		/* Cleanup C strings */
		js_free(ctx, spawn_args);
		if (c_args) free_cstrings(ctx, c_args, args_count);
		JS_FreeCString(ctx, file);
		if (cwd) JS_FreeCString(ctx, cwd);
		if (env) free_cstrings(ctx, env, env_count);

		if (r < 0) {
			free(proc);
			return qn_throw_errno(ctx, r);
		}

		/* Wrap process as JS object */
		JSValue obj = JS_NewObjectClass(ctx, qn_process_class_id);
		if (JS_IsException(obj)) {
			uv_close((uv_handle_t *)&proc->handle, qn_process_close_cb);
			return JS_EXCEPTION;
		}
		JS_SetOpaque(obj, proc);
		proc->this_val = JS_DupValue(ctx, obj);

		return obj;
	}

	case PROC_KILL: {
		QNProcess *p = JS_GetOpaque2(ctx, args[0], qn_process_class_id);
		if (!p) return JS_EXCEPTION;
		int32_t sig;
		if (JS_ToInt32(ctx, &sig, args[1])) return JS_EXCEPTION;
		int r = uv_process_kill(&p->handle, sig);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_UNDEFINED;
	}

	case PROC_GET_PID: {
		QNProcess *p = JS_GetOpaque2(ctx, args[0], qn_process_class_id);
		if (!p) return JS_EXCEPTION;
		return JS_NewInt32(ctx, p->handle.pid);
	}

	case PROC_SET_ON_EXIT: {
		QNProcess *p = JS_GetOpaque2(ctx, args[0], qn_process_class_id);
		if (!p) return JS_EXCEPTION;
		JS_FreeValue(ctx, p->on_exit);
		p->on_exit = JS_DupValue(ctx, args[1]);
		return JS_UNDEFINED;
	}

	case PROC_CLOSE: {
		QNProcess *p = JS_GetOpaque2(ctx, args[0], qn_process_class_id);
		if (!p) return JS_EXCEPTION;
		if (!uv_is_closing((uv_handle_t *)&p->handle)) {
			uv_close((uv_handle_t *)&p->handle, qn_process_close_cb);
			JS_FreeValue(ctx, p->this_val);
			p->this_val = JS_UNDEFINED;
		}
		return JS_UNDEFINED;
	}

	default:
		return JS_ThrowRangeError(ctx, "unknown process opcode: %d", op);
	}
}

/* ==== module definition ==== */

static const JSCFunctionListEntry js_uv_process_funcs[] = {
	QN_CFUNC_DEF("_op", 4, js_uv_process_op),
	QN_CONST2("SPAWN", PROC_SPAWN),
	QN_CONST2("KILL", PROC_KILL),
	QN_CONST2("GET_PID", PROC_GET_PID),
	QN_CONST2("SET_ON_EXIT", PROC_SET_ON_EXIT),
	QN_CONST2("CLOSE", PROC_CLOSE),
};

static int js_uv_process_init(JSContext *ctx, JSModuleDef *m) {
	JS_NewClassID(&qn_process_class_id);
	JS_NewClass(JS_GetRuntime(ctx), qn_process_class_id, &qn_process_class);
	return JS_SetModuleExportList(ctx, m, js_uv_process_funcs,
	                              countof(js_uv_process_funcs));
}

JSModuleDef *js_init_module_qn_uv_process(JSContext *ctx,
                                           const char *module_name) {
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_uv_process_init);
	if (!m) return NULL;
	JS_AddModuleExportList(ctx, m, js_uv_process_funcs, countof(js_uv_process_funcs));
	return m;
}

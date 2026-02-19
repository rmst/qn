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
	PROC_SPAWN_SYNC,
	PROC_KILL_PID,
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

/* ---- Shared argument parsing for spawn/spawnSync ---- */

typedef struct {
	const char *file;
	char **spawn_args;   /* [file, ...args, NULL] */
	char **c_args;       /* args from JS (for freeing) */
	int args_count;
	const char *cwd;
	char **env;
	int env_count;
	int detached;
} SpawnArgs;

/*
 * Parse spawn(file, args_array, options) into SpawnArgs.
 * Caller must call spawn_args_free() after uv_spawn.
 * Returns 0 on success, -1 on error (JS exception set).
 */
static int spawn_args_parse(JSContext *ctx, int nargs, JSValueConst *args,
                            SpawnArgs *sa) {
	memset(sa, 0, sizeof(*sa));

	sa->file = JS_ToCString(ctx, args[0]);
	if (!sa->file) return -1;

	if (!JS_IsUndefined(args[1])) {
		sa->c_args = js_array_to_cstrings(ctx, args[1], &sa->args_count);
		if (!sa->c_args) { JS_FreeCString(ctx, sa->file); return -1; }
	}

	sa->spawn_args = js_malloc(ctx, sizeof(char *) * (sa->args_count + 2));
	if (!sa->spawn_args) {
		if (sa->c_args) free_cstrings(ctx, sa->c_args, sa->args_count);
		JS_FreeCString(ctx, sa->file);
		return -1;
	}
	sa->spawn_args[0] = (char *)sa->file;
	for (int i = 0; i < sa->args_count; i++)
		sa->spawn_args[i + 1] = sa->c_args ? sa->c_args[i] : NULL;
	sa->spawn_args[sa->args_count + 1] = NULL;

	JSValue opts = nargs > 2 ? args[2] : JS_UNDEFINED;
	if (!JS_IsUndefined(opts)) {
		JSValue v;

		v = JS_GetPropertyStr(ctx, opts, "cwd");
		if (!JS_IsUndefined(v) && !JS_IsNull(v))
			sa->cwd = JS_ToCString(ctx, v);
		JS_FreeValue(ctx, v);

		v = JS_GetPropertyStr(ctx, opts, "env");
		if (!JS_IsUndefined(v) && !JS_IsNull(v))
			sa->env = js_array_to_cstrings(ctx, v, &sa->env_count);
		JS_FreeValue(ctx, v);

		v = JS_GetPropertyStr(ctx, opts, "detached");
		sa->detached = JS_ToBool(ctx, v);
		JS_FreeValue(ctx, v);
	}
	return 0;
}

static void spawn_args_free(JSContext *ctx, SpawnArgs *sa) {
	js_free(ctx, sa->spawn_args);
	if (sa->c_args) free_cstrings(ctx, sa->c_args, sa->args_count);
	JS_FreeCString(ctx, sa->file);
	if (sa->cwd) JS_FreeCString(ctx, sa->cwd);
	if (sa->env) free_cstrings(ctx, sa->env, sa->env_count);
}

/*
 * Parse a JS stdio array element into a uv_stdio_container_t.
 * Handles: null (ignore), undefined (inherit fd i), QNStream (pipe),
 *          number (inherit that fd), string "pipe"/"inherit"/"ignore".
 */
static void parse_stdio_entry(JSContext *ctx, JSValue sval, int i,
                              uv_stdio_container_t *out) {
	if (JS_IsNull(sval)) {
		out->flags = UV_IGNORE;
	} else if (JS_IsUndefined(sval)) {
		out->flags = UV_INHERIT_FD;
		out->data.fd = i;
	} else {
		/* Try QNStream pipe handle first */
		QNStream *s = JS_GetOpaque(sval, qn_stream_class_id);
		if (s) {
			int flags = UV_CREATE_PIPE;
			flags |= (i == 0) ? UV_READABLE_PIPE : UV_WRITABLE_PIPE;
			out->flags = flags;
			out->data.stream = &s->h.stream;
			return;
		}
		/* Try numeric fd */
		int32_t fd;
		if (JS_ToInt32(ctx, &fd, sval) == 0 && !JS_IsString(sval)) {
			out->flags = UV_INHERIT_FD;
			out->data.fd = fd;
			return;
		}
		/* Try string: "pipe", "inherit", "ignore" */
		const char *str = JS_ToCString(ctx, sval);
		if (str) {
			if (strcmp(str, "pipe") == 0) {
				/* Caller must handle pipe init separately */
				out->flags = UV_CREATE_PIPE;
				out->flags |= (i == 0) ? UV_READABLE_PIPE : UV_WRITABLE_PIPE;
			} else if (strcmp(str, "inherit") == 0) {
				out->flags = UV_INHERIT_FD;
				out->data.fd = i;
			} else if (strcmp(str, "ignore") == 0) {
				out->flags = UV_IGNORE;
			} else {
				out->flags = UV_IGNORE;
			}
			JS_FreeCString(ctx, str);
			return;
		}
		out->flags = UV_IGNORE;
	}
}

/* ---- Synchronous spawn (fresh uv_loop_t, like Node's SyncProcessRunner) ---- */

typedef struct {
	char *data;
	size_t len;
	size_t cap;
} sync_buf_t;

typedef struct {
	uv_process_t process;
	uv_pipe_t stdin_pipe;
	uv_pipe_t stdout_pipe;
	uv_pipe_t stderr_pipe;
	uv_timer_t timer;
	uv_write_t write_req;

	int has_stdin, has_stdout, has_stderr, has_timer;
	sync_buf_t out, err;

	int64_t exit_status;
	int term_signal;
	int timed_out;
	int kill_signal;
} sync_spawn_t;

static void sync_buf_append(sync_buf_t *b, const char *src, size_t n) {
	if (b->len + n > b->cap) {
		size_t nc = b->cap ? b->cap * 2 : 4096;
		while (nc < b->len + n) nc *= 2;
		b->data = realloc(b->data, nc);
		b->cap = nc;
	}
	memcpy(b->data + b->len, src, n);
	b->len += n;
}

static void sync_close_cb(uv_handle_t *h) { (void)h; }

static void sync_alloc_cb(uv_handle_t *h, size_t suggested, uv_buf_t *buf) {
	(void)h;
	buf->base = malloc(suggested);
	buf->len = buf->base ? suggested : 0;
}

static void sync_read_cb(uv_stream_t *s, ssize_t nread, const uv_buf_t *buf) {
	sync_spawn_t *ss = s->data;
	if (nread > 0) {
		sync_buf_t *target = (s == (uv_stream_t *)&ss->stdout_pipe)
		                     ? &ss->out : &ss->err;
		sync_buf_append(target, buf->base, nread);
	}
	if (buf->base) free(buf->base);
	if (nread < 0)
		uv_close((uv_handle_t *)s, sync_close_cb);
}

static void sync_exit_cb(uv_process_t *h, int64_t exit_status, int term_signal) {
	sync_spawn_t *ss = h->data;
	ss->exit_status = exit_status;
	ss->term_signal = term_signal;
	uv_close((uv_handle_t *)h, sync_close_cb);
	if (ss->has_timer && !uv_is_closing((uv_handle_t *)&ss->timer))
		uv_close((uv_handle_t *)&ss->timer, sync_close_cb);
}

static void sync_timer_cb(uv_timer_t *t) {
	sync_spawn_t *ss = t->data;
	ss->timed_out = 1;
	uv_process_kill(&ss->process, ss->kill_signal);
	uv_close((uv_handle_t *)t, sync_close_cb);
}

static void sync_write_cb(uv_write_t *req, int status) {
	(void)status;
	sync_spawn_t *ss = req->data;
	uv_close((uv_handle_t *)&ss->stdin_pipe, sync_close_cb);
}

static JSValue js_spawn_sync(JSContext *ctx, int nargs, JSValueConst *args) {
	SpawnArgs sa;
	if (spawn_args_parse(ctx, nargs, args, &sa) < 0)
		return JS_EXCEPTION;

	sync_spawn_t ss;
	memset(&ss, 0, sizeof(ss));
	ss.kill_signal = 15; /* SIGTERM */

	/* Parse sync-specific options: input, timeout, killSignal, stdio strings */
	JSValue opts = nargs > 2 ? args[2] : JS_UNDEFINED;
	uint8_t *input_data = NULL;
	size_t input_len = 0;
	uint64_t timeout = 0;

	if (!JS_IsUndefined(opts)) {
		JSValue v;

		v = JS_GetPropertyStr(ctx, opts, "timeout");
		if (!JS_IsUndefined(v)) JS_ToIndex(ctx, &timeout, v);
		JS_FreeValue(ctx, v);

		v = JS_GetPropertyStr(ctx, opts, "killSignal");
		if (!JS_IsUndefined(v)) {
			int32_t ks;
			if (JS_ToInt32(ctx, &ks, v) == 0) ss.kill_signal = ks;
		}
		JS_FreeValue(ctx, v);

		v = JS_GetPropertyStr(ctx, opts, "input");
		if (!JS_IsUndefined(v) && !JS_IsNull(v)) {
			input_data = JS_GetArrayBuffer(ctx, &input_len, v);
			if (!input_data) {
				size_t off, blen;
				JSValue ab = JS_GetTypedArrayBuffer(ctx, v, &off, &blen, NULL);
				if (!JS_IsException(ab)) {
					input_data = JS_GetArrayBuffer(ctx, &input_len, ab);
					if (input_data) { input_data += off; input_len = blen; }
					JS_FreeValue(ctx, ab);
				} else {
					JS_FreeValue(ctx, JS_GetException(ctx));
				}
			}
		}
		JS_FreeValue(ctx, v);
	}

	/* Create temporary event loop */
	uv_loop_t loop;
	uv_loop_init(&loop);

	/* Parse stdio and setup pipes on the temp loop */
	uv_stdio_container_t child_stdio[3];
	JSValue stdio_arr = JS_UNDEFINED;
	if (!JS_IsUndefined(opts))
		stdio_arr = JS_GetPropertyStr(ctx, opts, "stdio");

	for (int i = 0; i < 3; i++) {
		JSValue sval = JS_UNDEFINED;
		if (!JS_IsUndefined(stdio_arr))
			sval = JS_GetPropertyUint32(ctx, stdio_arr, i);
		parse_stdio_entry(ctx, sval, i, &child_stdio[i]);
		JS_FreeValue(ctx, sval);

		/* For pipe entries, init a uv_pipe_t on the temp loop */
		if (child_stdio[i].flags & UV_CREATE_PIPE) {
			uv_pipe_t *pipe;
			if (i == 0)      { pipe = &ss.stdin_pipe;  ss.has_stdin = 1; }
			else if (i == 1) { pipe = &ss.stdout_pipe; ss.has_stdout = 1; }
			else             { pipe = &ss.stderr_pipe; ss.has_stderr = 1; }
			uv_pipe_init(&loop, pipe, 0);
			pipe->data = &ss;
			child_stdio[i].data.stream = (uv_stream_t *)pipe;
		}
	}
	JS_FreeValue(ctx, stdio_arr);

	/* Spawn */
	uv_process_options_t popts;
	memset(&popts, 0, sizeof(popts));
	popts.exit_cb = sync_exit_cb;
	popts.file = sa.file;
	popts.args = sa.spawn_args;
	popts.cwd = sa.cwd;
	popts.env = sa.env;
	popts.stdio_count = 3;
	popts.stdio = child_stdio;
	ss.process.data = &ss;

	int r = uv_spawn(&loop, &ss.process, &popts);
	spawn_args_free(ctx, &sa);

	int pid = 0;
	if (r < 0) {
		if (ss.has_stdin)  uv_close((uv_handle_t *)&ss.stdin_pipe, sync_close_cb);
		if (ss.has_stdout) uv_close((uv_handle_t *)&ss.stdout_pipe, sync_close_cb);
		if (ss.has_stderr) uv_close((uv_handle_t *)&ss.stderr_pipe, sync_close_cb);
		uv_run(&loop, UV_RUN_DEFAULT);
		uv_loop_close(&loop);

		JSValue result = JS_NewObject(ctx);
		JS_SetPropertyStr(ctx, result, "pid", JS_NewInt32(ctx, 0));
		JS_SetPropertyStr(ctx, result, "status", JS_NULL);
		JS_SetPropertyStr(ctx, result, "signal", JS_NULL);
		JS_SetPropertyStr(ctx, result, "stdout", qn_new_uint8array(ctx, NULL, 0));
		JS_SetPropertyStr(ctx, result, "stderr", qn_new_uint8array(ctx, NULL, 0));
		JS_SetPropertyStr(ctx, result, "timedOut", JS_FALSE);
		JS_SetPropertyStr(ctx, result, "error", qn_new_error(ctx, r));
		return result;
	}
	pid = ss.process.pid;

	/* Write input to stdin and close */
	if (ss.has_stdin) {
		if (input_data && input_len > 0) {
			uv_buf_t wbuf = uv_buf_init((char *)input_data, input_len);
			ss.write_req.data = &ss;
			uv_write(&ss.write_req, (uv_stream_t *)&ss.stdin_pipe, &wbuf, 1, sync_write_cb);
		} else {
			uv_close((uv_handle_t *)&ss.stdin_pipe, sync_close_cb);
		}
	}

	if (ss.has_stdout)
		uv_read_start((uv_stream_t *)&ss.stdout_pipe, sync_alloc_cb, sync_read_cb);
	if (ss.has_stderr)
		uv_read_start((uv_stream_t *)&ss.stderr_pipe, sync_alloc_cb, sync_read_cb);

	if (timeout > 0) {
		ss.has_timer = 1;
		uv_timer_init(&loop, &ss.timer);
		ss.timer.data = &ss;
		uv_timer_start(&ss.timer, sync_timer_cb, timeout, 0);
	}

	uv_run(&loop, UV_RUN_DEFAULT);
	uv_loop_close(&loop);

	/* Build result */
	JSValue result = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, result, "pid", JS_NewInt32(ctx, pid));

	if (ss.term_signal) {
		JS_SetPropertyStr(ctx, result, "status", JS_NULL);
		JS_SetPropertyStr(ctx, result, "signal", JS_NewInt32(ctx, ss.term_signal));
	} else {
		JS_SetPropertyStr(ctx, result, "status", JS_NewInt64(ctx, ss.exit_status));
		JS_SetPropertyStr(ctx, result, "signal", JS_NULL);
	}

	for (int i = 0; i < 2; i++) {
		sync_buf_t *b = i == 0 ? &ss.out : &ss.err;
		const char *key = i == 0 ? "stdout" : "stderr";
		if (b->data) {
			uint8_t *copy = js_malloc(ctx, b->len ? b->len : 1);
			if (b->len) memcpy(copy, b->data, b->len);
			JS_SetPropertyStr(ctx, result, key, qn_new_uint8array(ctx, copy, b->len));
			free(b->data);
		} else {
			JS_SetPropertyStr(ctx, result, key, qn_new_uint8array(ctx, NULL, 0));
		}
	}

	JS_SetPropertyStr(ctx, result, "timedOut", ss.timed_out ? JS_TRUE : JS_FALSE);
	return result;
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
		 * stdio handles: null = ignore, undefined = inherit, QNStream = pipe, number = fd
		 */
		SpawnArgs sa;
		if (spawn_args_parse(ctx, nargs, args, &sa) < 0)
			return JS_EXCEPTION;

		/* Setup stdio */
		uv_stdio_container_t child_stdio[3];
		JSValue opts = nargs > 2 ? args[2] : JS_UNDEFINED;
		JSValue stdio_arr = JS_UNDEFINED;
		if (!JS_IsUndefined(opts))
			stdio_arr = JS_GetPropertyStr(ctx, opts, "stdio");

		for (int i = 0; i < 3; i++) {
			JSValue sval = JS_UNDEFINED;
			if (!JS_IsUndefined(stdio_arr))
				sval = JS_GetPropertyUint32(ctx, stdio_arr, i);
			parse_stdio_entry(ctx, sval, i, &child_stdio[i]);
			JS_FreeValue(ctx, sval);
		}
		JS_FreeValue(ctx, stdio_arr);

		/* Create process handle */
		QNProcess *proc = calloc(1, sizeof(*proc));
		if (!proc) {
			spawn_args_free(ctx, &sa);
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
		popts.file = sa.file;
		popts.args = sa.spawn_args;
		popts.cwd = sa.cwd;
		popts.env = sa.env;
		popts.flags = 0;
		if (sa.detached) popts.flags |= UV_PROCESS_DETACHED;
		popts.stdio_count = 3;
		popts.stdio = child_stdio;

		int r = uv_spawn(loop, &proc->handle, &popts);
		spawn_args_free(ctx, &sa);

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

	case PROC_SPAWN_SYNC:
		return js_spawn_sync(ctx, nargs, args);

	case PROC_KILL_PID: {
		/* kill(pid, signal) — kill by PID (not handle) */
		int32_t pid, sig;
		if (JS_ToInt32(ctx, &pid, args[0])) return JS_EXCEPTION;
		if (JS_ToInt32(ctx, &sig, args[1])) return JS_EXCEPTION;
		int r = uv_kill(pid, sig);
		if (r < 0) return qn_throw_errno(ctx, r);
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
	QN_CONST2("SPAWN_SYNC", PROC_SPAWN_SYNC),
	QN_CONST2("KILL_PID", PROC_KILL_PID),
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

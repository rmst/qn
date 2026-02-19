/*
 * qn_uv_stream - Unified libuv stream abstraction for TCP/Pipe/TTY
 *
 * Single-dispatch design following qn-uv-fs.c pattern.
 * Two-phase destruction (closed + finalized) following txiki.js.
 */

#include "qn-uv-stream.h"
#include <string.h>

JSClassID qn_stream_class_id;

static void qn_stream_maybe_free(QNStream *s) {
	if (s->closed && s->finalized)
		free(s);
}

static void qn_stream_close_cb(uv_handle_t *handle) {
	QNStream *s = handle->data;
	s->closed = 1;
	qn_stream_maybe_free(s);
}

static void qn_stream_finalizer(JSRuntime *rt, JSValue val) {
	QNStream *s = JS_GetOpaque(val, qn_stream_class_id);
	if (!s) return;

	JS_FreeValueRT(rt, s->on_read);
	JS_FreeValueRT(rt, s->on_connection);
	JS_FreeValueRT(rt, s->on_connect);
	JS_FreeValueRT(rt, s->on_shutdown);
	JS_FreeValueRT(rt, s->this_val);

	s->finalized = 1;
	if (!s->closed) {
		if (!uv_is_closing(&s->h.handle))
			uv_close(&s->h.handle, qn_stream_close_cb);
	} else {
		qn_stream_maybe_free(s);
	}
}

static void qn_stream_gc_mark(JSRuntime *rt, JSValueConst val,
                               JS_MarkFunc *mark_func) {
	QNStream *s = JS_GetOpaque(val, qn_stream_class_id);
	if (!s) return;
	JS_MarkValue(rt, s->on_read, mark_func);
	JS_MarkValue(rt, s->on_connection, mark_func);
	JS_MarkValue(rt, s->on_connect, mark_func);
	JS_MarkValue(rt, s->on_shutdown, mark_func);
	JS_MarkValue(rt, s->this_val, mark_func);
}

static JSClassDef qn_stream_class = {
	"Stream",
	.finalizer = qn_stream_finalizer,
	.gc_mark = qn_stream_gc_mark,
};

static QNStream *qn_stream_get(JSContext *ctx, JSValueConst obj) {
	return JS_GetOpaque2(ctx, obj, qn_stream_class_id);
}

/* ---- Alloc / init helpers ---- */

QNStream *qn_stream_new(JSContext *ctx) {
	QNStream *s = calloc(1, sizeof(*s));
	if (!s) return NULL;
	s->ctx = ctx;
	s->on_read = JS_UNDEFINED;
	s->on_connection = JS_UNDEFINED;
	s->on_connect = JS_UNDEFINED;
	s->on_shutdown = JS_UNDEFINED;
	s->this_val = JS_UNDEFINED;
	s->h.handle.data = s;
	return s;
}

JSValue qn_stream_wrap(JSContext *ctx, QNStream *s) {
	JSValue obj = JS_NewObjectClass(ctx, qn_stream_class_id);
	if (JS_IsException(obj)) {
		if (!uv_is_closing(&s->h.handle))
			uv_close(&s->h.handle, qn_stream_close_cb);
		return JS_EXCEPTION;
	}
	JS_SetOpaque(obj, s);
	/* prevent GC while libuv holds the handle */
	s->this_val = JS_DupValue(ctx, obj);
	return obj;
}

/* ---- libuv callbacks ---- */

static void qn_alloc_cb(uv_handle_t *handle, size_t suggested, uv_buf_t *buf) {
	buf->base = malloc(suggested);
	buf->len = buf->base ? suggested : 0;
}

static void qn_read_cb(uv_stream_t *stream, ssize_t nread, const uv_buf_t *buf) {
	QNStream *s = stream->data;
	JSContext *ctx = s->ctx;

	if (JS_IsUndefined(s->on_read)) {
		free(buf->base);
		return;
	}

	if (nread < 0) {
		/* EOF or error */
		free(buf->base);
		uv_read_stop(stream);
		if (nread == UV_EOF) {
			JSValue args[2] = { JS_NULL, JS_NULL };
			qn_call_handler(ctx, s->on_read, 2, args);
		} else {
			JSValue err = qn_new_error(ctx, nread);
			JSValue args[2] = { JS_NULL, err };
			qn_call_handler(ctx, s->on_read, 2, args);
			JS_FreeValue(ctx, err);
		}
		return;
	}

	if (nread == 0) {
		free(buf->base);
		return;
	}

	/* Transfer ownership of buf->base to a Uint8Array */
	uint8_t *data = js_malloc(ctx, nread);
	if (!data) {
		free(buf->base);
		return;
	}
	memcpy(data, buf->base, nread);
	free(buf->base);
	JSValue arr = qn_new_uint8array(ctx, data, nread);
	JSValue args[2] = { arr, JS_NULL };
	qn_call_handler(ctx, s->on_read, 2, args);
	JS_FreeValue(ctx, arr);
}

typedef struct {
	uv_write_t req;
	JSContext *ctx;
	QNPromise result;
	JSValue tarray; /* pinned buffer */
} QNWriteReq;

static void qn_write_cb(uv_write_t *req, int status) {
	QNWriteReq *wr = req->data;
	JSContext *ctx = wr->ctx;
	JSValue arg;
	bool is_reject = false;

	if (status < 0) {
		arg = qn_new_error(ctx, status);
		is_reject = true;
	} else {
		arg = JS_UNDEFINED;
	}

	qn_promise_settle(ctx, &wr->result, is_reject, 1, &arg);
	JS_FreeValue(ctx, wr->tarray);
	js_free(ctx, wr);
}

static void qn_connection_cb(uv_stream_t *server, int status) {
	QNStream *s = server->data;
	JSContext *ctx = s->ctx;

	if (JS_IsUndefined(s->on_connection)) return;

	if (status < 0) {
		JSValue err = qn_new_error(ctx, status);
		qn_call_handler(ctx, s->on_connection, 1, &err);
		JS_FreeValue(ctx, err);
		return;
	}

	/* Create a new TCP handle for the accepted connection */
	QNStream *client = qn_stream_new(ctx);
	if (!client) return;
	uv_tcp_init(js_uv_loop(ctx), &client->h.tcp);
	client->h.handle.data = client;

	int r = uv_accept(server, &client->h.stream);
	if (r < 0) {
		uv_close(&client->h.handle, qn_stream_close_cb);
		return;
	}

	JSValue obj = qn_stream_wrap(ctx, client);
	if (JS_IsException(obj)) return;
	qn_call_handler(ctx, s->on_connection, 1, &obj);
	JS_FreeValue(ctx, obj);
}

static void qn_connect_cb(uv_connect_t *req, int status) {
	QNStream *s = req->handle->data;
	JSContext *ctx = s->ctx;
	free(req);

	if (JS_IsUndefined(s->on_connect)) return;

	JSValue arg;
	if (status < 0) {
		arg = qn_new_error(ctx, status);
	} else {
		arg = JS_NULL;
	}
	qn_call_handler(ctx, s->on_connect, 1, &arg);
	if (status < 0)
		JS_FreeValue(ctx, arg);
}

static void qn_shutdown_cb(uv_shutdown_t *req, int status) {
	QNStream *s = req->handle->data;
	JSContext *ctx = s->ctx;
	free(req);

	if (JS_IsUndefined(s->on_shutdown)) return;

	JSValue arg;
	if (status < 0) {
		arg = qn_new_error(ctx, status);
	} else {
		arg = JS_NULL;
	}
	qn_call_handler(ctx, s->on_shutdown, 1, &arg);
	if (status < 0)
		JS_FreeValue(ctx, arg);
}

/* ---- Opcodes ---- */

enum {
	STREAM_TCP_NEW = 0,
	STREAM_TCP_BIND,
	STREAM_LISTEN,
	STREAM_TCP_CONNECT,
	STREAM_READ_START,
	STREAM_READ_STOP,
	STREAM_WRITE,
	STREAM_SHUTDOWN,
	STREAM_CLOSE,
	STREAM_FILENO,
	STREAM_TCP_NODELAY,
	STREAM_TCP_KEEPALIVE,
	STREAM_TCP_GETSOCKNAME,
	STREAM_TCP_GETPEERNAME,
	STREAM_SET_ON_READ,
	STREAM_SET_ON_CONNECTION,
	STREAM_SET_ON_CONNECT,
	STREAM_SET_ON_SHUTDOWN,
	STREAM_PIPE_NEW,
	STREAM_PIPE_OPEN,
};

/* ---- Single dispatch ---- */

static JSValue js_uv_stream_op(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	int32_t op;
	if (JS_ToInt32(ctx, &op, argv[0]))
		return JS_EXCEPTION;

	int nargs = argc - 1;
	JSValueConst *args = argv + 1;
	uv_loop_t *loop = js_uv_loop(ctx);

	switch (op) {

	case STREAM_TCP_NEW: {
		int32_t family = AF_INET;
		if (nargs > 0 && !JS_IsUndefined(args[0]))
			JS_ToInt32(ctx, &family, args[0]);
		QNStream *s = qn_stream_new(ctx);
		if (!s) return JS_ThrowOutOfMemory(ctx);
		int r = uv_tcp_init(loop, &s->h.tcp);
		if (r < 0) { free(s); return qn_throw_errno(ctx, r); }
		return qn_stream_wrap(ctx, s);
	}

	case STREAM_TCP_BIND: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		const char *host = JS_ToCString(ctx, args[1]);
		if (!host) return JS_EXCEPTION;
		int32_t port;
		if (JS_ToInt32(ctx, &port, args[2])) { JS_FreeCString(ctx, host); return JS_EXCEPTION; }
		struct sockaddr_storage addr;
		int r;
		if (strchr(host, ':')) {
			struct sockaddr_in6 *a6 = (struct sockaddr_in6 *)&addr;
			r = uv_ip6_addr(host, port, a6);
		} else {
			struct sockaddr_in *a4 = (struct sockaddr_in *)&addr;
			r = uv_ip4_addr(host, port, a4);
		}
		JS_FreeCString(ctx, host);
		if (r < 0) return qn_throw_errno(ctx, r);
		r = uv_tcp_bind(&s->h.tcp, (struct sockaddr *)&addr, 0);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_UNDEFINED;
	}

	case STREAM_LISTEN: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		int32_t backlog = 128;
		if (nargs > 1 && !JS_IsUndefined(args[1]))
			JS_ToInt32(ctx, &backlog, args[1]);
		int r = uv_listen(&s->h.stream, backlog, qn_connection_cb);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_UNDEFINED;
	}

	case STREAM_TCP_CONNECT: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		const char *host = JS_ToCString(ctx, args[1]);
		if (!host) return JS_EXCEPTION;
		int32_t port;
		if (JS_ToInt32(ctx, &port, args[2])) { JS_FreeCString(ctx, host); return JS_EXCEPTION; }
		struct sockaddr_storage addr;
		int r;
		if (strchr(host, ':')) {
			struct sockaddr_in6 *a6 = (struct sockaddr_in6 *)&addr;
			r = uv_ip6_addr(host, port, a6);
		} else {
			struct sockaddr_in *a4 = (struct sockaddr_in *)&addr;
			r = uv_ip4_addr(host, port, a4);
		}
		JS_FreeCString(ctx, host);
		if (r < 0) return qn_throw_errno(ctx, r);
		uv_connect_t *creq = malloc(sizeof(*creq));
		if (!creq) return JS_ThrowOutOfMemory(ctx);
		r = uv_tcp_connect(creq, &s->h.tcp, (struct sockaddr *)&addr, qn_connect_cb);
		if (r < 0) { free(creq); return qn_throw_errno(ctx, r); }
		return JS_UNDEFINED;
	}

	case STREAM_READ_START: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		int r = uv_read_start(&s->h.stream, qn_alloc_cb, qn_read_cb);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_UNDEFINED;
	}

	case STREAM_READ_STOP: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		uv_read_stop(&s->h.stream);
		return JS_UNDEFINED;
	}

	case STREAM_WRITE: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		size_t size;
		uint8_t *data;
		size_t byte_offset, byte_length, elem_size;
		JSValue ab = JS_GetTypedArrayBuffer(ctx, args[1], &byte_offset, &byte_length, &elem_size);
		if (JS_IsException(ab)) return JS_EXCEPTION;
		size_t ab_size;
		uint8_t *buf = JS_GetArrayBuffer(ctx, &ab_size, ab);
		JS_FreeValue(ctx, ab);
		if (!buf) return JS_EXCEPTION;
		data = buf + byte_offset;
		size = byte_length;

		/* Try synchronous write first */
		uv_buf_t b = uv_buf_init((char *)data, size);
		int n = uv_try_write(&s->h.stream, &b, 1);
		if (n == (int)size) {
			/* Fully written synchronously */
			return qn_new_resolved_promise(ctx, 0, NULL);
		}
		if (n > 0) {
			/* Partial write — async the rest */
			data += n;
			size -= n;
		} else if (n != UV_EAGAIN) {
			/* Real error from try_write */
			if (n < 0) return qn_throw_errno(ctx, n);
		}

		/* Async write for remainder */
		QNWriteReq *wr = js_malloc(ctx, sizeof(*wr));
		if (!wr) return JS_EXCEPTION;
		wr->ctx = ctx;
		wr->req.data = wr;
		wr->tarray = JS_DupValue(ctx, args[1]);
		b = uv_buf_init((char *)data, size);
		int r = uv_write(&wr->req, &s->h.stream, &b, 1, qn_write_cb);
		if (r < 0) {
			JS_FreeValue(ctx, wr->tarray);
			js_free(ctx, wr);
			return qn_throw_errno(ctx, r);
		}
		return qn_promise_init(ctx, &wr->result);
	}

	case STREAM_SHUTDOWN: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		uv_shutdown_t *req = malloc(sizeof(*req));
		if (!req) return JS_ThrowOutOfMemory(ctx);
		int r = uv_shutdown(req, &s->h.stream, qn_shutdown_cb);
		if (r < 0) { free(req); return qn_throw_errno(ctx, r); }
		return JS_UNDEFINED;
	}

	case STREAM_CLOSE: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		if (!uv_is_closing(&s->h.handle)) {
			uv_close(&s->h.handle, qn_stream_close_cb);
			/* Release the prevent-GC ref */
			JS_FreeValue(ctx, s->this_val);
			s->this_val = JS_UNDEFINED;
		}
		return JS_UNDEFINED;
	}

	case STREAM_FILENO: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		uv_os_fd_t fd;
		int r = uv_fileno(&s->h.handle, &fd);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_NewInt32(ctx, (int)fd);
	}

	case STREAM_TCP_NODELAY: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		int enable = JS_ToBool(ctx, args[1]);
		int r = uv_tcp_nodelay(&s->h.tcp, enable);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_UNDEFINED;
	}

	case STREAM_TCP_KEEPALIVE: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		int enable = JS_ToBool(ctx, args[1]);
		int r = uv_tcp_keepalive(&s->h.tcp, enable, 60);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_UNDEFINED;
	}

	case STREAM_TCP_GETSOCKNAME:
	case STREAM_TCP_GETPEERNAME: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		struct sockaddr_storage addr;
		int namelen = sizeof(addr);
		int r;
		if (op == STREAM_TCP_GETSOCKNAME)
			r = uv_tcp_getsockname(&s->h.tcp, (struct sockaddr *)&addr, &namelen);
		else
			r = uv_tcp_getpeername(&s->h.tcp, (struct sockaddr *)&addr, &namelen);
		if (r < 0) return qn_throw_errno(ctx, r);
		JSValue obj = JS_NewObject(ctx);
		qn_addr2obj(ctx, obj, (struct sockaddr *)&addr, false);
		return obj;
	}

	/* -- Callback setters -- */
	case STREAM_SET_ON_READ: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		JS_FreeValue(ctx, s->on_read);
		s->on_read = JS_DupValue(ctx, args[1]);
		return JS_UNDEFINED;
	}

	case STREAM_SET_ON_CONNECTION: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		JS_FreeValue(ctx, s->on_connection);
		s->on_connection = JS_DupValue(ctx, args[1]);
		return JS_UNDEFINED;
	}

	case STREAM_SET_ON_CONNECT: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		JS_FreeValue(ctx, s->on_connect);
		s->on_connect = JS_DupValue(ctx, args[1]);
		return JS_UNDEFINED;
	}

	case STREAM_SET_ON_SHUTDOWN: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		JS_FreeValue(ctx, s->on_shutdown);
		s->on_shutdown = JS_DupValue(ctx, args[1]);
		return JS_UNDEFINED;
	}

	case STREAM_PIPE_NEW: {
		QNStream *s = qn_stream_new(ctx);
		if (!s) return JS_ThrowOutOfMemory(ctx);
		int r = uv_pipe_init(loop, &s->h.pipe, 0);
		if (r < 0) { free(s); return qn_throw_errno(ctx, r); }
		return qn_stream_wrap(ctx, s);
	}

	case STREAM_PIPE_OPEN: {
		QNStream *s = qn_stream_get(ctx, args[0]);
		if (!s) return JS_EXCEPTION;
		int32_t fd;
		if (JS_ToInt32(ctx, &fd, args[1])) return JS_EXCEPTION;
		int r = uv_pipe_open(&s->h.pipe, fd);
		if (r < 0) return qn_throw_errno(ctx, r);
		return JS_UNDEFINED;
	}

	default:
		return JS_ThrowRangeError(ctx, "unknown stream opcode: %d", op);
	}
}

/* ==== module definition ==== */

static const JSCFunctionListEntry js_uv_stream_funcs[] = {
	QN_CFUNC_DEF("_op", 5, js_uv_stream_op),
	/* Opcodes */
	QN_CONST2("TCP_NEW", STREAM_TCP_NEW),
	QN_CONST2("TCP_BIND", STREAM_TCP_BIND),
	QN_CONST2("LISTEN", STREAM_LISTEN),
	QN_CONST2("TCP_CONNECT", STREAM_TCP_CONNECT),
	QN_CONST2("READ_START", STREAM_READ_START),
	QN_CONST2("READ_STOP", STREAM_READ_STOP),
	QN_CONST2("WRITE", STREAM_WRITE),
	QN_CONST2("SHUTDOWN", STREAM_SHUTDOWN),
	QN_CONST2("CLOSE", STREAM_CLOSE),
	QN_CONST2("FILENO", STREAM_FILENO),
	QN_CONST2("TCP_NODELAY", STREAM_TCP_NODELAY),
	QN_CONST2("TCP_KEEPALIVE", STREAM_TCP_KEEPALIVE),
	QN_CONST2("TCP_GETSOCKNAME", STREAM_TCP_GETSOCKNAME),
	QN_CONST2("TCP_GETPEERNAME", STREAM_TCP_GETPEERNAME),
	QN_CONST2("SET_ON_READ", STREAM_SET_ON_READ),
	QN_CONST2("SET_ON_CONNECTION", STREAM_SET_ON_CONNECTION),
	QN_CONST2("SET_ON_CONNECT", STREAM_SET_ON_CONNECT),
	QN_CONST2("SET_ON_SHUTDOWN", STREAM_SET_ON_SHUTDOWN),
	QN_CONST2("PIPE_NEW", STREAM_PIPE_NEW),
	QN_CONST2("PIPE_OPEN", STREAM_PIPE_OPEN),
	/* Address family constants */
	QN_CONST(AF_INET),
	QN_CONST(AF_INET6),
};

static int js_uv_stream_init(JSContext *ctx, JSModuleDef *m) {
	JS_NewClassID(&qn_stream_class_id);
	JS_NewClass(JS_GetRuntime(ctx), qn_stream_class_id, &qn_stream_class);
	return JS_SetModuleExportList(ctx, m, js_uv_stream_funcs,
	                              countof(js_uv_stream_funcs));
}

JSModuleDef *js_init_module_qn_uv_stream(JSContext *ctx,
                                          const char *module_name) {
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_uv_stream_init);
	if (!m) return NULL;
	JS_AddModuleExportList(ctx, m, js_uv_stream_funcs, countof(js_uv_stream_funcs));
	return m;
}

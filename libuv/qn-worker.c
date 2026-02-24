/*
 * qn-worker.c - Web Worker implementation using libuv threads + socketpair
 *
 * Architecture:
 * - Parent creates a uv_socketpair, spawns a worker thread
 * - Worker thread gets its own JSRuntime + JSContext + uv_loop_t
 * - Messages use a 4-byte length prefix + JS_WriteObject2 serialized data
 * - Both sides use uv_pipe_t for non-blocking read/write integrated with
 *   their respective event loops
 *
 * The thin C layer exposes: _create, _postMessage, _terminate, _setOnMessage
 * All higher-level API shaping happens in JS (node/qn/worker.js).
 */

#include "qn-worker.h"
#include "qn-vm.h"
#include "qn-uv-utils.h"
#include "quickjs/quickjs-libc.h"

#include <string.h>
#include <stdlib.h>
#if !defined(_WIN32)
#include <unistd.h>
#endif

/* --------------------------------------------------------------------------
 * Worker init callbacks (set by generated main)
 * -------------------------------------------------------------------------- */

static qn_worker_runtime_init_fn g_rt_init = NULL;
static qn_worker_context_init_fn g_ctx_init = NULL;
static qn_worker_context_setup_fn g_ctx_setup = NULL;

void qn_worker_set_init(qn_worker_runtime_init_fn rt_init,
                         qn_worker_context_init_fn ctx_init,
                         qn_worker_context_setup_fn ctx_setup) {
	g_rt_init = rt_init;
	g_ctx_init = ctx_init;
	g_ctx_setup = ctx_setup;
}

/* --------------------------------------------------------------------------
 * Message protocol: [4-byte LE uint32 length] [payload]
 * -------------------------------------------------------------------------- */

#define MSG_HEADER_SIZE 4

/* Encode a uint32 as 4 bytes little-endian */
static void encode_u32(uint8_t *buf, uint32_t val) {
	buf[0] = (uint8_t)(val & 0xFF);
	buf[1] = (uint8_t)((val >> 8) & 0xFF);
	buf[2] = (uint8_t)((val >> 16) & 0xFF);
	buf[3] = (uint8_t)((val >> 24) & 0xFF);
}

static uint32_t decode_u32(const uint8_t *buf) {
	return (uint32_t)buf[0] |
	       ((uint32_t)buf[1] << 8) |
	       ((uint32_t)buf[2] << 16) |
	       ((uint32_t)buf[3] << 24);
}

/* --------------------------------------------------------------------------
 * Read buffer for reassembling length-prefixed messages from a stream
 * -------------------------------------------------------------------------- */

typedef struct {
	uint8_t *buf;
	size_t len;      /* bytes currently in buffer */
	size_t cap;      /* allocated capacity */
	uint32_t msg_len; /* expected payload length, 0 = reading header */
} QNReadBuf;

static void readbuf_init(QNReadBuf *rb) {
	memset(rb, 0, sizeof(*rb));
}

static void readbuf_free(QNReadBuf *rb) {
	free(rb->buf);
	memset(rb, 0, sizeof(*rb));
}

static void readbuf_append(QNReadBuf *rb, const uint8_t *data, size_t len) {
	size_t needed = rb->len + len;
	if (needed > rb->cap) {
		size_t new_cap = rb->cap ? rb->cap * 2 : 4096;
		if (new_cap < needed) new_cap = needed;
		rb->buf = realloc(rb->buf, new_cap);
		rb->cap = new_cap;
	}
	memcpy(rb->buf + rb->len, data, len);
	rb->len += len;
}

/* Try to extract a complete message. Returns 1 if a message was extracted
 * (fills out_data/out_len, caller must free out_data), 0 if more data needed. */
static int readbuf_extract(QNReadBuf *rb, uint8_t **out_data, size_t *out_len) {
	/* Need header? */
	if (rb->msg_len == 0) {
		if (rb->len < MSG_HEADER_SIZE)
			return 0;
		rb->msg_len = decode_u32(rb->buf);
		/* Shift header out */
		rb->len -= MSG_HEADER_SIZE;
		if (rb->len > 0)
			memmove(rb->buf, rb->buf + MSG_HEADER_SIZE, rb->len);
	}
	/* Have full payload? */
	if (rb->len < rb->msg_len)
		return 0;

	*out_len = rb->msg_len;
	*out_data = malloc(rb->msg_len);
	memcpy(*out_data, rb->buf, rb->msg_len);

	/* Shift remaining data */
	rb->len -= rb->msg_len;
	if (rb->len > 0)
		memmove(rb->buf, rb->buf + rb->msg_len, rb->len);
	rb->msg_len = 0;
	return 1;
}

/* --------------------------------------------------------------------------
 * Worker object (parent side)
 * -------------------------------------------------------------------------- */

static JSClassID qn_worker_class_id;

typedef struct QNWorker {
	uv_pipe_t pipe;       /* parent-side pipe handle */
	uv_thread_t thread;   /* worker thread */
	JSContext *ctx;        /* parent's JS context */
	JSValue this_val;     /* prevent-GC ref */
	JSValue onmessage;    /* message callback */
	JSValue onerror;      /* error callback */
	QNReadBuf readbuf;    /* reassembly buffer for incoming messages */
	bool terminated;
	bool pipe_closed;
} QNWorker;

/* Forward declarations */
static void pipe_alloc_cb(uv_handle_t *handle, size_t suggested, uv_buf_t *buf);
static void worker_read_cb(uv_stream_t *stream, ssize_t nread, const uv_buf_t *buf);
static void worker_close_cb(uv_handle_t *handle);
static void worker_thread_entry(void *arg);

/* --------------------------------------------------------------------------
 * Worker thread data (passed to worker_thread_entry)
 * -------------------------------------------------------------------------- */

typedef struct {
	int fd;              /* worker's socketpair fd */
	char *filename;      /* resolved absolute script path */
} QNWorkerThreadData;

/* --------------------------------------------------------------------------
 * Sending a message (shared by parent and worker)
 * -------------------------------------------------------------------------- */

static void write_done_cb(uv_write_t *req, int status) {
	free(req->data);  /* sendbuf */
	free(req);
}

static int send_message(uv_stream_t *stream, JSContext *ctx, JSValueConst val) {
	size_t data_len;
	uint8_t *data = JS_WriteObject2(ctx, &data_len, val,
	                                 JS_WRITE_OBJ_SAB | JS_WRITE_OBJ_REFERENCE,
	                                 NULL, NULL);
	if (!data)
		return -1;

	size_t total = MSG_HEADER_SIZE + data_len;
	uint8_t *sendbuf = malloc(total);
	if (!sendbuf) {
		js_free(ctx, data);
		return -1;
	}
	encode_u32(sendbuf, (uint32_t)data_len);
	memcpy(sendbuf + MSG_HEADER_SIZE, data, data_len);
	js_free(ctx, data);

	uv_buf_t uvbuf = uv_buf_init((char *)sendbuf, (unsigned int)total);
	uv_write_t *req = malloc(sizeof(uv_write_t));
	req->data = sendbuf;

	int r = uv_write(req, stream, &uvbuf, 1, write_done_cb);
	if (r != 0) {
		free(sendbuf);
		free(req);
		return -1;
	}
	return 0;
}

/* --------------------------------------------------------------------------
 * Parent-side: receive messages from worker
 * -------------------------------------------------------------------------- */

/* Shared alloc callback for both parent and worker pipe reads */
static void pipe_alloc_cb(uv_handle_t *handle, size_t suggested, uv_buf_t *buf) {
	buf->base = malloc(suggested);
	buf->len = buf->base ? (unsigned int)suggested : 0;
}

static void worker_read_cb(uv_stream_t *stream, ssize_t nread, const uv_buf_t *buf) {
	QNWorker *w = stream->data;

	if (nread < 0) {
		/* EOF or error — worker closed its end */
		free(buf->base);
		if (!w->pipe_closed) {
			w->pipe_closed = true;
			uv_close((uv_handle_t *)&w->pipe, worker_close_cb);
		}
		return;
	}

	if (nread == 0) {
		free(buf->base);
		return;
	}

	readbuf_append(&w->readbuf, (uint8_t *)buf->base, nread);
	free(buf->base);

	/* Extract and dispatch complete messages */
	uint8_t *msg_data;
	size_t msg_len;
	while (readbuf_extract(&w->readbuf, &msg_data, &msg_len)) {
		if (!JS_IsFunction(w->ctx, w->onmessage)) {
			free(msg_data);
			continue;
		}

		JSValue data_val = JS_ReadObject(w->ctx, msg_data, msg_len,
		                                  JS_READ_OBJ_SAB | JS_READ_OBJ_REFERENCE);
		free(msg_data);

		if (JS_IsException(data_val)) {
			js_std_dump_error(w->ctx);
			continue;
		}

		/* Call onmessage({ data: value }) */
		JSValue event = JS_NewObject(w->ctx);
		JS_DefinePropertyValueStr(w->ctx, event, "data", data_val, JS_PROP_C_W_E);

		JSValue ret = JS_Call(w->ctx, w->onmessage, JS_UNDEFINED, 1, &event);
		if (JS_IsException(ret))
			js_std_dump_error(w->ctx);
		else
			JS_FreeValue(w->ctx, ret);
		JS_FreeValue(w->ctx, event);
	}
}

static void worker_close_cb(uv_handle_t *handle) {
	QNWorker *w = handle->data;
	/* Release the prevent-GC ref so the Worker object can be collected */
	if (!JS_IsUndefined(w->this_val)) {
		JS_FreeValue(w->ctx, w->this_val);
		w->this_val = JS_UNDEFINED;
	}
}

/* --------------------------------------------------------------------------
 * Worker thread: entry point
 * -------------------------------------------------------------------------- */

/* Worker-side globals (thread-local via the worker thread's own TLS) */

typedef struct {
	uv_pipe_t pipe;
	JSContext *ctx;
	QNReadBuf readbuf;
	bool pipe_closed;
} QNWorkerSelf;

static void worker_self_read_cb(uv_stream_t *stream, ssize_t nread, const uv_buf_t *buf) {
	QNWorkerSelf *self = stream->data;

	if (nread < 0) {
		free(buf->base);
		if (!self->pipe_closed) {
			self->pipe_closed = true;
			uv_close((uv_handle_t *)&self->pipe, NULL);
		}
		return;
	}

	if (nread == 0) {
		free(buf->base);
		return;
	}

	readbuf_append(&self->readbuf, (uint8_t *)buf->base, nread);
	free(buf->base);

	uint8_t *msg_data;
	size_t msg_len;
	while (readbuf_extract(&self->readbuf, &msg_data, &msg_len)) {
		/* Get self.onmessage from global */
		JSValue global = JS_GetGlobalObject(self->ctx);
		JSValue selfobj = JS_GetPropertyStr(self->ctx, global, "self");
		JSValue handler = JS_GetPropertyStr(self->ctx, selfobj, "onmessage");

		if (JS_IsFunction(self->ctx, handler)) {
			JSValue data_val = JS_ReadObject(self->ctx, msg_data, msg_len,
			                                  JS_READ_OBJ_SAB | JS_READ_OBJ_REFERENCE);
			free(msg_data);

			if (JS_IsException(data_val)) {
				js_std_dump_error(self->ctx);
			} else {
				JSValue event = JS_NewObject(self->ctx);
				JS_DefinePropertyValueStr(self->ctx, event, "data", data_val, JS_PROP_C_W_E);

				JSValue ret = JS_Call(self->ctx, handler, JS_UNDEFINED, 1, &event);
				if (JS_IsException(ret))
					js_std_dump_error(self->ctx);
				else
					JS_FreeValue(self->ctx, ret);
				JS_FreeValue(self->ctx, event);
			}
		} else {
			free(msg_data);
		}

		JS_FreeValue(self->ctx, handler);
		JS_FreeValue(self->ctx, selfobj);
		JS_FreeValue(self->ctx, global);
	}
}

/* self.postMessage(value) — called from inside the worker */
static JSValue js_worker_self_postMessage(JSContext *ctx, JSValueConst this_val,
                                           int argc, JSValueConst *argv) {
	QNWorkerSelf *self = JS_GetContextOpaque(ctx);
	if (!self || self->pipe_closed)
		return JS_ThrowTypeError(ctx, "Worker pipe is closed");

	if (send_message((uv_stream_t *)&self->pipe, ctx, argv[0]) != 0)
		return JS_ThrowInternalError(ctx, "Failed to send message");

	return JS_UNDEFINED;
}

/* self.close() — called from inside the worker */
static JSValue js_worker_self_close(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
	QNWorkerSelf *self = JS_GetContextOpaque(ctx);
	if (self && !self->pipe_closed) {
		self->pipe_closed = true;
		uv_close((uv_handle_t *)&self->pipe, NULL);
	}
	return JS_UNDEFINED;
}

static void worker_thread_entry(void *arg) {
	QNWorkerThreadData *td = arg;

	if (!g_rt_init || !g_ctx_init) {
		fprintf(stderr, "Worker: init functions not set\n");
		goto cleanup_td;
	}

	/* Create runtime and context */
	JSRuntime *rt = JS_NewRuntime();
	if (!rt) {
		fprintf(stderr, "Worker: JS_NewRuntime failed\n");
		goto cleanup_td;
	}

	g_rt_init(rt);
	JSContext *ctx = g_ctx_init(rt);
	if (!ctx) {
		fprintf(stderr, "Worker: context creation failed\n");
		JS_FreeRuntime(rt);
		goto cleanup_td;
	}

	/* Initialize the event loop (uses _Thread_local state) */
	qn_vm_init(ctx);

	/* Run context setup: eval node-globals, set up source transform, etc. */
	if (g_ctx_setup)
		g_ctx_setup(ctx);

	/* Set up the worker-side pipe */
	uv_loop_t *loop = js_uv_loop(ctx);
	QNWorkerSelf self;
	memset(&self, 0, sizeof(self));
	self.ctx = ctx;
	self.pipe_closed = false;
	readbuf_init(&self.readbuf);

	uv_pipe_init(loop, &self.pipe, 0);
	uv_pipe_open(&self.pipe, td->fd);
	self.pipe.data = &self;

	/* Store self in context opaque for postMessage access */
	JS_SetContextOpaque(ctx, &self);

	/* Set up self global with postMessage and close */
	JSValue global = JS_GetGlobalObject(ctx);
	JSValue selfobj = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, selfobj, "postMessage",
	                   JS_NewCFunction(ctx, js_worker_self_postMessage, "postMessage", 1));
	JS_SetPropertyStr(ctx, selfobj, "close",
	                   JS_NewCFunction(ctx, js_worker_self_close, "close", 0));
	JS_SetPropertyStr(ctx, selfobj, "onmessage", JS_NULL);
	JS_SetPropertyStr(ctx, global, "self", selfobj);
	JS_FreeValue(ctx, global);

	/* Start reading messages from parent */
	uv_read_start((uv_stream_t *)&self.pipe, pipe_alloc_cb, worker_self_read_cb);

	/* Read the worker script from disk */
	size_t script_len;
	uint8_t *script_buf = js_load_file(ctx, &script_len, td->filename);
	if (!script_buf) {
		fprintf(stderr, "Worker: failed to read script '%s'\n", td->filename);
		goto cleanup_self;
	}

	/* Apply source transform (e.g. TypeScript stripping) before compilation.
	   This must happen after g_ctx_setup which registers the transform hook. */
	size_t transformed_len;
	script_buf = qn_apply_source_transform(ctx, script_buf, script_len,
	                                        td->filename, &transformed_len);
	if (!script_buf) {
		js_std_dump_error(ctx);
		goto cleanup_self;
	}
	script_len = transformed_len;

	/* Compile as a module. We use JS_Eval + JS_EvalFunction (2-promise chain)
	   instead of JS_LoadModule (4-promise chain with extra .then() wrapping)
	   because JS_LoadModule's intermediate promise states can trigger the
	   rejection tracker with a spurious JS_TAG_UNINITIALIZED rejection. */
	JSValue val = JS_Eval(ctx, (const char *)script_buf, script_len,
	                       td->filename, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
	js_free(ctx, script_buf);

	if (JS_IsException(val)) {
		js_std_dump_error(ctx);
	} else {
		if (JS_ResolveModule(ctx, val) < 0) {
			JS_FreeValue(ctx, val);
			js_std_dump_error(ctx);
			goto cleanup_self;
		}
		js_module_set_import_meta(ctx, val, FALSE, TRUE);
		JSValue eval_ret = JS_EvalFunction(ctx, val);
		if (JS_IsException(eval_ret))
			js_std_dump_error(ctx);
		JS_FreeValue(ctx, eval_ret);
	}

	/* Run the event loop */
	qn_vm_loop(ctx);

	/* Cleanup */
cleanup_self:
	readbuf_free(&self.readbuf);
	JS_SetContextOpaque(ctx, NULL);
	qn_vm_free(rt);
	qn_free_source_transform(rt);
	js_std_free_handlers(rt);
	JS_FreeContext(ctx);
	JS_FreeRuntime(rt);

cleanup_td:
	free(td->filename);
	free(td);
}

/* --------------------------------------------------------------------------
 * Parent-side JS class: Worker
 * -------------------------------------------------------------------------- */

static void qn_worker_finalizer(JSRuntime *rt, JSValue val) {
	QNWorker *w = JS_GetOpaque(val, qn_worker_class_id);
	if (!w) return;

	JS_FreeValueRT(rt, w->onmessage);
	JS_FreeValueRT(rt, w->onerror);
	/* this_val is already freed by close_cb or here if never started */
	if (!JS_IsUndefined(w->this_val))
		JS_FreeValueRT(rt, w->this_val);
	readbuf_free(&w->readbuf);
	js_free_rt(rt, w);
}

static void qn_worker_gc_mark(JSRuntime *rt, JSValueConst val,
                               JS_MarkFunc *mark_func) {
	QNWorker *w = JS_GetOpaque(val, qn_worker_class_id);
	if (!w) return;
	/* Mark callbacks so they're not collected */
	JS_MarkValue(rt, w->onmessage, mark_func);
	JS_MarkValue(rt, w->onerror, mark_func);
	/* Do NOT mark this_val — it's a prevent-GC ref (see CLAUDE.md pattern) */
}

static JSClassDef qn_worker_class = {
	"Worker",
	.finalizer = qn_worker_finalizer,
	.gc_mark = qn_worker_gc_mark,
};

/* Resolve a worker script path relative to the caller's directory.
   If filename is absolute, returns a copy; if relative, joins with
   the dirname of basename. Caller must free the result. */
static char *resolve_worker_path(const char *filename, const char *basename) {
	/* Absolute paths need no resolution */
	if (filename[0] == '/')
		return strdup(filename);

	/* Relative path: resolve against caller's directory */
	if (basename) {
		/* Strip embedded:// prefix if present */
		const char *base = basename;
		if (strncmp(base, "embedded://", 11) == 0)
			base += 11;
		/* Find last '/' to get dirname */
		const char *last_slash = strrchr(base, '/');
		if (last_slash) {
			size_t dir_len = last_slash - base + 1;
			size_t name_len = strlen(filename);
			char *resolved = malloc(dir_len + name_len + 1);
			memcpy(resolved, base, dir_len);
			memcpy(resolved + dir_len, filename, name_len + 1);
			return resolved;
		}
	}

	return strdup(filename);
}

/* JS: _create(filename) -> Worker handle */
static JSValue js_worker_create(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
	const char *filename = JS_ToCString(ctx, argv[0]);
	if (!filename)
		return JS_EXCEPTION;

	/* Get caller's module name for relative path resolution */
	const char *basename = NULL;
	JSAtom basename_atom = JS_GetScriptOrModuleName(ctx, 2);
	if (basename_atom != JS_ATOM_NULL) {
		basename = JS_AtomToCString(ctx, basename_atom);
		JS_FreeAtom(ctx, basename_atom);
	}

	/* Resolve the worker script path */
	char *resolved = resolve_worker_path(filename, basename);
	JS_FreeCString(ctx, filename);
	if (basename) JS_FreeCString(ctx, basename);

	if (!resolved)
		return JS_ThrowOutOfMemory(ctx);

	/* Create socketpair for bidirectional communication */
	uv_os_sock_t fds[2];
	int r = uv_socketpair(SOCK_STREAM, 0, fds, UV_NONBLOCK_PIPE, UV_NONBLOCK_PIPE);
	if (r != 0) {
		free(resolved);
		return qn_throw_errno(ctx, r);
	}

	/* Create the Worker JS object */
	JSValue obj = JS_NewObjectClass(ctx, qn_worker_class_id);
	if (JS_IsException(obj)) {
		close(fds[0]);
		close(fds[1]);
		free(resolved);
		return obj;
	}

	QNWorker *w = js_mallocz(ctx, sizeof(QNWorker));
	if (!w) {
		close(fds[0]);
		close(fds[1]);
		JS_FreeValue(ctx, obj);
		free(resolved);
		return JS_EXCEPTION;
	}

	w->ctx = ctx;
	w->onmessage = JS_UNDEFINED;
	w->onerror = JS_UNDEFINED;
	w->terminated = false;
	w->pipe_closed = false;
	readbuf_init(&w->readbuf);

	/* Prevent GC collection while pipe is active */
	w->this_val = JS_DupValue(ctx, obj);

	JS_SetOpaque(obj, w);

	/* Initialize parent-side pipe */
	uv_loop_t *loop = js_uv_loop(ctx);
	uv_pipe_init(loop, &w->pipe, 0);
	uv_pipe_open(&w->pipe, fds[0]);
	w->pipe.data = w;

	/* Start reading messages from worker */
	uv_read_start((uv_stream_t *)&w->pipe, pipe_alloc_cb, worker_read_cb);

	/* Prepare worker thread data */
	QNWorkerThreadData *td = malloc(sizeof(QNWorkerThreadData));
	td->fd = fds[1];
	td->filename = resolved;  /* ownership transferred */

	/* Spawn worker thread */
	r = uv_thread_create(&w->thread, worker_thread_entry, td);
	if (r != 0) {
		close(fds[1]);
		free(td->filename);
		free(td);
		/* Close parent pipe */
		w->pipe_closed = true;
		uv_close((uv_handle_t *)&w->pipe, worker_close_cb);
		JS_FreeValue(ctx, obj);
		return qn_throw_errno(ctx, r);
	}

	return obj;
}

/* JS: _postMessage(worker, value) */
static JSValue js_worker_postMessage(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
	QNWorker *w = JS_GetOpaque2(ctx, argv[0], qn_worker_class_id);
	if (!w)
		return JS_EXCEPTION;
	if (w->terminated || w->pipe_closed)
		return JS_ThrowTypeError(ctx, "Worker has been terminated");

	if (send_message((uv_stream_t *)&w->pipe, ctx, argv[1]) != 0)
		return JS_ThrowInternalError(ctx, "Failed to serialize message");

	return JS_UNDEFINED;
}

/* JS: _terminate(worker) */
static JSValue js_worker_terminate(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
	QNWorker *w = JS_GetOpaque2(ctx, argv[0], qn_worker_class_id);
	if (!w)
		return JS_EXCEPTION;
	if (w->terminated)
		return JS_UNDEFINED;

	w->terminated = true;

	/* Close the parent-side pipe. This causes the worker to get EOF,
	   which makes its event loop exit. */
	if (!w->pipe_closed) {
		w->pipe_closed = true;
		uv_read_stop((uv_stream_t *)&w->pipe);
		uv_close((uv_handle_t *)&w->pipe, worker_close_cb);
	}

	return JS_UNDEFINED;
}

/* JS: _setOnMessage(worker, callback) */
static JSValue js_worker_setOnMessage(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv) {
	QNWorker *w = JS_GetOpaque2(ctx, argv[0], qn_worker_class_id);
	if (!w)
		return JS_EXCEPTION;

	JS_FreeValue(ctx, w->onmessage);
	w->onmessage = JS_DupValue(ctx, argv[1]);
	return JS_UNDEFINED;
}

/* JS: _setOnError(worker, callback) */
static JSValue js_worker_setOnError(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
	QNWorker *w = JS_GetOpaque2(ctx, argv[0], qn_worker_class_id);
	if (!w)
		return JS_EXCEPTION;

	JS_FreeValue(ctx, w->onerror);
	w->onerror = JS_DupValue(ctx, argv[1]);
	return JS_UNDEFINED;
}

/* --------------------------------------------------------------------------
 * Module exports
 * -------------------------------------------------------------------------- */

static const JSCFunctionListEntry worker_funcs[] = {
	QN_CFUNC_DEF("_create", 1, js_worker_create),
	QN_CFUNC_DEF("_postMessage", 2, js_worker_postMessage),
	QN_CFUNC_DEF("_terminate", 1, js_worker_terminate),
	QN_CFUNC_DEF("_setOnMessage", 2, js_worker_setOnMessage),
	QN_CFUNC_DEF("_setOnError", 2, js_worker_setOnError),
};

static int js_worker_module_init(JSContext *ctx, JSModuleDef *m) {
	/* Register the Worker class */
	JS_NewClassID(&qn_worker_class_id);
	JS_NewClass(JS_GetRuntime(ctx), qn_worker_class_id, &qn_worker_class);

	return JS_SetModuleExportList(ctx, m, worker_funcs, countof(worker_funcs));
}

JSModuleDef *js_init_module_qn_worker(JSContext *ctx, const char *module_name) {
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_worker_module_init);
	if (!m) return NULL;
	JS_AddModuleExportList(ctx, m, worker_funcs, countof(worker_funcs));
	return m;
}

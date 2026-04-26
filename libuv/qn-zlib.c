/*
 * qn_zlib - DEFLATE/zlib compression via miniz
 *
 * Thin opcode-style binding. Exposes:
 *   - ZStream class wrapping a mz_stream (raw deflate or zlib framing)
 *   - process(stream, input, flush) — sync feed/flush
 *   - processAsync(stream, input, flush) -> Promise — same on libuv thread pool
 *   - crc32 / adler32 helpers used by JS for gzip framing
 *   - flush mode / strategy / level constants
 *
 * gzip framing (10-byte header + 8-byte trailer) is handled in
 * node/node/zlib.js on top of raw deflate, keeping C minimal.
 *
 * Threading: a single ZStream may have at most one async operation in
 * flight (enforced via the `busy` flag). Sync calls are rejected while
 * async work is pending; async calls reject if already busy. The JS
 * stream wrapper serializes writes per-stream to honor this.
 */

#include "qn-uv-utils.h"
#include "miniz.h"

#include <string.h>
#include <stdbool.h>
#include <stdlib.h>

/* Get pointer + length from a Uint8Array (Bellard QuickJS compatible). */
static uint8_t *qn_get_uint8array(JSContext *ctx, size_t *psize, JSValueConst obj) {
	size_t byte_offset, byte_length, elem_size;
	JSValue ab = JS_GetTypedArrayBuffer(ctx, obj, &byte_offset, &byte_length, &elem_size);
	if (JS_IsException(ab))
		return NULL;
	size_t ab_size;
	uint8_t *buf = JS_GetArrayBuffer(ctx, &ab_size, ab);
	JS_FreeValue(ctx, ab);
	if (!buf)
		return NULL;
	*psize = byte_length;
	return buf + byte_offset;
}

/* Wrap a malloc()'d buffer in a Uint8Array; the buffer is free()'d when
 * the underlying ArrayBuffer is collected. Use this for output produced
 * on a worker thread (which can't touch the QuickJS allocator). */
static void qn__buf_free_malloc(JSRuntime *rt, void *opaque, void *ptr) {
	(void)rt; (void)opaque;
	free(ptr);
}

static JSValue qn_new_uint8array_malloc(JSContext *ctx, uint8_t *data, size_t size) {
	JSValue abuf = JS_NewArrayBuffer(ctx, data, size, qn__buf_free_malloc, NULL, false);
	if (JS_IsException(abuf)) return abuf;

	JSValue args[3] = { abuf, JS_NewInt32(ctx, 0), JS_NewInt64(ctx, size) };
	JSValue global = JS_GetGlobalObject(ctx);
	JSValue ctor = JS_GetPropertyStr(ctx, global, "Uint8Array");
	JSValue u8 = JS_CallConstructor(ctx, ctor, 3, args);
	JS_FreeValue(ctx, ctor);
	JS_FreeValue(ctx, global);
	JS_FreeValue(ctx, abuf);
	return u8;
}

/* ---- ZStream: GC-safe mz_stream wrapper ---- */

typedef enum { ZSTREAM_DEFLATE, ZSTREAM_INFLATE } zstream_mode;

typedef struct {
	mz_stream s;
	zstream_mode mode;
	int initialized;
	int finished;  /* set once MZ_STREAM_END returned */
	int busy;      /* set while an async operation is in flight */
} ZStream;

static JSClassID zstream_class_id;

static void zstream_finalizer(JSRuntime *rt, JSValue val) {
	ZStream *z = JS_GetOpaque(val, zstream_class_id);
	if (!z) return;
	if (z->initialized) {
		if (z->mode == ZSTREAM_DEFLATE) mz_deflateEnd(&z->s);
		else mz_inflateEnd(&z->s);
	}
	js_free_rt(rt, z);
}

static JSClassDef zstream_class = {
	.class_name = "ZStream",
	.finalizer = zstream_finalizer,
};

/* deflateInit(level, windowBits, memLevel, strategy) -> ZStream */
static JSValue js_deflate_init(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	int32_t level, window_bits, mem_level, strategy;
	if (JS_ToInt32(ctx, &level, argv[0])) return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &window_bits, argv[1])) return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &mem_level, argv[2])) return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &strategy, argv[3])) return JS_EXCEPTION;

	ZStream *z = js_mallocz(ctx, sizeof(*z));
	if (!z) return JS_EXCEPTION;
	z->mode = ZSTREAM_DEFLATE;

	int r = mz_deflateInit2(&z->s, level, MZ_DEFLATED, window_bits, mem_level, strategy);
	if (r != MZ_OK) {
		js_free(ctx, z);
		return JS_ThrowInternalError(ctx, "deflateInit2 failed: %d", r);
	}
	z->initialized = 1;

	JSValue obj = JS_NewObjectClass(ctx, zstream_class_id);
	if (JS_IsException(obj)) {
		mz_deflateEnd(&z->s);
		js_free(ctx, z);
		return obj;
	}
	JS_SetOpaque(obj, z);
	return obj;
}

/* inflateInit(windowBits) -> ZStream */
static JSValue js_inflate_init(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	int32_t window_bits;
	if (JS_ToInt32(ctx, &window_bits, argv[0])) return JS_EXCEPTION;

	ZStream *z = js_mallocz(ctx, sizeof(*z));
	if (!z) return JS_EXCEPTION;
	z->mode = ZSTREAM_INFLATE;

	int r = mz_inflateInit2(&z->s, window_bits);
	if (r != MZ_OK) {
		js_free(ctx, z);
		return JS_ThrowInternalError(ctx, "inflateInit2 failed: %d", r);
	}
	z->initialized = 1;

	JSValue obj = JS_NewObjectClass(ctx, zstream_class_id);
	if (JS_IsException(obj)) {
		mz_inflateEnd(&z->s);
		js_free(ctx, z);
		return obj;
	}
	JS_SetOpaque(obj, z);
	return obj;
}

/* ---- Core process loop (allocator-agnostic) ----
 *
 * Runs the miniz engine until no further forward progress can be made
 * on the supplied input (or until MZ_STREAM_END). Output is written into
 * a buffer that grows via realloc-style callbacks supplied by the caller,
 * so this function can run either on the main thread (with js_malloc)
 * or on a worker thread (with plain malloc).
 *
 * Returns 0 on success; on error, sets *out_status to the miniz return
 * code, *out_msg to a strdup'd error message (or NULL), and frees out_buf. */
typedef void *(*alloc_fn)(size_t);
typedef void *(*realloc_fn)(void *, size_t);
typedef void  (*free_fn)(void *);

static int qn_zlib_run(ZStream *z, const uint8_t *in_buf, size_t in_len, int flush,
                       alloc_fn xalloc, realloc_fn xrealloc, free_fn xfree,
                       uint8_t **out_buf_p, size_t *out_len_p, size_t *consumed_p,
                       int *out_status, char **out_msg) {
	*out_buf_p = NULL;
	*out_len_p = 0;
	*consumed_p = 0;
	*out_status = MZ_OK;
	*out_msg = NULL;

	size_t out_cap = in_len > 32 ? in_len * 2 : 64;
	uint8_t *out_buf = (uint8_t *)xalloc(out_cap);
	if (!out_buf) { *out_status = MZ_MEM_ERROR; return -1; }
	size_t out_len = 0;

	z->s.next_in = (unsigned char *)in_buf;
	z->s.avail_in = (unsigned int)in_len;

	for (;;) {
		if (out_len == out_cap) {
			size_t new_cap = out_cap * 2;
			uint8_t *nb = (uint8_t *)xrealloc(out_buf, new_cap);
			if (!nb) { xfree(out_buf); *out_status = MZ_MEM_ERROR; return -1; }
			out_buf = nb; out_cap = new_cap;
		}

		z->s.next_out = out_buf + out_len;
		z->s.avail_out = (unsigned int)(out_cap - out_len);

		unsigned int prev_in = z->s.avail_in;
		unsigned int prev_out = z->s.avail_out;
		int r;
		if (z->mode == ZSTREAM_DEFLATE) {
			r = mz_deflate(&z->s, flush);
		} else {
			/* mz_inflate's MZ_FINISH fast path requires the output buffer
			 * to fit the entire decompressed result up front. We grow the
			 * output buffer dynamically, so always use MZ_SYNC_FLUSH and
			 * let inflate detect end-of-stream from the data itself. */
			r = mz_inflate(&z->s, MZ_SYNC_FLUSH);
		}
		bool consumed_now = z->s.avail_in  < prev_in;
		bool produced_now = z->s.avail_out < prev_out;
		out_len += prev_out - z->s.avail_out;

		if (r == MZ_STREAM_END) { z->finished = 1; break; }
		if (r != MZ_OK && r != MZ_BUF_ERROR) {
			*out_status = r;
			if (z->s.msg) {
				size_t n = strlen(z->s.msg);
				char *m = (char *)xalloc(n + 1);
				if (m) { memcpy(m, z->s.msg, n + 1); *out_msg = m; }
			}
			xfree(out_buf);
			return -1;
		}

		if (z->s.avail_out == 0) continue;
		if (!consumed_now && !produced_now) break;
		if (z->mode == ZSTREAM_DEFLATE && flush == MZ_NO_FLUSH && z->s.avail_in == 0)
			break;
	}

	*consumed_p = in_len - z->s.avail_in;

	/* Shrink to actual length. Keep at least 1 byte so the freer has
	 * something to free even on empty output. */
	if (out_len < out_cap) {
		uint8_t *nb = (uint8_t *)xrealloc(out_buf, out_len ? out_len : 1);
		if (nb) out_buf = nb;
	}
	*out_buf_p = out_buf;
	*out_len_p = out_len;
	return 0;
}

/* ---- Sync process ---- */

/* JS-allocator wrappers — defined here so qn_zlib_run can call them without
 * needing the JSContext (which it doesn't have on the worker path). */
static _Thread_local JSContext *g_alloc_ctx;
static void *jsx_alloc(size_t n) { return js_malloc(g_alloc_ctx, n); }
static void *jsx_realloc(void *p, size_t n) { return js_realloc(g_alloc_ctx, p, n); }
static void  jsx_free(void *p) { js_free(g_alloc_ctx, p); }

static JSValue zlib_make_error(JSContext *ctx, int mz_status, const char *msg) {
	JSValue err = JS_NewError(ctx);
	JS_DefinePropertyValueStr(ctx, err, "message",
		JS_NewString(ctx, msg && *msg ? msg : "zlib error"), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, err, "errno", JS_NewInt32(ctx, mz_status), JS_PROP_C_W_E);
	/* JS shim translates errno -> Node-style .code. */
	return err;
}

static JSValue zlib_make_result(JSContext *ctx, uint8_t *out_buf, size_t out_len,
                                size_t consumed, bool finished, bool from_malloc) {
	JSValue out = from_malloc
		? qn_new_uint8array_malloc(ctx, out_buf, out_len)
		: qn_new_uint8array(ctx, out_buf, out_len);
	if (JS_IsException(out)) return out;
	JSValue obj = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, obj, "output", out);
	JS_SetPropertyStr(ctx, obj, "consumed", JS_NewInt64(ctx, (int64_t)consumed));
	JS_SetPropertyStr(ctx, obj, "done", JS_NewBool(ctx, finished));
	return obj;
}

/* process(stream, input | null, flush) -> { output: Uint8Array, consumed: number, done: bool } */
static JSValue js_process(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
	ZStream *z = JS_GetOpaque2(ctx, argv[0], zstream_class_id);
	if (!z) return JS_EXCEPTION;
	if (z->busy)
		return JS_ThrowInternalError(ctx, "stream busy with async operation");

	size_t in_len = 0;
	uint8_t *in_buf = NULL;
	if (!JS_IsNull(argv[1]) && !JS_IsUndefined(argv[1])) {
		in_buf = qn_get_uint8array(ctx, &in_len, argv[1]);
		if (!in_buf && in_len) return JS_EXCEPTION;
	}

	int32_t flush;
	if (JS_ToInt32(ctx, &flush, argv[2])) return JS_EXCEPTION;

	if (z->finished) {
		if (in_len > 0)
			return JS_ThrowInternalError(ctx, "stream already finished");
		uint8_t *empty = js_malloc(ctx, 1);
		if (!empty) return JS_EXCEPTION;
		return zlib_make_result(ctx, empty, 0, 0, true, false);
	}

	g_alloc_ctx = ctx;
	uint8_t *out_buf;
	size_t out_len, consumed;
	int status;
	char *err_msg = NULL;
	int rc = qn_zlib_run(z, in_buf, in_len, flush,
		jsx_alloc, jsx_realloc, jsx_free,
		&out_buf, &out_len, &consumed, &status, &err_msg);
	g_alloc_ctx = NULL;

	if (rc != 0) {
		JSValue err = zlib_make_error(ctx, status, err_msg);
		if (err_msg) js_free(ctx, err_msg);
		return JS_Throw(ctx, err);
	}

	return zlib_make_result(ctx, out_buf, out_len, consumed, z->finished, false);
}

/* ---- Async process via uv_queue_work ---- */

typedef struct {
	uv_work_t req;
	JSContext *ctx;
	ZStream *z;
	JSValue stream_ref;   /* dup'd to keep the JS wrapper alive across the work */
	uint8_t *in_buf;      /* malloc'd copy of input (worker can't touch js heap) */
	size_t in_len;
	int flush;
	/* Filled by worker */
	uint8_t *out_buf;
	size_t out_len;
	size_t consumed;
	int rc;               /* 0 ok, -1 error */
	int status;           /* miniz status on error */
	char *err_msg;
	QNPromise result;
} ZlibAsyncReq;

static void zlib_async_work(uv_work_t *req) {
	ZlibAsyncReq *r = req->data;
	r->rc = qn_zlib_run(r->z, r->in_buf, r->in_len, r->flush,
		malloc, realloc, free,
		&r->out_buf, &r->out_len, &r->consumed, &r->status, &r->err_msg);
}

static void zlib_async_after(uv_work_t *req, int uv_status) {
	ZlibAsyncReq *r = req->data;
	JSContext *ctx = r->ctx;
	r->z->busy = 0;

	JSValue arg;
	bool reject = false;
	if (uv_status == UV_ECANCELED) {
		arg = qn_new_error(ctx, uv_status);
		reject = true;
	} else if (r->rc != 0) {
		arg = zlib_make_error(ctx, r->status, r->err_msg);
		reject = true;
	} else {
		arg = zlib_make_result(ctx, r->out_buf, r->out_len, r->consumed, r->z->finished, true);
		if (JS_IsException(arg)) {
			/* result construction failed — out_buf was already attached to
			 * the ArrayBuffer by qn_new_uint8array_malloc, so don't free it
			 * again. Pull the pending exception as the rejection value. */
			arg = JS_GetException(ctx);
			reject = true;
		}
	}

	qn_promise_settle(ctx, &r->result, reject, 1, &arg);
	/* qn_promise_settle takes ownership of arg — do not JS_FreeValue it again. */

	JS_FreeValue(ctx, r->stream_ref);
	free(r->in_buf);
	if (r->err_msg) free(r->err_msg);
	js_free(ctx, r);
}

/* processAsync(stream, input | null, flush) -> Promise<{output, consumed, done}> */
static JSValue js_process_async(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	ZStream *z = JS_GetOpaque2(ctx, argv[0], zstream_class_id);
	if (!z) return JS_EXCEPTION;
	if (z->busy)
		return JS_ThrowInternalError(ctx, "stream busy with async operation");

	size_t in_len = 0;
	uint8_t *in_src = NULL;
	if (!JS_IsNull(argv[1]) && !JS_IsUndefined(argv[1])) {
		in_src = qn_get_uint8array(ctx, &in_len, argv[1]);
		if (!in_src && in_len) return JS_EXCEPTION;
	}

	int32_t flush;
	if (JS_ToInt32(ctx, &flush, argv[2])) return JS_EXCEPTION;

	/* No-op shortcut for already-finished + empty input — return a resolved
	 * promise so callers don't have to special-case it. */
	if (z->finished) {
		if (in_len > 0)
			return JS_ThrowInternalError(ctx, "stream already finished");
		uint8_t *empty = js_malloc(ctx, 1);
		if (!empty) return JS_EXCEPTION;
		JSValue obj = zlib_make_result(ctx, empty, 0, 0, true, false);
		if (JS_IsException(obj)) return obj;
		return qn_new_resolved_promise(ctx, 1, &obj);
		/* qn_new_resolved_promise takes ownership of obj. */
	}

	ZlibAsyncReq *r = js_mallocz(ctx, sizeof(*r));
	if (!r) return JS_EXCEPTION;

	if (in_len > 0) {
		r->in_buf = malloc(in_len);
		if (!r->in_buf) { js_free(ctx, r); return JS_ThrowOutOfMemory(ctx); }
		memcpy(r->in_buf, in_src, in_len);
	}
	r->in_len = in_len;
	r->flush = flush;
	r->ctx = ctx;
	r->z = z;
	r->stream_ref = JS_DupValue(ctx, argv[0]);
	r->req.data = r;

	JSValue promise = qn_promise_init(ctx, &r->result);
	if (JS_IsException(promise)) {
		JS_FreeValue(ctx, r->stream_ref);
		free(r->in_buf);
		js_free(ctx, r);
		return promise;
	}

	z->busy = 1;
	int qrc = uv_queue_work(js_uv_loop(ctx), &r->req, zlib_async_work, zlib_async_after);
	if (qrc != 0) {
		z->busy = 0;
		qn_promise_clear(ctx, &r->result);
		JS_FreeValue(ctx, r->stream_ref);
		free(r->in_buf);
		js_free(ctx, r);
		return qn_throw_errno(ctx, qrc);
	}
	return promise;
}

/* reset(stream) — reinitialize for reuse */
static JSValue js_reset(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv) {
	ZStream *z = JS_GetOpaque2(ctx, argv[0], zstream_class_id);
	if (!z) return JS_EXCEPTION;
	if (z->busy)
		return JS_ThrowInternalError(ctx, "stream busy with async operation");
	int r = (z->mode == ZSTREAM_DEFLATE) ? mz_deflateReset(&z->s) : mz_inflateReset(&z->s);
	if (r != MZ_OK) return JS_ThrowInternalError(ctx, "reset failed: %d", r);
	z->finished = 0;
	return JS_UNDEFINED;
}

/* end(stream) — explicit cleanup (also done at GC) */
static JSValue js_end(JSContext *ctx, JSValueConst this_val,
                      int argc, JSValueConst *argv) {
	ZStream *z = JS_GetOpaque2(ctx, argv[0], zstream_class_id);
	if (!z) return JS_EXCEPTION;
	if (z->busy)
		return JS_ThrowInternalError(ctx, "stream busy with async operation");
	if (z->initialized) {
		if (z->mode == ZSTREAM_DEFLATE) mz_deflateEnd(&z->s);
		else mz_inflateEnd(&z->s);
		z->initialized = 0;
	}
	return JS_UNDEFINED;
}

/* crc32(prev, data) -> uint32 */
static JSValue js_crc32(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv) {
	int64_t prev_i;
	if (JS_ToInt64(ctx, &prev_i, argv[0])) return JS_EXCEPTION;
	mz_ulong prev = (mz_ulong)(uint32_t)prev_i;

	size_t len = 0;
	uint8_t *buf = NULL;
	if (!JS_IsNull(argv[1]) && !JS_IsUndefined(argv[1])) {
		buf = qn_get_uint8array(ctx, &len, argv[1]);
		if (!buf && len) return JS_EXCEPTION;
	}

	mz_ulong c = mz_crc32(prev, buf, len);
	return JS_NewInt64(ctx, (int64_t)(uint32_t)c);
}

/* adler32(prev, data) -> uint32 */
static JSValue js_adler32(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
	int64_t prev_i;
	if (JS_ToInt64(ctx, &prev_i, argv[0])) return JS_EXCEPTION;
	mz_ulong prev = (mz_ulong)(uint32_t)prev_i;

	size_t len = 0;
	uint8_t *buf = NULL;
	if (!JS_IsNull(argv[1]) && !JS_IsUndefined(argv[1])) {
		buf = qn_get_uint8array(ctx, &len, argv[1]);
		if (!buf && len) return JS_EXCEPTION;
	}

	mz_ulong c = mz_adler32(prev, buf, len);
	return JS_NewInt64(ctx, (int64_t)(uint32_t)c);
}

static const JSCFunctionListEntry js_zlib_funcs[] = {
	QN_CFUNC_DEF("deflateInit", 4, js_deflate_init),
	QN_CFUNC_DEF("inflateInit", 1, js_inflate_init),
	QN_CFUNC_DEF("process", 3, js_process),
	QN_CFUNC_DEF("processAsync", 3, js_process_async),
	QN_CFUNC_DEF("reset", 1, js_reset),
	QN_CFUNC_DEF("end", 1, js_end),
	QN_CFUNC_DEF("crc32", 2, js_crc32),
	QN_CFUNC_DEF("adler32", 2, js_adler32),
	/* Flush modes */
	QN_CONST2("Z_NO_FLUSH", MZ_NO_FLUSH),
	QN_CONST2("Z_PARTIAL_FLUSH", MZ_PARTIAL_FLUSH),
	QN_CONST2("Z_SYNC_FLUSH", MZ_SYNC_FLUSH),
	QN_CONST2("Z_FULL_FLUSH", MZ_FULL_FLUSH),
	QN_CONST2("Z_FINISH", MZ_FINISH),
	QN_CONST2("Z_BLOCK", MZ_BLOCK),
	/* Strategies */
	QN_CONST2("Z_DEFAULT_STRATEGY", MZ_DEFAULT_STRATEGY),
	QN_CONST2("Z_FILTERED", MZ_FILTERED),
	QN_CONST2("Z_HUFFMAN_ONLY", MZ_HUFFMAN_ONLY),
	QN_CONST2("Z_RLE", MZ_RLE),
	QN_CONST2("Z_FIXED", MZ_FIXED),
	/* Levels */
	QN_CONST2("Z_DEFAULT_COMPRESSION", MZ_DEFAULT_COMPRESSION),
	QN_CONST2("Z_NO_COMPRESSION", MZ_NO_COMPRESSION),
	QN_CONST2("Z_BEST_SPEED", MZ_BEST_SPEED),
	QN_CONST2("Z_BEST_COMPRESSION", MZ_BEST_COMPRESSION),
	/* Window bits sentinel */
	QN_CONST2("Z_DEFAULT_WINDOW_BITS", MZ_DEFAULT_WINDOW_BITS),
	/* Status / error codes (miniz return values) */
	QN_CONST2("Z_OK",            MZ_OK),
	QN_CONST2("Z_STREAM_END",    MZ_STREAM_END),
	QN_CONST2("Z_NEED_DICT",     MZ_NEED_DICT),
	QN_CONST2("Z_ERRNO",         MZ_ERRNO),
	QN_CONST2("Z_STREAM_ERROR",  MZ_STREAM_ERROR),
	QN_CONST2("Z_DATA_ERROR",    MZ_DATA_ERROR),
	QN_CONST2("Z_MEM_ERROR",     MZ_MEM_ERROR),
	QN_CONST2("Z_BUF_ERROR",     MZ_BUF_ERROR),
	QN_CONST2("Z_VERSION_ERROR", MZ_VERSION_ERROR),
	QN_CONST2("Z_PARAM_ERROR",   MZ_PARAM_ERROR),
};

static int js_zlib_init(JSContext *ctx, JSModuleDef *m) {
	JS_NewClassID(&zstream_class_id);
	JS_NewClass(JS_GetRuntime(ctx), zstream_class_id, &zstream_class);
	return JS_SetModuleExportList(ctx, m, js_zlib_funcs, countof(js_zlib_funcs));
}

JSModuleDef *js_init_module_qn_zlib(JSContext *ctx, const char *module_name) {
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_zlib_init);
	if (!m) return NULL;
	JS_AddModuleExportList(ctx, m, js_zlib_funcs, countof(js_zlib_funcs));
	return m;
}

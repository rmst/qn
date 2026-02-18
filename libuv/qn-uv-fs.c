/*
 * qn_uv_fs - Async filesystem operations via libuv for QuickJS
 */

#include "quickjs/quickjs.h"
#include "quickjs/cutils.h"
#include <uv.h>
#include <string.h>
#include <stdlib.h>
#include <fcntl.h>

extern uv_loop_t *js_uv_loop(JSContext *ctx);

/* ---- promise helper ---- */

typedef struct {
	JSContext *ctx;
	JSValue resolving_funcs[2]; /* [resolve, reject] */
} QNPromise;

static int qn_promise_init(JSContext *ctx, QNPromise *p, JSValue *promise_out) {
	p->ctx = ctx;
	*promise_out = JS_NewPromiseCapability(ctx, p->resolving_funcs);
	if (JS_IsException(*promise_out))
		return -1;
	return 0;
}

static void qn_promise_settle(QNPromise *p, int is_reject, JSValue val) {
	JSContext *ctx = p->ctx;
	JSValue ret = JS_Call(ctx, p->resolving_funcs[is_reject ? 1 : 0],
	                      JS_UNDEFINED, 1, &val);
	JS_FreeValue(ctx, ret);
	JS_FreeValue(ctx, val);
	JS_FreeValue(ctx, p->resolving_funcs[0]);
	JS_FreeValue(ctx, p->resolving_funcs[1]);
}

/* ---- fs request struct ---- */

typedef struct {
	uv_fs_t req;
	QNPromise promise;
	char *path;         /* duped path for error messages */
	int fd;             /* for multi-step chains */
	uint8_t *buf;       /* read buffer */
	size_t buf_size;
	int encoding;       /* 0=buffer, 1=utf8 */
	uint8_t *write_buf; /* write data (copied) */
	size_t write_len;
	int free_write_buf; /* whether to free write_buf */
} QNFsReq;

static QNFsReq *qn_fs_req_alloc(JSContext *ctx) {
	QNFsReq *fr = (QNFsReq *)malloc(sizeof(QNFsReq));
	if (!fr) return NULL;
	memset(fr, 0, sizeof(QNFsReq));
	fr->fd = -1;
	fr->req.data = fr;
	return fr;
}

static void qn_fs_req_free(QNFsReq *fr) {
	uv_fs_req_cleanup(&fr->req);
	if (fr->path) free(fr->path);
	if (fr->buf) js_free(fr->promise.ctx, fr->buf);
	if (fr->free_write_buf && fr->write_buf) free(fr->write_buf);
	free(fr);
}

/* ---- error helpers ---- */

static const char *errno_code(int uv_err) {
	switch (uv_err) {
	case UV_ENOENT: return "ENOENT";
	case UV_EACCES: return "EACCES";
	case UV_EEXIST: return "EEXIST";
	case UV_ENOTDIR: return "ENOTDIR";
	case UV_EISDIR: return "EISDIR";
	case UV_ENOSPC: return "ENOSPC";
	case UV_EPERM: return "EPERM";
	case UV_ENOTEMPTY: return "ENOTEMPTY";
	case UV_EBADF: return "EBADF";
	default: return "EIO";
	}
}

static JSValue make_fs_error(JSContext *ctx, int uv_err,
                             const char *syscall, const char *path) {
	JSValue err = JS_NewError(ctx);
	if (JS_IsException(err))
		return JS_EXCEPTION;

	const char *code = errno_code(uv_err);
	const char *msg = uv_strerror(uv_err);

	/* format: "CODE: msg, syscall 'path'" or "CODE: msg, syscall" */
	char buf[1024];
	if (path)
		snprintf(buf, sizeof(buf), "%s: %s, %s '%s'", code, msg, syscall, path);
	else
		snprintf(buf, sizeof(buf), "%s: %s, %s", code, msg, syscall);

	JS_DefinePropertyValueStr(ctx, err, "message",
		JS_NewString(ctx, buf), JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	JS_DefinePropertyValueStr(ctx, err, "code",
		JS_NewString(ctx, code), JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	JS_DefinePropertyValueStr(ctx, err, "errno",
		JS_NewInt32(ctx, uv_err), JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	JS_DefinePropertyValueStr(ctx, err, "syscall",
		JS_NewString(ctx, syscall), JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	if (path) {
		JS_DefinePropertyValueStr(ctx, err, "path",
			JS_NewString(ctx, path), JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	}
	return err;
}

/* ---- stat result helper ---- */

static JSValue make_stat_obj(JSContext *ctx, const uv_stat_t *s) {
	JSValue obj = JS_NewObject(ctx);
	if (JS_IsException(obj))
		return JS_EXCEPTION;

	JS_DefinePropertyValueStr(ctx, obj, "dev",
		JS_NewInt64(ctx, s->st_dev), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, obj, "ino",
		JS_NewInt64(ctx, s->st_ino), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, obj, "mode",
		JS_NewInt32(ctx, s->st_mode), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, obj, "nlink",
		JS_NewInt64(ctx, s->st_nlink), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, obj, "uid",
		JS_NewInt32(ctx, s->st_uid), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, obj, "gid",
		JS_NewInt32(ctx, s->st_gid), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, obj, "rdev",
		JS_NewInt64(ctx, s->st_rdev), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, obj, "size",
		JS_NewInt64(ctx, s->st_size), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, obj, "blksize",
		JS_NewInt64(ctx, s->st_blksize), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, obj, "blocks",
		JS_NewInt64(ctx, s->st_blocks), JS_PROP_C_W_E);

	double atime_ms = s->st_atim.tv_sec * 1000.0 + s->st_atim.tv_nsec / 1e6;
	double mtime_ms = s->st_mtim.tv_sec * 1000.0 + s->st_mtim.tv_nsec / 1e6;
	double ctime_ms = s->st_ctim.tv_sec * 1000.0 + s->st_ctim.tv_nsec / 1e6;
	double birthtime_ms = s->st_birthtim.tv_sec != 0
		? s->st_birthtim.tv_sec * 1000.0 + s->st_birthtim.tv_nsec / 1e6
		: ctime_ms;

	JS_DefinePropertyValueStr(ctx, obj, "atimeMs",
		JS_NewFloat64(ctx, atime_ms), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, obj, "mtimeMs",
		JS_NewFloat64(ctx, mtime_ms), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, obj, "ctimeMs",
		JS_NewFloat64(ctx, ctime_ms), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, obj, "birthtimeMs",
		JS_NewFloat64(ctx, birthtime_ms), JS_PROP_C_W_E);

	return obj;
}

/* ==== readFile ==== */

static void readfile_on_close(uv_fs_t *req);
static void readfile_on_read(uv_fs_t *req);
static void readfile_on_fstat(uv_fs_t *req);
static void readfile_on_open(uv_fs_t *req);

static void readfile_on_open(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "open", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		qn_fs_req_free(fr);
		return;
	}

	fr->fd = (int)req->result;
	uv_fs_req_cleanup(req);

	int r = uv_fs_fstat(js_uv_loop(ctx), &fr->req, fr->fd, readfile_on_fstat);
	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "fstat", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		qn_fs_req_free(fr);
	}
}

static void readfile_on_fstat(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "fstat", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		qn_fs_req_free(fr);
		return;
	}

	size_t size = (size_t)req->statbuf.st_size;
	uv_fs_req_cleanup(req);

	fr->buf_size = size;
	if (size > 0) {
		fr->buf = (uint8_t *)js_mallocz(ctx, size);
		if (!fr->buf) {
			JSValue err = JS_NewError(ctx);
			JS_DefinePropertyValueStr(ctx, err, "message",
				JS_NewString(ctx, "ENOMEM: out of memory, read"),
				JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
			qn_promise_settle(&fr->promise, 1, err);
			qn_fs_req_free(fr);
			return;
		}
	}

	uv_buf_t uvbuf = uv_buf_init((char *)fr->buf, size);
	int r = uv_fs_read(js_uv_loop(ctx), &fr->req, fr->fd, &uvbuf, 1, 0,
	                    readfile_on_read);
	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "read", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		qn_fs_req_free(fr);
	}
}

static void readfile_on_read(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "read", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		qn_fs_req_free(fr);
		return;
	}

	/* actual bytes read might differ from expected for special files */
	size_t nread = (size_t)req->result;
	uv_fs_req_cleanup(req);

	int r = uv_fs_close(js_uv_loop(ctx), &fr->req, fr->fd, readfile_on_close);
	fr->fd = -1;
	if (r < 0) {
		/* still deliver data even if close fails */
		JSValue val;
		if (fr->encoding == 1)
			val = JS_NewStringLen(ctx, (const char *)fr->buf, nread);
		else
			val = JS_NewArrayBufferCopy(ctx, fr->buf, nread);
		qn_promise_settle(&fr->promise, 0, val);
		qn_fs_req_free(fr);
	}
}

static void readfile_on_close(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	uv_fs_req_cleanup(req);

	JSValue val;
	if (fr->encoding == 1)
		val = JS_NewStringLen(ctx, (const char *)fr->buf, fr->buf_size);
	else
		val = JS_NewArrayBufferCopy(ctx, fr->buf, fr->buf_size);

	qn_promise_settle(&fr->promise, 0, val);
	qn_fs_req_free(fr);
}

static JSValue js_uv_readFile(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	int use_utf8 = 0;
	if (argc > 1)
		use_utf8 = JS_ToBool(ctx, argv[1]);

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	fr->path = strdup(path);
	fr->encoding = use_utf8 ? 1 : 0;

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_open(js_uv_loop(ctx), &fr->req, path, O_RDONLY, 0,
	                    readfile_on_open);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "open", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	return promise;
}

/* ==== writeFile ==== */

static void writefile_on_close(uv_fs_t *req);
static void writefile_on_write(uv_fs_t *req);
static void writefile_on_open(uv_fs_t *req);

static void writefile_on_open(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "open", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		qn_fs_req_free(fr);
		return;
	}

	fr->fd = (int)req->result;
	uv_fs_req_cleanup(req);

	uv_buf_t uvbuf = uv_buf_init((char *)fr->write_buf, fr->write_len);
	int r = uv_fs_write(js_uv_loop(ctx), &fr->req, fr->fd, &uvbuf, 1, 0,
	                     writefile_on_write);
	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "write", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		qn_fs_req_free(fr);
	}
}

static void writefile_on_write(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "write", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		qn_fs_req_free(fr);
		return;
	}

	uv_fs_req_cleanup(req);

	int r = uv_fs_close(js_uv_loop(ctx), &fr->req, fr->fd, writefile_on_close);
	fr->fd = -1;
	if (r < 0) {
		/* write succeeded, close failed - still resolve */
		qn_promise_settle(&fr->promise, 0, JS_UNDEFINED);
		qn_fs_req_free(fr);
	}
}

static void writefile_on_close(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;

	uv_fs_req_cleanup(req);
	qn_promise_settle(&fr->promise, 0, JS_UNDEFINED);
	qn_fs_req_free(fr);
}

static JSValue js_uv_writeFile(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	/* extract data from string, ArrayBuffer, or TypedArray */
	uint8_t *data = NULL;
	size_t data_len = 0;

	if (JS_IsString(argv[1])) {
		size_t len;
		const char *str = JS_ToCStringLen(ctx, &len, argv[1]);
		if (!str) {
			JS_FreeCString(ctx, path);
			return JS_EXCEPTION;
		}
		data = (uint8_t *)str;
		data_len = len;
	} else {
		/* try ArrayBuffer first */
		size_t len;
		uint8_t *ptr = JS_GetArrayBuffer(ctx, &len, argv[1]);
		if (ptr) {
			data = ptr;
			data_len = len;
		} else {
			/* try TypedArray */
			JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[1], NULL, NULL, NULL);
			if (!JS_IsException(ab)) {
				ptr = JS_GetArrayBuffer(ctx, &len, ab);
				JS_FreeValue(ctx, ab);
				if (ptr) {
					data = ptr;
					data_len = len;
				}
			}
		}
		if (!data) {
			JS_FreeCString(ctx, path);
			return JS_ThrowTypeError(ctx, "writeFile: data must be string, ArrayBuffer, or TypedArray");
		}
	}

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) {
		if (JS_IsString(argv[1]))
			JS_FreeCString(ctx, (const char *)data);
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	/* copy data since originals may be GC'd before async completes */
	fr->write_buf = (uint8_t *)malloc(data_len);
	if (!fr->write_buf && data_len > 0) {
		if (JS_IsString(argv[1]))
			JS_FreeCString(ctx, (const char *)data);
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	if (data_len > 0)
		memcpy(fr->write_buf, data, data_len);
	fr->write_len = data_len;
	fr->free_write_buf = 1;

	if (JS_IsString(argv[1]))
		JS_FreeCString(ctx, (const char *)data);

	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_open(js_uv_loop(ctx), &fr->req, path,
	                    O_WRONLY | O_CREAT | O_TRUNC, 0666,
	                    writefile_on_open);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "open", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	return promise;
}

/* ==== simple single-request operations ==== */

/* ---- stat ---- */

static void stat_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "stat", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
	} else {
		JSValue obj = make_stat_obj(ctx, &req->statbuf);
		qn_promise_settle(&fr->promise, 0, obj);
	}
	qn_fs_req_free(fr);
}

static JSValue js_uv_stat(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_stat(js_uv_loop(ctx), &fr->req, path, stat_cb);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "stat", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ---- lstat ---- */

static void lstat_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "lstat", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
	} else {
		JSValue obj = make_stat_obj(ctx, &req->statbuf);
		qn_promise_settle(&fr->promise, 0, obj);
	}
	qn_fs_req_free(fr);
}

static JSValue js_uv_lstat(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_lstat(js_uv_loop(ctx), &fr->req, path, lstat_cb);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "lstat", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ---- readdir ---- */

static void readdir_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "scandir", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		qn_fs_req_free(fr);
		return;
	}

	JSValue arr = JS_NewArray(ctx);
	if (JS_IsException(arr)) {
		qn_promise_settle(&fr->promise, 1, JS_EXCEPTION);
		qn_fs_req_free(fr);
		return;
	}

	uv_dirent_t ent;
	uint32_t i = 0;
	while (uv_fs_scandir_next(req, &ent) != UV_EOF) {
		JS_DefinePropertyValueUint32(ctx, arr, i,
			JS_NewString(ctx, ent.name), JS_PROP_C_W_E);
		i++;
	}

	qn_promise_settle(&fr->promise, 0, arr);
	qn_fs_req_free(fr);
}

static JSValue js_uv_readdir(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_scandir(js_uv_loop(ctx), &fr->req, path, 0, readdir_cb);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "scandir", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ---- mkdir ---- */

static void mkdir_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "mkdir", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
	} else {
		qn_promise_settle(&fr->promise, 0, JS_UNDEFINED);
	}
	qn_fs_req_free(fr);
}

static JSValue js_uv_mkdir(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	int mode = 0777;
	if (argc > 1)
		JS_ToInt32(ctx, &mode, argv[1]);

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_mkdir(js_uv_loop(ctx), &fr->req, path, mode, mkdir_cb);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "mkdir", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ---- unlink ---- */

static void unlink_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "unlink", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
	} else {
		qn_promise_settle(&fr->promise, 0, JS_UNDEFINED);
	}
	qn_fs_req_free(fr);
}

static JSValue js_uv_unlink(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_unlink(js_uv_loop(ctx), &fr->req, path, unlink_cb);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "unlink", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ---- rmdir ---- */

static void rmdir_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "rmdir", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
	} else {
		qn_promise_settle(&fr->promise, 0, JS_UNDEFINED);
	}
	qn_fs_req_free(fr);
}

static JSValue js_uv_rmdir(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_rmdir(js_uv_loop(ctx), &fr->req, path, rmdir_cb);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "rmdir", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ---- rename ---- */

static void rename_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "rename", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
	} else {
		qn_promise_settle(&fr->promise, 0, JS_UNDEFINED);
	}
	qn_fs_req_free(fr);
}

static JSValue js_uv_rename(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	const char *old_path = JS_ToCString(ctx, argv[0]);
	if (!old_path) return JS_EXCEPTION;
	const char *new_path = JS_ToCString(ctx, argv[1]);
	if (!new_path) {
		JS_FreeCString(ctx, old_path);
		return JS_EXCEPTION;
	}

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) {
		JS_FreeCString(ctx, old_path);
		JS_FreeCString(ctx, new_path);
		return JS_EXCEPTION;
	}
	fr->path = strdup(old_path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, old_path);
		JS_FreeCString(ctx, new_path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_rename(js_uv_loop(ctx), &fr->req, old_path, new_path,
	                      rename_cb);
	JS_FreeCString(ctx, old_path);
	JS_FreeCString(ctx, new_path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "rename", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ---- symlink ---- */

static void symlink_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "symlink", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
	} else {
		qn_promise_settle(&fr->promise, 0, JS_UNDEFINED);
	}
	qn_fs_req_free(fr);
}

static JSValue js_uv_symlink(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	const char *target = JS_ToCString(ctx, argv[0]);
	if (!target) return JS_EXCEPTION;
	const char *path = JS_ToCString(ctx, argv[1]);
	if (!path) {
		JS_FreeCString(ctx, target);
		return JS_EXCEPTION;
	}

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) {
		JS_FreeCString(ctx, target);
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}
	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, target);
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_symlink(js_uv_loop(ctx), &fr->req, target, path, 0,
	                       symlink_cb);
	JS_FreeCString(ctx, target);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "symlink", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ---- readlink ---- */

static void readlink_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "readlink", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
	} else {
		JSValue val = JS_NewString(ctx, (const char *)req->ptr);
		qn_promise_settle(&fr->promise, 0, val);
	}
	qn_fs_req_free(fr);
}

static JSValue js_uv_readlink(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_readlink(js_uv_loop(ctx), &fr->req, path, readlink_cb);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "readlink", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ---- realpath ---- */

static void realpath_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "realpath", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
	} else {
		JSValue val = JS_NewString(ctx, (const char *)req->ptr);
		qn_promise_settle(&fr->promise, 0, val);
	}
	qn_fs_req_free(fr);
}

static JSValue js_uv_realpath(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_realpath(js_uv_loop(ctx), &fr->req, path, realpath_cb);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "realpath", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ---- access ---- */

static void access_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "access", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
	} else {
		qn_promise_settle(&fr->promise, 0, JS_UNDEFINED);
	}
	qn_fs_req_free(fr);
}

static JSValue js_uv_access(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	int mode = 0;
	if (argc > 1)
		JS_ToInt32(ctx, &mode, argv[1]);

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_access(js_uv_loop(ctx), &fr->req, path, mode, access_cb);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "access", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ---- chmod ---- */

static void chmod_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "chmod", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
	} else {
		qn_promise_settle(&fr->promise, 0, JS_UNDEFINED);
	}
	qn_fs_req_free(fr);
}

static JSValue js_uv_chmod(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	int mode;
	if (JS_ToInt32(ctx, &mode, argv[1])) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_chmod(js_uv_loop(ctx), &fr->req, path, mode, chmod_cb);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "chmod", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ---- utimes ---- */

static void utimes_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "utimes", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
	} else {
		qn_promise_settle(&fr->promise, 0, JS_UNDEFINED);
	}
	qn_fs_req_free(fr);
}

static JSValue js_uv_utimes(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	double atime, mtime;
	if (JS_ToFloat64(ctx, &atime, argv[1])) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}
	if (JS_ToFloat64(ctx, &mtime, argv[2])) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_utime(js_uv_loop(ctx), &fr->req, path, atime, mtime,
	                     utimes_cb);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "utimes", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ---- chown ---- */

static void chown_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "chown", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
	} else {
		qn_promise_settle(&fr->promise, 0, JS_UNDEFINED);
	}
	qn_fs_req_free(fr);
}

static JSValue js_uv_chown(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	int uid, gid;
	if (JS_ToInt32(ctx, &uid, argv[1])) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}
	if (JS_ToInt32(ctx, &gid, argv[2])) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_chown(js_uv_loop(ctx), &fr->req, path, uid, gid, chown_cb);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "chown", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ---- lchown ---- */

static void lchown_cb(uv_fs_t *req) {
	QNFsReq *fr = (QNFsReq *)req->data;
	JSContext *ctx = fr->promise.ctx;

	if (req->result < 0) {
		JSValue err = make_fs_error(ctx, req->result, "lchown", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
	} else {
		qn_promise_settle(&fr->promise, 0, JS_UNDEFINED);
	}
	qn_fs_req_free(fr);
}

static JSValue js_uv_lchown(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	int uid, gid;
	if (JS_ToInt32(ctx, &uid, argv[1])) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}
	if (JS_ToInt32(ctx, &gid, argv[2])) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	QNFsReq *fr = qn_fs_req_alloc(ctx);
	if (!fr) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	fr->path = strdup(path);

	JSValue promise;
	if (qn_promise_init(ctx, &fr->promise, &promise) < 0) {
		JS_FreeCString(ctx, path);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}

	int r = uv_fs_lchown(js_uv_loop(ctx), &fr->req, path, uid, gid, lchown_cb);
	JS_FreeCString(ctx, path);

	if (r < 0) {
		JSValue err = make_fs_error(ctx, r, "lchown", fr->path);
		qn_promise_settle(&fr->promise, 1, err);
		JS_FreeValue(ctx, promise);
		qn_fs_req_free(fr);
		return JS_EXCEPTION;
	}
	return promise;
}

/* ==== module definition ==== */

static const JSCFunctionListEntry js_uv_fs_funcs[] = {
	JS_CFUNC_DEF("readFile", 2, js_uv_readFile),
	JS_CFUNC_DEF("writeFile", 2, js_uv_writeFile),
	JS_CFUNC_DEF("stat", 1, js_uv_stat),
	JS_CFUNC_DEF("lstat", 1, js_uv_lstat),
	JS_CFUNC_DEF("readdir", 1, js_uv_readdir),
	JS_CFUNC_DEF("mkdir", 2, js_uv_mkdir),
	JS_CFUNC_DEF("unlink", 1, js_uv_unlink),
	JS_CFUNC_DEF("rmdir", 1, js_uv_rmdir),
	JS_CFUNC_DEF("rename", 2, js_uv_rename),
	JS_CFUNC_DEF("symlink", 2, js_uv_symlink),
	JS_CFUNC_DEF("readlink", 1, js_uv_readlink),
	JS_CFUNC_DEF("realpath", 1, js_uv_realpath),
	JS_CFUNC_DEF("access", 2, js_uv_access),
	JS_CFUNC_DEF("chmod", 2, js_uv_chmod),
	JS_CFUNC_DEF("utimes", 3, js_uv_utimes),
	JS_CFUNC_DEF("chown", 3, js_uv_chown),
	JS_CFUNC_DEF("lchown", 3, js_uv_lchown),
};

static int js_uv_fs_init(JSContext *ctx, JSModuleDef *m) {
	return JS_SetModuleExportList(ctx, m, js_uv_fs_funcs,
	                              countof(js_uv_fs_funcs));
}

JSModuleDef *js_init_module_qn_uv_fs(JSContext *ctx,
                                      const char *module_name) {
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_uv_fs_init);
	if (!m) return NULL;
	JS_AddModuleExportList(ctx, m, js_uv_fs_funcs, countof(js_uv_fs_funcs));
	return m;
}

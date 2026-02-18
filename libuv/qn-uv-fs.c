/*
 * qn_uv_fs - Async filesystem operations via libuv for QuickJS
 *
 * Low-level fd-based primitives. High-level operations (readFile, writeFile)
 * are composed in JS from these primitives.
 *
 * Adapted from txiki.js mod_fs.c by Saul Ibarra Corretge (MIT).
 */

#include "qn-uv-utils.h"

#include <string.h>
#include <fcntl.h>

/* Get buffer pointer from a Uint8Array (Bellard QuickJS compatible).
 * quickjs-ng has JS_GetUint8Array but Bellard's QuickJS does not. */
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

/* ---- fs request struct ---- */

typedef struct {
	uv_fs_t req;
	JSContext *ctx;
	QNPromise result;
	JSValue tarray;  /* pinned typed array during read/write */
} QNFsReq;

static JSValue qn_fsreq_init(JSContext *ctx, QNFsReq *fr) {
	fr->ctx = ctx;
	fr->req.data = fr;
	fr->tarray = JS_UNDEFINED;
	return qn_promise_init(ctx, &fr->result);
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

/* ---- open flags parser (from txiki.js) ---- */

static int parse_open_flags(const char *strflags, size_t len) {
	int flags = 0, read = 0, write = 0;

	for (size_t i = 0; i < len; i++) {
		switch (strflags[i]) {
			case 'r': read = 1; break;
			case 'w': write = 1; flags |= O_TRUNC | O_CREAT; break;
			case 'a': write = 1; flags |= O_APPEND | O_CREAT; break;
			case '+': read = 1; write = 1; break;
			case 'x': flags |= O_EXCL; break;
			default: break;
		}
	}

	flags |= read ? (write ? O_RDWR : O_RDONLY) : (write ? O_WRONLY : 0);
	return flags;
}

/* ==== Unified callback (txiki.js pattern) ==== */

static void qn_fs_req_cb(uv_fs_t *req) {
	QNFsReq *fr = req->data;
	if (!fr) return;

	JSContext *ctx = fr->ctx;
	JSValue arg;
	bool is_reject = false;

	if (req->result < 0) {
		arg = qn_new_error(ctx, req->result);
		is_reject = true;
		goto settle;
	}

	switch (req->fs_type) {
		case UV_FS_OPEN:
			arg = JS_NewInt32(ctx, req->result);
			break;

		case UV_FS_READ:
			arg = req->result == 0 ? JS_NewInt32(ctx, 0) : JS_NewInt32(ctx, req->result);
			break;

		case UV_FS_WRITE:
			arg = JS_NewInt32(ctx, req->result);
			break;

		case UV_FS_STAT:
		case UV_FS_LSTAT:
		case UV_FS_FSTAT:
			arg = make_stat_obj(ctx, &req->statbuf);
			break;

		case UV_FS_READLINK:
		case UV_FS_REALPATH:
			arg = JS_NewString(ctx, req->ptr);
			break;

		case UV_FS_SCANDIR: {
			JSValue arr = JS_NewArray(ctx);
			uv_dirent_t ent;
			uint32_t i = 0;
			while (uv_fs_scandir_next(req, &ent) != UV_EOF) {
				JS_DefinePropertyValueUint32(ctx, arr, i,
					JS_NewString(ctx, ent.name), JS_PROP_C_W_E);
				i++;
			}
			arg = arr;
			break;
		}

		case UV_FS_MKDTEMP:
			arg = JS_NewString(ctx, req->path);
			break;

		case UV_FS_CLOSE:
		case UV_FS_MKDIR:
		case UV_FS_UNLINK:
		case UV_FS_RMDIR:
		case UV_FS_RENAME:
		case UV_FS_SYMLINK:
		case UV_FS_LINK:
		case UV_FS_COPYFILE:
		case UV_FS_CHMOD:
		case UV_FS_FCHMOD:
		case UV_FS_CHOWN:
		case UV_FS_LCHOWN:
		case UV_FS_FCHOWN:
		case UV_FS_UTIME:
		case UV_FS_FUTIME:
		case UV_FS_FTRUNCATE:
		case UV_FS_FSYNC:
		case UV_FS_FDATASYNC:
		case UV_FS_ACCESS:
			arg = JS_UNDEFINED;
			break;

		default:
			arg = JS_UNDEFINED;
			break;
	}

settle:
	qn_promise_settle(ctx, &fr->result, is_reject, 1, &arg);
	JS_FreeValue(ctx, fr->tarray);
	uv_fs_req_cleanup(&fr->req);
	js_free(ctx, fr);
}

/* ==== fd-based primitives ==== */

/* open(path, flags_string, mode) → promise<fd> */
static JSValue js_uv_open(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	size_t flen;
	const char *strflags = JS_ToCStringLen(ctx, &flen, argv[1]);
	if (!strflags) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}
	int flags = parse_open_flags(strflags, flen);
	JS_FreeCString(ctx, strflags);

	int32_t mode = 0666;
	if (argc > 2 && !JS_IsUndefined(argv[2])) {
		if (JS_ToInt32(ctx, &mode, argv[2])) {
			JS_FreeCString(ctx, path);
			return JS_EXCEPTION;
		}
	}

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	int r = uv_fs_open(js_uv_loop(ctx), &fr->req, path, flags, mode, qn_fs_req_cb);
	JS_FreeCString(ctx, path);
	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* close(fd) → promise<undefined> */
static JSValue js_uv_close(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) return JS_EXCEPTION;

	int r = uv_fs_close(js_uv_loop(ctx), &fr->req, fd, qn_fs_req_cb);
	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* read(fd, buffer, position) → promise<bytes_read>
 * buffer is a Uint8Array, position is file offset (-1 for current) */
static JSValue js_uv_read(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	size_t size;
	uint8_t *buf = qn_get_uint8array(ctx, &size, argv[1]);
	if (!buf) return JS_EXCEPTION;

	int64_t pos = -1;
	if (argc > 2 && !JS_IsUndefined(argv[2])) {
		if (JS_ToInt64(ctx, &pos, argv[2]))
			return JS_EXCEPTION;
	}

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) return JS_EXCEPTION;

	uv_buf_t b = uv_buf_init((char *)buf, size);
	int r = uv_fs_read(js_uv_loop(ctx), &fr->req, fd, &b, 1, pos, qn_fs_req_cb);
	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	JSValue promise = qn_fsreq_init(ctx, fr);
	/* Pin the typed array so the buffer stays alive during async I/O */
	fr->tarray = JS_DupValue(ctx, argv[1]);
	return promise;
}

/* write(fd, buffer, position) → promise<bytes_written>
 * buffer is a Uint8Array, position is file offset (-1 for current) */
static JSValue js_uv_write(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	size_t size;
	uint8_t *buf = qn_get_uint8array(ctx, &size, argv[1]);
	if (!buf) return JS_EXCEPTION;

	int64_t pos = -1;
	if (argc > 2 && !JS_IsUndefined(argv[2])) {
		if (JS_ToInt64(ctx, &pos, argv[2]))
			return JS_EXCEPTION;
	}

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) return JS_EXCEPTION;

	uv_buf_t b = uv_buf_init((char *)buf, size);
	int r = uv_fs_write(js_uv_loop(ctx), &fr->req, fd, &b, 1, pos, qn_fs_req_cb);
	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	JSValue promise = qn_fsreq_init(ctx, fr);
	fr->tarray = JS_DupValue(ctx, argv[1]);
	return promise;
}

/* fstat(fd) → promise<stat_obj> */
static JSValue js_uv_fstat(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) return JS_EXCEPTION;

	int r = uv_fs_fstat(js_uv_loop(ctx), &fr->req, fd, qn_fs_req_cb);
	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* ftruncate(fd, length) → promise<undefined> */
static JSValue js_uv_ftruncate(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	int64_t len = 0;
	if (argc > 1 && !JS_IsUndefined(argv[1])) {
		if (JS_ToInt64(ctx, &len, argv[1]))
			return JS_EXCEPTION;
	}

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) return JS_EXCEPTION;

	int r = uv_fs_ftruncate(js_uv_loop(ctx), &fr->req, fd, len, qn_fs_req_cb);
	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* fsync(fd) → promise<undefined> */
static JSValue js_uv_fsync(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) return JS_EXCEPTION;

	int r = uv_fs_fsync(js_uv_loop(ctx), &fr->req, fd, qn_fs_req_cb);
	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* fdatasync(fd) → promise<undefined> */
static JSValue js_uv_fdatasync(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) return JS_EXCEPTION;

	int r = uv_fs_fdatasync(js_uv_loop(ctx), &fr->req, fd, qn_fs_req_cb);
	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* fchmod(fd, mode) → promise<undefined> */
static JSValue js_uv_fchmod(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	int mode;
	if (JS_ToInt32(ctx, &mode, argv[1]))
		return JS_EXCEPTION;

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) return JS_EXCEPTION;

	int r = uv_fs_fchmod(js_uv_loop(ctx), &fr->req, fd, mode, qn_fs_req_cb);
	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* fchown(fd, uid, gid) → promise<undefined> */
static JSValue js_uv_fchown(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	int uid, gid;
	if (JS_ToInt32(ctx, &uid, argv[1]))
		return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &gid, argv[2]))
		return JS_EXCEPTION;

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) return JS_EXCEPTION;

	int r = uv_fs_fchown(js_uv_loop(ctx), &fr->req, fd, uid, gid, qn_fs_req_cb);
	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* futime(fd, atime, mtime) → promise<undefined>
 * atime/mtime in seconds (not milliseconds) */
static JSValue js_uv_futime(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	double atime, mtime;
	if (JS_ToFloat64(ctx, &atime, argv[1]))
		return JS_EXCEPTION;
	if (JS_ToFloat64(ctx, &mtime, argv[2]))
		return JS_EXCEPTION;

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) return JS_EXCEPTION;

	int r = uv_fs_futime(js_uv_loop(ctx), &fr->req, fd, atime, mtime, qn_fs_req_cb);
	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* ==== Path-based operations ==== */

/* stat/lstat via magic: 0=stat, 1=lstat */
static JSValue js_uv_stat(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv, int magic) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	int r;
	if (magic)
		r = uv_fs_lstat(js_uv_loop(ctx), &fr->req, path, qn_fs_req_cb);
	else
		r = uv_fs_stat(js_uv_loop(ctx), &fr->req, path, qn_fs_req_cb);
	JS_FreeCString(ctx, path);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* readdir(path) → promise<string[]> (uses scandir) */
static JSValue js_uv_readdir(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	int r = uv_fs_scandir(js_uv_loop(ctx), &fr->req, path, 0, qn_fs_req_cb);
	JS_FreeCString(ctx, path);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* mkdir(path, mode) → promise<undefined> */
static JSValue js_uv_mkdir(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	int mode = 0777;
	if (argc > 1 && !JS_IsUndefined(argv[1]))
		JS_ToInt32(ctx, &mode, argv[1]);

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	int r = uv_fs_mkdir(js_uv_loop(ctx), &fr->req, path, mode, qn_fs_req_cb);
	JS_FreeCString(ctx, path);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* unlink(path) → promise<undefined> */
static JSValue js_uv_unlink(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	int r = uv_fs_unlink(js_uv_loop(ctx), &fr->req, path, qn_fs_req_cb);
	JS_FreeCString(ctx, path);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* rmdir(path) → promise<undefined> */
static JSValue js_uv_rmdir(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	int r = uv_fs_rmdir(js_uv_loop(ctx), &fr->req, path, qn_fs_req_cb);
	JS_FreeCString(ctx, path);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* rename(old_path, new_path) → promise<undefined> */
static JSValue js_uv_rename(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	const char *old_path = JS_ToCString(ctx, argv[0]);
	if (!old_path) return JS_EXCEPTION;
	const char *new_path = JS_ToCString(ctx, argv[1]);
	if (!new_path) {
		JS_FreeCString(ctx, old_path);
		return JS_EXCEPTION;
	}

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, old_path);
		JS_FreeCString(ctx, new_path);
		return JS_EXCEPTION;
	}

	int r = uv_fs_rename(js_uv_loop(ctx), &fr->req, old_path, new_path, qn_fs_req_cb);
	JS_FreeCString(ctx, old_path);
	JS_FreeCString(ctx, new_path);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* symlink(target, path) → promise<undefined> */
static JSValue js_uv_symlink(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
	const char *target = JS_ToCString(ctx, argv[0]);
	if (!target) return JS_EXCEPTION;
	const char *path = JS_ToCString(ctx, argv[1]);
	if (!path) {
		JS_FreeCString(ctx, target);
		return JS_EXCEPTION;
	}

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, target);
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	int r = uv_fs_symlink(js_uv_loop(ctx), &fr->req, target, path, 0, qn_fs_req_cb);
	JS_FreeCString(ctx, target);
	JS_FreeCString(ctx, path);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* link(existing_path, new_path) → promise<undefined> */
static JSValue js_uv_link(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	const char *new_path = JS_ToCString(ctx, argv[1]);
	if (!new_path) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, path);
		JS_FreeCString(ctx, new_path);
		return JS_EXCEPTION;
	}

	int r = uv_fs_link(js_uv_loop(ctx), &fr->req, path, new_path, qn_fs_req_cb);
	JS_FreeCString(ctx, path);
	JS_FreeCString(ctx, new_path);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* readlink(path) → promise<string> */
static JSValue js_uv_readlink(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	int r = uv_fs_readlink(js_uv_loop(ctx), &fr->req, path, qn_fs_req_cb);
	JS_FreeCString(ctx, path);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* realpath(path) → promise<string> */
static JSValue js_uv_realpath(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	int r = uv_fs_realpath(js_uv_loop(ctx), &fr->req, path, qn_fs_req_cb);
	JS_FreeCString(ctx, path);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* access(path, mode) → promise<undefined> */
static JSValue js_uv_access(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	int mode = 0;
	if (argc > 1)
		JS_ToInt32(ctx, &mode, argv[1]);

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	int r = uv_fs_access(js_uv_loop(ctx), &fr->req, path, mode, qn_fs_req_cb);
	JS_FreeCString(ctx, path);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* chmod(path, mode) → promise<undefined> */
static JSValue js_uv_chmod(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;

	int mode;
	if (JS_ToInt32(ctx, &mode, argv[1])) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	int r = uv_fs_chmod(js_uv_loop(ctx), &fr->req, path, mode, qn_fs_req_cb);
	JS_FreeCString(ctx, path);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* utimes(path, atime, mtime) → promise<undefined>
 * atime/mtime in seconds */
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

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	int r = uv_fs_utime(js_uv_loop(ctx), &fr->req, path, atime, mtime, qn_fs_req_cb);
	JS_FreeCString(ctx, path);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* chown/lchown via magic: 0=chown, 1=lchown */
static JSValue js_uv_xchown(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv, int magic) {
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

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}

	int r;
	if (magic)
		r = uv_fs_lchown(js_uv_loop(ctx), &fr->req, path, uid, gid, qn_fs_req_cb);
	else
		r = uv_fs_chown(js_uv_loop(ctx), &fr->req, path, uid, gid, qn_fs_req_cb);
	JS_FreeCString(ctx, path);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* copyfile(src, dst) → promise<undefined> */
static JSValue js_uv_copyfile(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
	const char *src = JS_ToCString(ctx, argv[0]);
	if (!src) return JS_EXCEPTION;
	const char *dst = JS_ToCString(ctx, argv[1]);
	if (!dst) {
		JS_FreeCString(ctx, src);
		return JS_EXCEPTION;
	}

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, src);
		JS_FreeCString(ctx, dst);
		return JS_EXCEPTION;
	}

	int r = uv_fs_copyfile(js_uv_loop(ctx), &fr->req, src, dst, 0, qn_fs_req_cb);
	JS_FreeCString(ctx, src);
	JS_FreeCString(ctx, dst);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* mkdtemp(template) → promise<string> */
static JSValue js_uv_mkdtemp(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
	const char *tpl = JS_ToCString(ctx, argv[0]);
	if (!tpl) return JS_EXCEPTION;

	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) {
		JS_FreeCString(ctx, tpl);
		return JS_EXCEPTION;
	}

	int r = uv_fs_mkdtemp(js_uv_loop(ctx), &fr->req, tpl, qn_fs_req_cb);
	JS_FreeCString(ctx, tpl);

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	return qn_fsreq_init(ctx, fr);
}

/* ==== module definition ==== */

static const JSCFunctionListEntry js_uv_fs_funcs[] = {
	/* fd primitives */
	QN_CFUNC_DEF("open", 3, js_uv_open),
	QN_CFUNC_DEF("close", 1, js_uv_close),
	QN_CFUNC_DEF("read", 3, js_uv_read),
	QN_CFUNC_DEF("write", 3, js_uv_write),
	QN_CFUNC_DEF("fstat", 1, js_uv_fstat),
	QN_CFUNC_DEF("ftruncate", 2, js_uv_ftruncate),
	QN_CFUNC_DEF("fsync", 1, js_uv_fsync),
	QN_CFUNC_DEF("fdatasync", 1, js_uv_fdatasync),
	QN_CFUNC_DEF("fchmod", 2, js_uv_fchmod),
	QN_CFUNC_DEF("fchown", 3, js_uv_fchown),
	QN_CFUNC_DEF("futime", 3, js_uv_futime),
	/* path operations */
	QN_CFUNC_MAGIC_DEF("stat", 1, js_uv_stat, 0),
	QN_CFUNC_MAGIC_DEF("lstat", 1, js_uv_stat, 1),
	QN_CFUNC_DEF("readdir", 1, js_uv_readdir),
	QN_CFUNC_DEF("mkdir", 2, js_uv_mkdir),
	QN_CFUNC_DEF("unlink", 1, js_uv_unlink),
	QN_CFUNC_DEF("rmdir", 1, js_uv_rmdir),
	QN_CFUNC_DEF("rename", 2, js_uv_rename),
	QN_CFUNC_DEF("symlink", 2, js_uv_symlink),
	QN_CFUNC_DEF("link", 2, js_uv_link),
	QN_CFUNC_DEF("readlink", 1, js_uv_readlink),
	QN_CFUNC_DEF("realpath", 1, js_uv_realpath),
	QN_CFUNC_DEF("access", 2, js_uv_access),
	QN_CFUNC_DEF("chmod", 2, js_uv_chmod),
	QN_CFUNC_DEF("utimes", 3, js_uv_utimes),
	QN_CFUNC_MAGIC_DEF("chown", 3, js_uv_xchown, 0),
	QN_CFUNC_MAGIC_DEF("lchown", 3, js_uv_xchown, 1),
	QN_CFUNC_DEF("copyfile", 2, js_uv_copyfile),
	QN_CFUNC_DEF("mkdtemp", 1, js_uv_mkdtemp),
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

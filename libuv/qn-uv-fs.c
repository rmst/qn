/*
 * qn_uv_fs - Async filesystem operations via libuv for QuickJS
 *
 * Single-dispatch design: one C function (_fsop) handles all operations.
 * JS wrappers in node/qn/uv-fs.js provide the typed API.
 *
 * Adapted from txiki.js mod_fs.c by Saul Ibarra Corretge (MIT).
 */

#include "qn-uv-utils.h"

#include <string.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/stat.h>
#if !defined(_WIN32)
#include <unistd.h>
#endif

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

/* ---- QNFile: GC-safe file descriptor wrapper ---- */

static JSClassID qn_file_class_id;

typedef struct {
	int fd;
} QNFile;

static void qn_file_finalizer(JSRuntime *rt, JSValue val) {
	QNFile *f = JS_GetOpaque(val, qn_file_class_id);
	if (f) {
		if (f->fd != -1) {
			uv_fs_t req;
			uv_fs_close(NULL, &req, f->fd, NULL);
			uv_fs_req_cleanup(&req);
		}
		js_free_rt(rt, f);
	}
}

static JSClassDef qn_file_class = {
	"FileHandle",
	.finalizer = qn_file_finalizer,
};

static JSValue qn_new_file(JSContext *ctx, int fd) {
	QNFile *f = js_malloc(ctx, sizeof(*f));
	if (!f) return JS_EXCEPTION;
	f->fd = fd;
	JSValue obj = JS_NewObjectClass(ctx, qn_file_class_id);
	if (JS_IsException(obj)) {
		js_free(ctx, f);
		return JS_EXCEPTION;
	}
	JS_SetOpaque(obj, f);
	return obj;
}

/* .fd getter — exposes the raw fd number to JS */
static JSValue qn_file_get_fd(JSContext *ctx, JSValueConst this_val) {
	QNFile *f = JS_GetOpaque2(ctx, this_val, qn_file_class_id);
	if (!f) return JS_EXCEPTION;
	return JS_NewInt32(ctx, f->fd);
}

static const JSCFunctionListEntry qn_file_proto_funcs[] = {
	QN_CGETSET_DEF("fd", qn_file_get_fd, NULL),
};

/* Extract fd from a QNFile object or raw integer.
 * Returns the fd on success, -1 on error (JS exception set). */
static int qn_get_fd(JSContext *ctx, JSValueConst val) {
	if (JS_IsNumber(val)) {
		int32_t fd;
		if (JS_ToInt32(ctx, &fd, val))
			return -1;
		return fd;
	}
	QNFile *f = JS_GetOpaque2(ctx, val, qn_file_class_id);
	if (!f) return -1;
	if (f->fd == -1) {
		JS_ThrowTypeError(ctx, "file descriptor already closed");
		return -1;
	}
	return f->fd;
}

/* Extract fd from QNFile and mark it as closed (prevents finalizer double-close).
 * For raw integers, just returns the value unchanged. */
static int qn_close_fd(JSContext *ctx, JSValueConst val) {
	if (JS_IsNumber(val)) {
		int32_t fd;
		if (JS_ToInt32(ctx, &fd, val))
			return -1;
		return fd;
	}
	QNFile *f = JS_GetOpaque2(ctx, val, qn_file_class_id);
	if (!f) return -1;
	if (f->fd == -1) {
		JS_ThrowTypeError(ctx, "file descriptor already closed");
		return -1;
	}
	int fd = f->fd;
	f->fd = -1;
	return fd;
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

/* ==== Unified callback ==== */

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
			arg = qn_new_file(ctx, req->result);
			break;

		case UV_FS_READ:
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

/* ==== Opcodes ==== */

enum {
	FS_OPEN = 0,
	FS_CLOSE,
	FS_READ,
	FS_WRITE,
	FS_FSTAT,
	FS_FTRUNCATE,
	FS_FSYNC,
	FS_FDATASYNC,
	FS_FCHMOD,
	FS_FCHOWN,
	FS_FUTIME,
	FS_STAT,
	FS_LSTAT,
	FS_READDIR,
	FS_MKDIR,
	FS_UNLINK,
	FS_RMDIR,
	FS_RENAME,
	FS_SYMLINK,
	FS_LINK,
	FS_READLINK,
	FS_REALPATH,
	FS_ACCESS,
	FS_CHMOD,
	FS_UTIMES,
	FS_CHOWN,
	FS_LCHOWN,
	FS_COPYFILE,
	FS_MKDTEMP,
};

/* ==== Single dispatch function ====
 *
 * _fsop(opcode, ...args) → Promise
 *
 * All argument parsing and uv_fs_* dispatch in one place.
 * Boilerplate (malloc, error check, promise init) written once. */

static JSValue js_uv_fsop(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	int32_t op;
	if (JS_ToInt32(ctx, &op, argv[0]))
		return JS_EXCEPTION;

	/* args start at argv[1] */
	int nargs = argc - 1;
	JSValueConst *args = argv + 1;

	uv_loop_t *loop = js_uv_loop(ctx);
	QNFsReq *fr = js_malloc(ctx, sizeof(*fr));
	if (!fr) return JS_EXCEPTION;

	int r;
	const char *s1 = NULL, *s2 = NULL;
	int32_t i1, i2, i3;
	int64_t i64;
	double d1, d2;
	size_t bufsize;
	uint8_t *buf;
	bool need_pin = false;

	switch (op) {

	/* -- open(flags_int, mode, path) -- */
	case FS_OPEN:
		if (JS_ToInt32(ctx, &i1, args[0])) goto fail;  /* flags */
		if (JS_ToInt32(ctx, &i2, args[1])) goto fail;  /* mode */
		s1 = JS_ToCString(ctx, args[2]);                /* path */
		if (!s1) goto fail;
		r = uv_fs_open(loop, &fr->req, s1, i1, i2, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	/* -- close(fd) -- */
	case FS_CLOSE:
		i1 = qn_close_fd(ctx, args[0]);
		if (i1 < 0) goto fail;
		r = uv_fs_close(loop, &fr->req, i1, qn_fs_req_cb);
		break;

	/* -- read(fd, buffer, position) -- */
	case FS_READ:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) goto fail;
		buf = qn_get_uint8array(ctx, &bufsize, args[1]);
		if (!buf) goto fail;
		i64 = -1;
		if (nargs > 2 && !JS_IsUndefined(args[2]))
			if (JS_ToInt64(ctx, &i64, args[2])) goto fail;
		{ uv_buf_t b = uv_buf_init((char *)buf, bufsize);
		  r = uv_fs_read(loop, &fr->req, i1, &b, 1, i64, qn_fs_req_cb); }
		need_pin = true;
		break;

	/* -- write(fd, buffer, position) -- */
	case FS_WRITE:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) goto fail;
		buf = qn_get_uint8array(ctx, &bufsize, args[1]);
		if (!buf) goto fail;
		i64 = -1;
		if (nargs > 2 && !JS_IsUndefined(args[2]))
			if (JS_ToInt64(ctx, &i64, args[2])) goto fail;
		{ uv_buf_t b = uv_buf_init((char *)buf, bufsize);
		  r = uv_fs_write(loop, &fr->req, i1, &b, 1, i64, qn_fs_req_cb); }
		need_pin = true;
		break;

	/* -- fd-only ops: fstat, fsync, fdatasync, close already handled -- */
	case FS_FSTAT:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) goto fail;
		r = uv_fs_fstat(loop, &fr->req, i1, qn_fs_req_cb);
		break;

	case FS_FTRUNCATE:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) goto fail;
		i64 = 0;
		if (nargs > 1 && !JS_IsUndefined(args[1]))
			if (JS_ToInt64(ctx, &i64, args[1])) goto fail;
		r = uv_fs_ftruncate(loop, &fr->req, i1, i64, qn_fs_req_cb);
		break;

	case FS_FSYNC:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) goto fail;
		r = uv_fs_fsync(loop, &fr->req, i1, qn_fs_req_cb);
		break;

	case FS_FDATASYNC:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) goto fail;
		r = uv_fs_fdatasync(loop, &fr->req, i1, qn_fs_req_cb);
		break;

	case FS_FCHMOD:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) goto fail;
		if (JS_ToInt32(ctx, &i2, args[1])) goto fail;
		r = uv_fs_fchmod(loop, &fr->req, i1, i2, qn_fs_req_cb);
		break;

	case FS_FCHOWN:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) goto fail;
		if (JS_ToInt32(ctx, &i2, args[1])) goto fail;
		if (JS_ToInt32(ctx, &i3, args[2])) goto fail;
		r = uv_fs_fchown(loop, &fr->req, i1, i2, i3, qn_fs_req_cb);
		break;

	case FS_FUTIME:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) goto fail;
		if (JS_ToFloat64(ctx, &d1, args[1])) goto fail;
		if (JS_ToFloat64(ctx, &d2, args[2])) goto fail;
		r = uv_fs_futime(loop, &fr->req, i1, d1, d2, qn_fs_req_cb);
		break;

	/* -- path-only ops -- */
	case FS_STAT:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		r = uv_fs_stat(loop, &fr->req, s1, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	case FS_LSTAT:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		r = uv_fs_lstat(loop, &fr->req, s1, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	case FS_READDIR:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		r = uv_fs_scandir(loop, &fr->req, s1, 0, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	case FS_MKDIR:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		i1 = 0777;
		if (nargs > 1 && !JS_IsUndefined(args[1]))
			JS_ToInt32(ctx, &i1, args[1]);
		r = uv_fs_mkdir(loop, &fr->req, s1, i1, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	case FS_UNLINK:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		r = uv_fs_unlink(loop, &fr->req, s1, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	case FS_RMDIR:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		r = uv_fs_rmdir(loop, &fr->req, s1, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	case FS_READLINK:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		r = uv_fs_readlink(loop, &fr->req, s1, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	case FS_REALPATH:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		r = uv_fs_realpath(loop, &fr->req, s1, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	case FS_MKDTEMP:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		r = uv_fs_mkdtemp(loop, &fr->req, s1, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	case FS_ACCESS:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		i1 = 0;
		if (nargs > 1) JS_ToInt32(ctx, &i1, args[1]);
		r = uv_fs_access(loop, &fr->req, s1, i1, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	/* -- path + int ops -- */
	case FS_CHMOD:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		if (JS_ToInt32(ctx, &i1, args[1])) { JS_FreeCString(ctx, s1); goto fail; }
		r = uv_fs_chmod(loop, &fr->req, s1, i1, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	case FS_UTIMES:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		if (JS_ToFloat64(ctx, &d1, args[1])) { JS_FreeCString(ctx, s1); goto fail; }
		if (JS_ToFloat64(ctx, &d2, args[2])) { JS_FreeCString(ctx, s1); goto fail; }
		r = uv_fs_utime(loop, &fr->req, s1, d1, d2, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	case FS_CHOWN:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		if (JS_ToInt32(ctx, &i1, args[1])) { JS_FreeCString(ctx, s1); goto fail; }
		if (JS_ToInt32(ctx, &i2, args[2])) { JS_FreeCString(ctx, s1); goto fail; }
		r = uv_fs_chown(loop, &fr->req, s1, i1, i2, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	case FS_LCHOWN:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		if (JS_ToInt32(ctx, &i1, args[1])) { JS_FreeCString(ctx, s1); goto fail; }
		if (JS_ToInt32(ctx, &i2, args[2])) { JS_FreeCString(ctx, s1); goto fail; }
		r = uv_fs_lchown(loop, &fr->req, s1, i1, i2, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		break;

	/* -- two-path ops -- */
	case FS_RENAME:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		s2 = JS_ToCString(ctx, args[1]);
		if (!s2) { JS_FreeCString(ctx, s1); goto fail; }
		r = uv_fs_rename(loop, &fr->req, s1, s2, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		JS_FreeCString(ctx, s2);
		break;

	case FS_SYMLINK:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		s2 = JS_ToCString(ctx, args[1]);
		if (!s2) { JS_FreeCString(ctx, s1); goto fail; }
		r = uv_fs_symlink(loop, &fr->req, s1, s2, 0, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		JS_FreeCString(ctx, s2);
		break;

	case FS_LINK:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		s2 = JS_ToCString(ctx, args[1]);
		if (!s2) { JS_FreeCString(ctx, s1); goto fail; }
		r = uv_fs_link(loop, &fr->req, s1, s2, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		JS_FreeCString(ctx, s2);
		break;

	case FS_COPYFILE:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) goto fail;
		s2 = JS_ToCString(ctx, args[1]);
		if (!s2) { JS_FreeCString(ctx, s1); goto fail; }
		r = uv_fs_copyfile(loop, &fr->req, s1, s2, 0, qn_fs_req_cb);
		JS_FreeCString(ctx, s1);
		JS_FreeCString(ctx, s2);
		break;

	default:
		js_free(ctx, fr);
		return JS_ThrowRangeError(ctx, "unknown fs opcode: %d", op);
	}

	if (r != 0) {
		js_free(ctx, fr);
		return qn_throw_errno(ctx, r);
	}

	JSValue promise = qn_fsreq_init(ctx, fr);
	if (need_pin)
		fr->tarray = JS_DupValue(ctx, args[1]);
	return promise;

fail:
	js_free(ctx, fr);
	return JS_EXCEPTION;
}

/* ==== Synchronous dispatch ====
 *
 * _fssync(opcode, ...args) → result
 *
 * Uses libuv's synchronous mode (NULL callback) for operations
 * that must be synchronous (chmodSync, chownSync, etc.).
 * Returns 0 on success, throws on error. */

static JSValue js_uv_fssync(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
	int32_t op;
	if (JS_ToInt32(ctx, &op, argv[0]))
		return JS_EXCEPTION;

	JSValueConst *args = argv + 1;

	/* NULL loop + NULL callback = synchronous execution.
	 * Same pattern as Node.js (SyncCallAndThrowIf) and txiki.js. */
	uv_fs_t req;
	int r;
	const char *s1 = NULL, *s2 = NULL;
	int32_t i1, i2, i3;
	int64_t i64;
	double d1, d2;
	size_t bufsize;
	uint8_t *buf;
	JSValue result = JS_UNDEFINED;

	(void)argc;

	switch (op) {

	/* -- read(fd, Uint8Array, position) → bytes_read -- */
	case FS_READ:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) return JS_EXCEPTION;
		buf = qn_get_uint8array(ctx, &bufsize, args[1]);
		if (!buf) return JS_EXCEPTION;
		i64 = -1;
		if (argc > 3 && !JS_IsUndefined(args[2]))
			if (JS_ToInt64(ctx, &i64, args[2])) return JS_EXCEPTION;
		{ uv_buf_t b = uv_buf_init((char *)buf, bufsize);
		  r = uv_fs_read(NULL, &req, i1, &b, 1, i64, NULL); }
		if (r >= 0)
			result = JS_NewInt32(ctx, r);
		break;

	/* -- write(fd, Uint8Array, position) → bytes_written -- */
	case FS_WRITE:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) return JS_EXCEPTION;
		buf = qn_get_uint8array(ctx, &bufsize, args[1]);
		if (!buf) return JS_EXCEPTION;
		i64 = -1;
		if (argc > 3 && !JS_IsUndefined(args[2]))
			if (JS_ToInt64(ctx, &i64, args[2])) return JS_EXCEPTION;
		{ uv_buf_t b = uv_buf_init((char *)buf, bufsize);
		  r = uv_fs_write(NULL, &req, i1, &b, 1, i64, NULL); }
		if (r >= 0)
			result = JS_NewInt32(ctx, r);
		break;

	/* -- path ops returning 0 -- */
	case FS_CHMOD:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		if (JS_ToInt32(ctx, &i1, args[1])) { JS_FreeCString(ctx, s1); return JS_EXCEPTION; }
		r = uv_fs_chmod(NULL, &req, s1, i1, NULL);
		JS_FreeCString(ctx, s1);
		break;

	case FS_CHOWN:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		if (JS_ToInt32(ctx, &i1, args[1])) { JS_FreeCString(ctx, s1); return JS_EXCEPTION; }
		if (JS_ToInt32(ctx, &i2, args[2])) { JS_FreeCString(ctx, s1); return JS_EXCEPTION; }
		r = uv_fs_chown(NULL, &req, s1, i1, i2, NULL);
		JS_FreeCString(ctx, s1);
		break;

	case FS_LCHOWN:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		if (JS_ToInt32(ctx, &i1, args[1])) { JS_FreeCString(ctx, s1); return JS_EXCEPTION; }
		if (JS_ToInt32(ctx, &i2, args[2])) { JS_FreeCString(ctx, s1); return JS_EXCEPTION; }
		r = uv_fs_lchown(NULL, &req, s1, i1, i2, NULL);
		JS_FreeCString(ctx, s1);
		break;

	case FS_MKDIR:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		i1 = 0777;
		if (argc > 2 && !JS_IsUndefined(args[1]))
			if (JS_ToInt32(ctx, &i1, args[1])) { JS_FreeCString(ctx, s1); return JS_EXCEPTION; }
		r = uv_fs_mkdir(NULL, &req, s1, i1, NULL);
		JS_FreeCString(ctx, s1);
		break;

	case FS_UNLINK:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		r = uv_fs_unlink(NULL, &req, s1, NULL);
		JS_FreeCString(ctx, s1);
		break;

	case FS_RMDIR:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		r = uv_fs_rmdir(NULL, &req, s1, NULL);
		JS_FreeCString(ctx, s1);
		break;

	case FS_RENAME:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		s2 = JS_ToCString(ctx, args[1]);
		if (!s2) { JS_FreeCString(ctx, s1); return JS_EXCEPTION; }
		r = uv_fs_rename(NULL, &req, s1, s2, NULL);
		JS_FreeCString(ctx, s1);
		JS_FreeCString(ctx, s2);
		break;

	case FS_SYMLINK:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		s2 = JS_ToCString(ctx, args[1]);
		if (!s2) { JS_FreeCString(ctx, s1); return JS_EXCEPTION; }
		r = uv_fs_symlink(NULL, &req, s1, s2, 0, NULL);
		JS_FreeCString(ctx, s1);
		JS_FreeCString(ctx, s2);
		break;

	case FS_LINK:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		s2 = JS_ToCString(ctx, args[1]);
		if (!s2) { JS_FreeCString(ctx, s1); return JS_EXCEPTION; }
		r = uv_fs_link(NULL, &req, s1, s2, NULL);
		JS_FreeCString(ctx, s1);
		JS_FreeCString(ctx, s2);
		break;

	case FS_COPYFILE:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		s2 = JS_ToCString(ctx, args[1]);
		if (!s2) { JS_FreeCString(ctx, s1); return JS_EXCEPTION; }
		r = uv_fs_copyfile(NULL, &req, s1, s2, 0, NULL);
		JS_FreeCString(ctx, s1);
		JS_FreeCString(ctx, s2);
		break;

	case FS_UTIMES:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		if (JS_ToFloat64(ctx, &d1, args[1])) { JS_FreeCString(ctx, s1); return JS_EXCEPTION; }
		if (JS_ToFloat64(ctx, &d2, args[2])) { JS_FreeCString(ctx, s1); return JS_EXCEPTION; }
		r = uv_fs_utime(NULL, &req, s1, d1, d2, NULL);
		JS_FreeCString(ctx, s1);
		break;

	case FS_ACCESS:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		i1 = 0; /* F_OK */
		if (argc > 2 && !JS_IsUndefined(args[1]))
			if (JS_ToInt32(ctx, &i1, args[1])) { JS_FreeCString(ctx, s1); return JS_EXCEPTION; }
		r = uv_fs_access(NULL, &req, s1, i1, NULL);
		JS_FreeCString(ctx, s1);
		break;

	/* -- ops returning stat object -- */
	case FS_STAT:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		r = uv_fs_stat(NULL, &req, s1, NULL);
		JS_FreeCString(ctx, s1);
		if (r >= 0)
			result = make_stat_obj(ctx, &req.statbuf);
		break;

	case FS_LSTAT:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		r = uv_fs_lstat(NULL, &req, s1, NULL);
		JS_FreeCString(ctx, s1);
		if (r >= 0)
			result = make_stat_obj(ctx, &req.statbuf);
		break;

	case FS_FSTAT:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) return JS_EXCEPTION;
		r = uv_fs_fstat(NULL, &req, i1, NULL);
		if (r >= 0)
			result = make_stat_obj(ctx, &req.statbuf);
		break;

	/* -- ops returning string -- */
	case FS_READLINK:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		r = uv_fs_readlink(NULL, &req, s1, NULL);
		JS_FreeCString(ctx, s1);
		if (r >= 0)
			result = JS_NewString(ctx, req.ptr);
		break;

	case FS_REALPATH:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		r = uv_fs_realpath(NULL, &req, s1, NULL);
		JS_FreeCString(ctx, s1);
		if (r >= 0)
			result = JS_NewString(ctx, req.ptr);
		break;

	/* -- readdir returning string array -- */
	case FS_READDIR: {
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		r = uv_fs_scandir(NULL, &req, s1, 0, NULL);
		JS_FreeCString(ctx, s1);
		if (r >= 0) {
			JSValue arr = JS_NewArray(ctx);
			uv_dirent_t ent;
			uint32_t idx = 0;
			while (uv_fs_scandir_next(&req, &ent) != UV_EOF) {
				JS_DefinePropertyValueUint32(ctx, arr, idx,
					JS_NewString(ctx, ent.name), JS_PROP_C_W_E);
				idx++;
			}
			result = arr;
		}
		break;
	}

	/* -- open returning QNFile -- */
	case FS_OPEN:
		if (JS_ToInt32(ctx, &i1, args[0])) return JS_EXCEPTION; /* flags */
		if (JS_ToInt32(ctx, &i2, args[1])) return JS_EXCEPTION; /* mode */
		s1 = JS_ToCString(ctx, args[2]);                        /* path */
		if (!s1) return JS_EXCEPTION;
		r = uv_fs_open(NULL, &req, s1, i1, i2, NULL);
		JS_FreeCString(ctx, s1);
		if (r >= 0)
			result = qn_new_file(ctx, r);
		break;

	/* -- close -- */
	case FS_CLOSE:
		i1 = qn_close_fd(ctx, args[0]);
		if (i1 < 0) return JS_EXCEPTION;
		r = uv_fs_close(NULL, &req, i1, NULL);
		break;

	/* -- mkdtemp returning path string -- */
	case FS_MKDTEMP:
		s1 = JS_ToCString(ctx, args[0]);
		if (!s1) return JS_EXCEPTION;
		r = uv_fs_mkdtemp(NULL, &req, s1, NULL);
		JS_FreeCString(ctx, s1);
		if (r >= 0)
			result = JS_NewString(ctx, req.path);
		break;

	/* -- fd ops -- */
	case FS_FTRUNCATE:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) return JS_EXCEPTION;
		{ int64_t len = 0;
		  if (argc > 2 && !JS_IsUndefined(args[1]))
			if (JS_ToInt64(ctx, &len, args[1])) return JS_EXCEPTION;
		  r = uv_fs_ftruncate(NULL, &req, i1, len, NULL); }
		break;

	case FS_FCHMOD:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) return JS_EXCEPTION;
		if (JS_ToInt32(ctx, &i2, args[1])) return JS_EXCEPTION;
		r = uv_fs_fchmod(NULL, &req, i1, i2, NULL);
		break;

	case FS_FCHOWN:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) return JS_EXCEPTION;
		if (JS_ToInt32(ctx, &i2, args[1])) return JS_EXCEPTION;
		if (JS_ToInt32(ctx, &i3, args[2])) return JS_EXCEPTION;
		r = uv_fs_fchown(NULL, &req, i1, i2, i3, NULL);
		break;

	case FS_FUTIME:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) return JS_EXCEPTION;
		if (JS_ToFloat64(ctx, &d1, args[1])) return JS_EXCEPTION;
		if (JS_ToFloat64(ctx, &d2, args[2])) return JS_EXCEPTION;
		r = uv_fs_futime(NULL, &req, i1, d1, d2, NULL);
		break;

	case FS_FSYNC:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) return JS_EXCEPTION;
		r = uv_fs_fsync(NULL, &req, i1, NULL);
		break;

	case FS_FDATASYNC:
		i1 = qn_get_fd(ctx, args[0]);
		if (i1 < 0) return JS_EXCEPTION;
		r = uv_fs_fdatasync(NULL, &req, i1, NULL);
		break;

	default:
		return JS_ThrowRangeError(ctx, "unknown fssync opcode: %d", op);
	}

	uv_fs_req_cleanup(&req);
	if (r < 0)
		return qn_throw_errno(ctx, r);
	/* If a result was built (stat, readdir, etc.), return it; otherwise 0 */
	return JS_IsUndefined(result) ? JS_NewInt32(ctx, 0) : result;
}

/* ==== Utility functions ====
 *
 * Small POSIX utilities that were previously in qn-native.c. */

/* setNonBlock(fd) → 0 on success, throws on error */
static JSValue js_uv_set_nonblock(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
	int fd, flags;
	fd = qn_get_fd(ctx, argv[0]);
	if (fd < 0)
		return JS_EXCEPTION;
	flags = fcntl(fd, F_GETFL);
	if (flags < 0)
		return qn_throw_errno(ctx, -errno);
	if (fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0)
		return qn_throw_errno(ctx, -errno);
	return JS_NewInt32(ctx, 0);
}

#if !defined(_WIN32)
/* getpgid(pid) → pgid */
static JSValue js_uv_getpgid(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
	int pid, ret;
	if (JS_ToInt32(ctx, &pid, argv[0]))
		return JS_EXCEPTION;
	ret = getpgid(pid);
	if (ret < 0)
		return qn_throw_errno(ctx, -errno);
	return JS_NewInt32(ctx, ret);
}
#endif

/* ==== module definition ==== */

static const JSCFunctionListEntry js_uv_fs_funcs[] = {
	QN_CFUNC_DEF("_fsop", 5, js_uv_fsop),
	QN_CFUNC_DEF("_fssync", 4, js_uv_fssync),
	QN_CFUNC_DEF("setNonBlock", 1, js_uv_set_nonblock),
#if !defined(_WIN32)
	QN_CFUNC_DEF("getpgid", 1, js_uv_getpgid),
#endif
	/* Platform open flags (vary between Linux/macOS) */
	QN_CONST(O_RDONLY),
	QN_CONST(O_WRONLY),
	QN_CONST(O_RDWR),
	QN_CONST(O_CREAT),
	QN_CONST(O_TRUNC),
	QN_CONST(O_APPEND),
	QN_CONST(O_EXCL),
	/* Stat mode type constants */
	QN_CONST(S_IFMT),
	QN_CONST(S_IFREG),
	QN_CONST(S_IFDIR),
	QN_CONST(S_IFLNK),
	QN_CONST(S_IFBLK),
	QN_CONST(S_IFCHR),
	QN_CONST(S_IFIFO),
	QN_CONST(S_IFSOCK),
	/* Opcode constants */
	QN_CONST2("OPEN", FS_OPEN),
	QN_CONST2("CLOSE", FS_CLOSE),
	QN_CONST2("READ", FS_READ),
	QN_CONST2("WRITE", FS_WRITE),
	QN_CONST2("FSTAT", FS_FSTAT),
	QN_CONST2("FTRUNCATE", FS_FTRUNCATE),
	QN_CONST2("FSYNC", FS_FSYNC),
	QN_CONST2("FDATASYNC", FS_FDATASYNC),
	QN_CONST2("FCHMOD", FS_FCHMOD),
	QN_CONST2("FCHOWN", FS_FCHOWN),
	QN_CONST2("FUTIME", FS_FUTIME),
	QN_CONST2("STAT", FS_STAT),
	QN_CONST2("LSTAT", FS_LSTAT),
	QN_CONST2("READDIR", FS_READDIR),
	QN_CONST2("MKDIR", FS_MKDIR),
	QN_CONST2("UNLINK", FS_UNLINK),
	QN_CONST2("RMDIR", FS_RMDIR),
	QN_CONST2("RENAME", FS_RENAME),
	QN_CONST2("SYMLINK", FS_SYMLINK),
	QN_CONST2("LINK", FS_LINK),
	QN_CONST2("READLINK", FS_READLINK),
	QN_CONST2("REALPATH", FS_REALPATH),
	QN_CONST2("ACCESS", FS_ACCESS),
	QN_CONST2("CHMOD", FS_CHMOD),
	QN_CONST2("UTIMES", FS_UTIMES),
	QN_CONST2("CHOWN", FS_CHOWN),
	QN_CONST2("LCHOWN", FS_LCHOWN),
	QN_CONST2("COPYFILE", FS_COPYFILE),
	QN_CONST2("MKDTEMP", FS_MKDTEMP),
	/* libuv errno constants for non-blocking I/O */
	QN_UVCONST(EAGAIN),
};

static int js_uv_fs_init(JSContext *ctx, JSModuleDef *m) {
	/* Register QNFile class with prototype */
	JS_NewClassID(&qn_file_class_id);
	JS_NewClass(JS_GetRuntime(ctx), qn_file_class_id, &qn_file_class);
	JSValue proto = JS_NewObject(ctx);
	JS_SetPropertyFunctionList(ctx, proto, qn_file_proto_funcs,
	                           countof(qn_file_proto_funcs));
	JS_SetClassProto(ctx, qn_file_class_id, proto);

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

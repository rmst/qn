/*
 * qn-tls.c - TLS bindings for QuickJS using BearSSL
 *
 * Provides blocking TLS client connections. The TLS context wraps
 * a connected socket fd and provides encrypted read/write operations.
 * Trust anchors (CA certificates) are loaded from system PEM files.
 */

#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/socket.h>

#include "bearssl.h"
#include "quickjs.h"

#define countof(x) (sizeof(x) / sizeof((x)[0]))

/* Maximum number of trust anchors (CA certificates) */
#define MAX_TRUST_ANCHORS 512


/* ---- Dynamic byte vector (for accumulating DN data) ---- */

typedef struct {
	unsigned char *data;
	size_t len;
	size_t cap;
} byte_vec_t;

static void bv_init(byte_vec_t *v)
{
	v->data = NULL;
	v->len = 0;
	v->cap = 0;
}

static void bv_append(void *ctx, const void *buf, size_t len)
{
	byte_vec_t *v = ctx;
	if (v->len + len > v->cap) {
		size_t new_cap = v->cap ? v->cap * 2 : 256;
		while (new_cap < v->len + len) new_cap *= 2;
		unsigned char *p = realloc(v->data, new_cap);
		if (!p) return;
		v->data = p;
		v->cap = new_cap;
	}
	memcpy(v->data + v->len, buf, len);
	v->len += len;
}

static unsigned char *bv_take(byte_vec_t *v, size_t *out_len)
{
	unsigned char *d = v->data;
	*out_len = v->len;
	v->data = NULL;
	v->len = 0;
	v->cap = 0;
	return d;
}

static void bv_clear(byte_vec_t *v)
{
	free(v->data);
	v->data = NULL;
	v->len = 0;
	v->cap = 0;
}

/* Duplicate a blob */
static unsigned char *blob_dup(const unsigned char *src, size_t len)
{
	unsigned char *d = malloc(len);
	if (d) memcpy(d, src, len);
	return d;
}

/* ---- Trust anchor storage ---- */

typedef struct {
	br_x509_trust_anchor *anchors;
	size_t num_anchors;
	size_t cap_anchors;
} trust_anchor_store_t;

static trust_anchor_store_t g_ta_store;

/* Add a decoded certificate as trust anchor.
 * Takes ownership of dn_data. */
static void add_trust_anchor(trust_anchor_store_t *store,
                             br_x509_decoder_context *xc,
                             unsigned char *dn_data, size_t dn_len)
{
	br_x509_pkey *pkey = br_x509_decoder_get_pkey(xc);
	if (!pkey) {
		free(dn_data);
		return;
	}

	if (store->num_anchors >= store->cap_anchors) {
		size_t new_cap = store->cap_anchors ? store->cap_anchors * 2 : 128;
		br_x509_trust_anchor *p = realloc(store->anchors,
			new_cap * sizeof(br_x509_trust_anchor));
		if (!p) {
			free(dn_data);
			return;
		}
		store->anchors = p;
		store->cap_anchors = new_cap;
	}

	br_x509_trust_anchor *ta = &store->anchors[store->num_anchors];

	ta->dn.data = dn_data;
	ta->dn.len = dn_len;
	ta->flags = br_x509_decoder_isCA(xc) ? BR_X509_TA_CA : 0;

	ta->pkey.key_type = pkey->key_type;
	if (pkey->key_type == BR_KEYTYPE_RSA) {
		ta->pkey.key.rsa.n = blob_dup(pkey->key.rsa.n, pkey->key.rsa.nlen);
		ta->pkey.key.rsa.nlen = pkey->key.rsa.nlen;
		ta->pkey.key.rsa.e = blob_dup(pkey->key.rsa.e, pkey->key.rsa.elen);
		ta->pkey.key.rsa.elen = pkey->key.rsa.elen;
		if (!ta->pkey.key.rsa.n || !ta->pkey.key.rsa.e) {
			free(ta->pkey.key.rsa.n);
			free(ta->pkey.key.rsa.e);
			free(dn_data);
			return;
		}
	} else if (pkey->key_type == BR_KEYTYPE_EC) {
		ta->pkey.key.ec.curve = pkey->key.ec.curve;
		ta->pkey.key.ec.q = blob_dup(pkey->key.ec.q, pkey->key.ec.qlen);
		ta->pkey.key.ec.qlen = pkey->key.ec.qlen;
		if (!ta->pkey.key.ec.q) {
			free(dn_data);
			return;
		}
	} else {
		free(dn_data);
		return;
	}

	store->num_anchors++;
}

/* Load trust anchors from a PEM file.
 *
 * PEM certificates are decoded with br_pem_decoder, fed into
 * br_x509_decoder, and the DN is captured via the bv_append callback.
 * We can't simply pipe PEM output directly to x509_decoder_push because
 * we also need to capture the DN, so we use an intermediate buffer. */

typedef struct {
	br_x509_decoder_context x509;
	byte_vec_t dn;
} cert_decode_ctx_t;

static void cert_dn_append(void *ctx, const void *buf, size_t len)
{
	cert_decode_ctx_t *cc = ctx;
	bv_append(&cc->dn, buf, len);
}

static void cert_data_push(void *ctx, const void *buf, size_t len)
{
	cert_decode_ctx_t *cc = ctx;
	br_x509_decoder_push(&cc->x509, buf, len);
}

static int load_ca_pem(trust_anchor_store_t *store, const char *path)
{
	FILE *f = fopen(path, "rb");
	if (!f) return -1;

	br_pem_decoder_context pem;
	cert_decode_ctx_t cc;
	unsigned char buf[8192];
	int in_cert = 0;
	size_t initial_count = store->num_anchors;

	br_pem_decoder_init(&pem);

	for (;;) {
		size_t n = fread(buf, 1, sizeof(buf), f);
		if (n == 0) break;

		size_t off = 0;
		while (off < n) {
			size_t pushed = br_pem_decoder_push(&pem, buf + off, n - off);
			off += pushed;

			int event = br_pem_decoder_event(&pem);
			if (event == BR_PEM_BEGIN_OBJ) {
				const char *name = br_pem_decoder_name(&pem);
				if (strcmp(name, "CERTIFICATE") == 0 ||
				    strcmp(name, "X509 CERTIFICATE") == 0 ||
				    strcmp(name, "TRUSTED CERTIFICATE") == 0) {
					bv_init(&cc.dn);
					br_x509_decoder_init(&cc.x509,
						cert_dn_append, &cc);
					br_pem_decoder_setdest(&pem,
						cert_data_push, &cc);
					in_cert = 1;
				} else {
					in_cert = 0;
					br_pem_decoder_setdest(&pem, NULL, NULL);
				}
			} else if (event == BR_PEM_END_OBJ && in_cert) {
				int err = br_x509_decoder_last_error(&cc.x509);
				if (err == 0) {
					size_t dn_len;
					unsigned char *dn_data = bv_take(&cc.dn, &dn_len);
					add_trust_anchor(store, &cc.x509,
						dn_data, dn_len);
				} else {
					bv_clear(&cc.dn);
				}
				in_cert = 0;
			} else if (event == BR_PEM_ERROR) {
				if (in_cert) bv_clear(&cc.dn);
				break;
			}
		}
	}

	fclose(f);
	return (int)(store->num_anchors - initial_count);
}


/* ---- TLS connection context ---- */

typedef struct {
	br_ssl_client_context sc;
	br_x509_minimal_context xc;
	br_sslio_context ioc;
	unsigned char iobuf[BR_SSL_BUFSIZE_BIDI];
	int fd;
	int connected;
} tls_conn_t;

/* Socket I/O callbacks for BearSSL */
static int tls_sock_read(void *ctx, unsigned char *buf, size_t len)
{
	int fd = *(int *)ctx;
	ssize_t n;
	for (;;) {
		n = read(fd, buf, len);
		if (n < 0) {
			if (errno == EINTR) continue;
			return -1;
		}
		return (int)n;
	}
}

static int tls_sock_write(void *ctx, const unsigned char *buf, size_t len)
{
	int fd = *(int *)ctx;
	ssize_t n;
	for (;;) {
		n = write(fd, buf, len);
		if (n < 0) {
			if (errno == EINTR) continue;
			return -1;
		}
		return (int)n;
	}
}

/* Make fd blocking for TLS I/O */
static int set_blocking(int fd)
{
	int flags = fcntl(fd, F_GETFL);
	if (flags < 0) return -1;
	return fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);
}

/* ---- QuickJS opaque class for TLS connections ---- */

static JSClassID tls_conn_class_id;

static void tls_conn_finalizer(JSRuntime *rt, JSValue val)
{
	tls_conn_t *conn = JS_GetOpaque(val, tls_conn_class_id);
	if (conn) {
		if (conn->connected) {
			br_ssl_engine_close(&conn->sc.eng);
		}
		free(conn);
	}
}

static JSClassDef tls_conn_class = {
	"TLSConnection",
	.finalizer = tls_conn_finalizer,
};

/*
 * tlsLoadCACerts(filePath) -> number of certs loaded from this file
 */
static JSValue js_tls_load_ca_certs(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path)
		return JS_EXCEPTION;
	int n = load_ca_pem(&g_ta_store, path);
	JS_FreeCString(ctx, path);
	return JS_NewInt32(ctx, n < 0 ? 0 : n);
}

/*
 * tlsConnect(fd, hostname) -> TLSConnection object
 *
 * Wraps a connected socket fd in a TLS client connection.
 * The socket is set to blocking mode for TLS I/O.
 * Performs TLS handshake including server certificate validation.
 * CA certs must be loaded via tlsLoadCACerts() before calling this.
 */
static JSValue js_tls_connect(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
	int fd;
	const char *hostname;

	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;
	hostname = JS_ToCString(ctx, argv[1]);
	if (!hostname)
		return JS_EXCEPTION;

	if (g_ta_store.num_anchors == 0) {
		JS_FreeCString(ctx, hostname);
		return JS_ThrowTypeError(ctx, "TLS: no CA certificates loaded. "
			"Call tlsLoadCACerts() first.");
	}

	/* Set socket to blocking for TLS handshake and I/O */
	if (set_blocking(fd) < 0) {
		JS_FreeCString(ctx, hostname);
		return JS_ThrowTypeError(ctx, "TLS: failed to set blocking mode: %s",
			strerror(errno));
	}

	tls_conn_t *conn = calloc(1, sizeof(tls_conn_t));
	if (!conn) {
		JS_FreeCString(ctx, hostname);
		return JS_ThrowOutOfMemory(ctx);
	}

	conn->fd = fd;

	/* Initialize TLS client with full cipher suite support */
	br_ssl_client_init_full(&conn->sc, &conn->xc,
		g_ta_store.anchors, g_ta_store.num_anchors);

	/* Set I/O buffer */
	br_ssl_engine_set_buffer(&conn->sc.eng, conn->iobuf,
		sizeof(conn->iobuf), 1);

	/* Reset for new handshake with SNI hostname */
	br_ssl_client_reset(&conn->sc, hostname, 0);
	JS_FreeCString(ctx, hostname);

	/* Initialize blocking I/O wrapper */
	br_sslio_init(&conn->ioc, &conn->sc.eng,
		tls_sock_read, &conn->fd,
		tls_sock_write, &conn->fd);

	conn->connected = 1;

	/* Create JS object with opaque data */
	JSValue obj = JS_NewObjectClass(ctx, tls_conn_class_id);
	if (JS_IsException(obj)) {
		free(conn);
		return obj;
	}
	JS_SetOpaque(obj, conn);
	return obj;
}

/*
 * tlsRead(conn, buffer, offset, length) -> bytes read, 0 for EOF, -1 for error
 */
static JSValue js_tls_read(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn)
		return JS_EXCEPTION;
	if (!conn->connected)
		return JS_NewInt32(ctx, 0);

	size_t size;
	uint8_t *buf = JS_GetArrayBuffer(ctx, &size, argv[1]);
	if (!buf)
		return JS_EXCEPTION;

	uint64_t off, len;
	if (JS_ToIndex(ctx, &off, argv[2]))
		return JS_EXCEPTION;
	if (JS_ToIndex(ctx, &len, argv[3]))
		return JS_EXCEPTION;

	if (off + len > size)
		return JS_ThrowRangeError(ctx, "buffer overflow");

	int n = br_sslio_read(&conn->ioc, buf + off, len);
	if (n < 0) {
		int err = br_ssl_engine_last_error(&conn->sc.eng);
		if (err == BR_ERR_OK || err == BR_ERR_IO) {
			/* Clean close or I/O error - treat as EOF */
			conn->connected = 0;
			return JS_NewInt32(ctx, 0);
		}
		return JS_ThrowTypeError(ctx, "TLS read error: %d", err);
	}

	return JS_NewInt32(ctx, n);
}

/*
 * tlsWrite(conn, buffer, offset, length) -> bytes written or -1
 */
static JSValue js_tls_write(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn)
		return JS_EXCEPTION;
	if (!conn->connected)
		return JS_ThrowTypeError(ctx, "TLS connection closed");

	size_t size;
	uint8_t *buf = JS_GetArrayBuffer(ctx, &size, argv[1]);
	if (!buf)
		return JS_EXCEPTION;

	uint64_t off, len;
	if (JS_ToIndex(ctx, &off, argv[2]))
		return JS_EXCEPTION;
	if (JS_ToIndex(ctx, &len, argv[3]))
		return JS_EXCEPTION;

	if (off + len > size)
		return JS_ThrowRangeError(ctx, "buffer overflow");

	int n = br_sslio_write(&conn->ioc, buf + off, len);
	if (n < 0) {
		int err = br_ssl_engine_last_error(&conn->sc.eng);
		return JS_ThrowTypeError(ctx, "TLS write error: %d", err);
	}

	return JS_NewInt32(ctx, n);
}

/*
 * tlsWriteAll(conn, buffer, offset, length) -> 0 on success
 */
static JSValue js_tls_write_all(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn)
		return JS_EXCEPTION;
	if (!conn->connected)
		return JS_ThrowTypeError(ctx, "TLS connection closed");

	size_t size;
	uint8_t *buf = JS_GetArrayBuffer(ctx, &size, argv[1]);
	if (!buf)
		return JS_EXCEPTION;

	uint64_t off, len;
	if (JS_ToIndex(ctx, &off, argv[2]))
		return JS_EXCEPTION;
	if (JS_ToIndex(ctx, &len, argv[3]))
		return JS_EXCEPTION;

	if (off + len > size)
		return JS_ThrowRangeError(ctx, "buffer overflow");

	int ret = br_sslio_write_all(&conn->ioc, buf + off, len);
	if (ret < 0) {
		int err = br_ssl_engine_last_error(&conn->sc.eng);
		return JS_ThrowTypeError(ctx, "TLS write error: %d", err);
	}

	return JS_NewInt32(ctx, 0);
}

/*
 * tlsFlush(conn) -> 0 on success
 */
static JSValue js_tls_flush(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn)
		return JS_EXCEPTION;
	if (!conn->connected)
		return JS_NewInt32(ctx, 0);

	int ret = br_sslio_flush(&conn->ioc);
	if (ret < 0) {
		int err = br_ssl_engine_last_error(&conn->sc.eng);
		return JS_ThrowTypeError(ctx, "TLS flush error: %d", err);
	}

	return JS_NewInt32(ctx, 0);
}

/*
 * tlsClose(conn) -> 0
 *
 * Marks the TLS connection as closed without performing a full
 * TLS shutdown handshake (which would block waiting for the peer's
 * close_notify). The underlying socket fd should be closed separately.
 */
static JSValue js_tls_close(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn)
		return JS_EXCEPTION;

	if (conn->connected) {
		/* Send close_notify but don't wait for peer's response.
		 * br_sslio_close() would block waiting for the peer,
		 * so we just mark the engine as closed and let the
		 * socket close handle the rest. */
		br_ssl_engine_close(&conn->sc.eng);
		conn->connected = 0;
	}

	return JS_NewInt32(ctx, 0);
}

/*
 * tlsCaCertCount() -> number of loaded CA certs
 */
static JSValue js_tls_ca_cert_count(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
	return JS_NewInt32(ctx, (int)g_ta_store.num_anchors);
}

static const JSCFunctionListEntry js_tls_funcs[] = {
	JS_CFUNC_DEF("tlsLoadCACerts", 1, js_tls_load_ca_certs),
	JS_CFUNC_DEF("tlsConnect", 2, js_tls_connect),
	JS_CFUNC_DEF("tlsRead", 4, js_tls_read),
	JS_CFUNC_DEF("tlsWrite", 4, js_tls_write),
	JS_CFUNC_DEF("tlsWriteAll", 4, js_tls_write_all),
	JS_CFUNC_DEF("tlsFlush", 1, js_tls_flush),
	JS_CFUNC_DEF("tlsClose", 1, js_tls_close),
	JS_CFUNC_DEF("tlsCaCertCount", 0, js_tls_ca_cert_count),
};

static int js_tls_init(JSContext *ctx, JSModuleDef *m)
{
	/* Register the TLSConnection class */
	JS_NewClassID(&tls_conn_class_id);
	JS_NewClass(JS_GetRuntime(ctx), tls_conn_class_id, &tls_conn_class);

	return JS_SetModuleExportList(ctx, m, js_tls_funcs,
	                              countof(js_tls_funcs));
}

JSModuleDef *js_init_module_qn_tls(JSContext *ctx, const char *module_name)
{
	JSModuleDef *m;
	m = JS_NewCModule(ctx, module_name, js_tls_init);
	if (!m)
		return NULL;
	JS_AddModuleExportList(ctx, m, js_tls_funcs,
	                       countof(js_tls_funcs));
	return m;
}

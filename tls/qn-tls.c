/*
 * qn-tls.c - TLS bindings for QuickJS using BearSSL
 *
 * Provides non-blocking TLS client and server connections. The C side exposes
 * the BearSSL engine state machine; the JS side (node:tls) drives it using
 * the QuickJS event loop for fully async TLS I/O.
 *
 * Architecture:
 *   C: thin wrappers around BearSSL engine operations (state, pump, send/recv)
 *   JS: async I/O loop that integrates with setReadHandler/setWriteHandler
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

/* Load trust anchors from a PEM file. */

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


/* ---- Certificate chain loading (for server certs, raw DER) ---- */

static int load_cert_chain_pem(const char *path,
                                br_x509_certificate **out_chain,
                                unsigned char ***out_bufs,
                                size_t *out_len)
{
	FILE *f = fopen(path, "rb");
	if (!f) return -1;

	br_pem_decoder_context pem;
	br_pem_decoder_init(&pem);
	unsigned char buf[8192];
	int in_cert = 0;
	byte_vec_t current;
	bv_init(&current);

	br_x509_certificate *chain = NULL;
	unsigned char **bufs = NULL;
	size_t num = 0, cap = 0;

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
					bv_init(&current);
					br_pem_decoder_setdest(&pem, bv_append, &current);
					in_cert = 1;
				} else {
					in_cert = 0;
					br_pem_decoder_setdest(&pem, NULL, NULL);
				}
			} else if (event == BR_PEM_END_OBJ && in_cert) {
				if (num >= cap) {
					size_t new_cap = cap ? cap * 2 : 4;
					chain = realloc(chain, new_cap * sizeof(br_x509_certificate));
					bufs = realloc(bufs, new_cap * sizeof(unsigned char *));
					cap = new_cap;
				}
				size_t der_len;
				unsigned char *der = bv_take(&current, &der_len);
				bufs[num] = der;
				chain[num].data = der;
				chain[num].data_len = der_len;
				num++;
				in_cert = 0;
			} else if (event == BR_PEM_ERROR) {
				if (in_cert) bv_clear(&current);
				break;
			}
		}
	}

	fclose(f);

	if (num == 0) {
		free(chain);
		free(bufs);
		return -1;
	}

	*out_chain = chain;
	*out_bufs = bufs;
	*out_len = num;
	return (int)num;
}


/* ---- Private key loading from PEM ---- */

static int load_private_key_pem(const char *path, br_skey_decoder_context *skey)
{
	FILE *f = fopen(path, "rb");
	if (!f) return -1;

	br_pem_decoder_context pem;
	br_pem_decoder_init(&pem);
	br_skey_decoder_init(skey);

	byte_vec_t current;
	bv_init(&current);
	int in_key = 0;
	int found = 0;
	unsigned char buf[8192];

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
				if (strcmp(name, "PRIVATE KEY") == 0 ||
				    strcmp(name, "RSA PRIVATE KEY") == 0 ||
				    strcmp(name, "EC PRIVATE KEY") == 0) {
					bv_init(&current);
					br_pem_decoder_setdest(&pem, bv_append, &current);
					in_key = 1;
				} else {
					in_key = 0;
					br_pem_decoder_setdest(&pem, NULL, NULL);
				}
			} else if (event == BR_PEM_END_OBJ && in_key) {
				size_t der_len;
				unsigned char *der = bv_take(&current, &der_len);
				br_skey_decoder_push(skey, der, der_len);
				free(der);
				found = 1;
				in_key = 0;
			} else if (event == BR_PEM_ERROR) {
				if (in_key) bv_clear(&current);
				break;
			}
		}
		if (found) break;
	}

	fclose(f);

	if (!found || br_skey_decoder_last_error(skey) != 0)
		return -1;
	return 0;
}


/* ---- TLS connection context ---- */

typedef struct {
	int is_server;
	union {
		struct {
			br_ssl_client_context sc;
			br_x509_minimal_context xc;
		} client;
		br_ssl_server_context server;
	} ctx;
	unsigned char iobuf[BR_SSL_BUFSIZE_BIDI];
	int fd;
} tls_conn_t;

static inline br_ssl_engine_context *tls_engine(tls_conn_t *c)
{
	return c->is_server ? &c->ctx.server.eng : &c->ctx.client.sc.eng;
}

/* Ensure fd is non-blocking for async TLS I/O */
static int set_nonblocking(int fd)
{
	int flags = fcntl(fd, F_GETFL);
	if (flags < 0) return -1;
	if (flags & O_NONBLOCK) return 0;
	return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/* ---- QuickJS opaque classes ---- */

static JSClassID tls_conn_class_id;
static JSClassID tls_server_cred_class_id;

static void tls_conn_finalizer(JSRuntime *rt, JSValue val)
{
	tls_conn_t *conn = JS_GetOpaque(val, tls_conn_class_id);
	if (conn) {
		br_ssl_engine_close(tls_engine(conn));
		free(conn);
	}
}

static JSClassDef tls_conn_class = {
	"TLSConnection",
	.finalizer = tls_conn_finalizer,
};

/* ---- Server credential storage ---- */

typedef struct {
	br_x509_certificate *chain;
	unsigned char **cert_bufs;
	size_t chain_len;
	br_skey_decoder_context skey;
	int key_type;
} tls_server_cred_t;

static void tls_server_cred_finalizer(JSRuntime *rt, JSValue val)
{
	tls_server_cred_t *cred = JS_GetOpaque(val, tls_server_cred_class_id);
	if (cred) {
		for (size_t i = 0; i < cred->chain_len; i++)
			free(cred->cert_bufs[i]);
		free(cred->cert_bufs);
		free(cred->chain);
		free(cred);
	}
}

static JSClassDef tls_server_cred_class = {
	"TLSServerCred",
	.finalizer = tls_server_cred_finalizer,
};


/* ---- JS functions ---- */

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
 * tlsLoadServerCert(certPemPath, keyPemPath) -> TLSServerCred object
 */
static JSValue js_tls_load_server_cert(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
	const char *cert_path = JS_ToCString(ctx, argv[0]);
	if (!cert_path)
		return JS_EXCEPTION;
	const char *key_path = JS_ToCString(ctx, argv[1]);
	if (!key_path) {
		JS_FreeCString(ctx, cert_path);
		return JS_EXCEPTION;
	}

	tls_server_cred_t *cred = calloc(1, sizeof(tls_server_cred_t));
	if (!cred) {
		JS_FreeCString(ctx, cert_path);
		JS_FreeCString(ctx, key_path);
		return JS_ThrowOutOfMemory(ctx);
	}

	int ncerts = load_cert_chain_pem(cert_path, &cred->chain,
	                                  &cred->cert_bufs, &cred->chain_len);
	JS_FreeCString(ctx, cert_path);

	if (ncerts <= 0) {
		JS_FreeCString(ctx, key_path);
		free(cred);
		return JS_ThrowTypeError(ctx, "TLS: failed to load certificate chain");
	}

	int ret = load_private_key_pem(key_path, &cred->skey);
	JS_FreeCString(ctx, key_path);

	if (ret < 0) {
		for (size_t i = 0; i < cred->chain_len; i++)
			free(cred->cert_bufs[i]);
		free(cred->cert_bufs);
		free(cred->chain);
		free(cred);
		return JS_ThrowTypeError(ctx, "TLS: failed to load private key");
	}

	cred->key_type = br_skey_decoder_key_type(&cred->skey);
	if (cred->key_type == 0) {
		for (size_t i = 0; i < cred->chain_len; i++)
			free(cred->cert_bufs[i]);
		free(cred->cert_bufs);
		free(cred->chain);
		free(cred);
		return JS_ThrowTypeError(ctx, "TLS: unsupported key type");
	}

	JSValue obj = JS_NewObjectClass(ctx, tls_server_cred_class_id);
	if (JS_IsException(obj)) {
		for (size_t i = 0; i < cred->chain_len; i++)
			free(cred->cert_bufs[i]);
		free(cred->cert_bufs);
		free(cred->chain);
		free(cred);
		return obj;
	}
	JS_SetOpaque(obj, cred);
	return obj;
}

/*
 * tlsConnect(fd, hostname) -> TLSConnection object
 *
 * Initializes a TLS client context on the given socket fd.
 * Does NOT perform the handshake — the JS side drives the engine
 * via tlsPumpRead/tlsPumpWrite until SENDAPP is available.
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

	if (set_nonblocking(fd) < 0) {
		JS_FreeCString(ctx, hostname);
		return JS_ThrowTypeError(ctx, "TLS: failed to set non-blocking: %s",
			strerror(errno));
	}

	tls_conn_t *conn = calloc(1, sizeof(tls_conn_t));
	if (!conn) {
		JS_FreeCString(ctx, hostname);
		return JS_ThrowOutOfMemory(ctx);
	}

	conn->is_server = 0;
	conn->fd = fd;

	br_ssl_client_init_full(&conn->ctx.client.sc, &conn->ctx.client.xc,
		g_ta_store.anchors, g_ta_store.num_anchors);

	/* TLS 1.2 only (TLS 1.0/1.1 deprecated per RFC 8996) */
	br_ssl_engine_set_versions(tls_engine(conn), BR_TLS12, BR_TLS12);

	br_ssl_engine_set_buffer(tls_engine(conn), conn->iobuf,
		sizeof(conn->iobuf), 1);

	br_ssl_client_reset(&conn->ctx.client.sc, hostname, 0);
	JS_FreeCString(ctx, hostname);

	JSValue obj = JS_NewObjectClass(ctx, tls_conn_class_id);
	if (JS_IsException(obj)) {
		free(conn);
		return obj;
	}
	JS_SetOpaque(obj, conn);
	return obj;
}

/*
 * tlsAccept(fd, cred) -> TLSConnection object
 *
 * Initializes a TLS server context on the given socket fd.
 * Does NOT perform the handshake — the JS side drives the engine.
 */
static JSValue js_tls_accept(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
	int fd;
	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	tls_server_cred_t *cred = JS_GetOpaque2(ctx, argv[1], tls_server_cred_class_id);
	if (!cred)
		return JS_EXCEPTION;

	if (set_nonblocking(fd) < 0)
		return JS_ThrowTypeError(ctx, "TLS: failed to set non-blocking: %s",
			strerror(errno));

	tls_conn_t *conn = calloc(1, sizeof(tls_conn_t));
	if (!conn)
		return JS_ThrowOutOfMemory(ctx);

	conn->is_server = 1;
	conn->fd = fd;

	if (cred->key_type == BR_KEYTYPE_RSA) {
		const br_rsa_private_key *sk = br_skey_decoder_get_rsa(&cred->skey);
		br_ssl_server_init_full_rsa(&conn->ctx.server,
			cred->chain, cred->chain_len, sk);
	} else {
		const br_ec_private_key *sk = br_skey_decoder_get_ec(&cred->skey);
		br_ssl_server_init_full_ec(&conn->ctx.server,
			cred->chain, cred->chain_len, cred->key_type, sk);
	}

	/* TLS 1.2 only */
	br_ssl_engine_set_versions(tls_engine(conn), BR_TLS12, BR_TLS12);

	/* ECDHE-only cipher suites (forward secrecy, no 3DES) */
	{
		static const uint16_t suites[] = {
			BR_TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
			BR_TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			BR_TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			BR_TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256,
			BR_TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA384,
			BR_TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
			BR_TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			BR_TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			BR_TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256,
			BR_TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA384,
		};
		br_ssl_engine_set_suites(tls_engine(conn), suites,
			sizeof(suites) / sizeof(suites[0]));
	}

	br_ssl_engine_set_buffer(tls_engine(conn),
		conn->iobuf, sizeof(conn->iobuf), 1);

	if (!br_ssl_server_reset(&conn->ctx.server)) {
		free(conn);
		return JS_ThrowTypeError(ctx, "TLS: server reset failed");
	}

	JSValue obj = JS_NewObjectClass(ctx, tls_conn_class_id);
	if (JS_IsException(obj)) {
		free(conn);
		return obj;
	}
	JS_SetOpaque(obj, conn);

	/* Prevent credential from being GC'd while connection is alive */
	JS_DefinePropertyValueStr(ctx, obj, "_cred",
		JS_DupValue(ctx, argv[1]), 0);

	return obj;
}

/*
 * tlsState(conn) -> engine state flags (bitmask)
 */
static JSValue js_tls_state(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;
	return JS_NewInt32(ctx, br_ssl_engine_current_state(tls_engine(conn)));
}

/*
 * tlsError(conn) -> engine error code (0 = no error)
 */
static JSValue js_tls_error(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;
	return JS_NewInt32(ctx, br_ssl_engine_last_error(tls_engine(conn)));
}

/*
 * tlsPumpRead(conn) -> bytes read, 0 for EOF, negative for error
 *
 * Non-blocking read from the socket fd into the engine's recvrec buffer.
 * Returns -EAGAIN if no data available.
 */
static JSValue js_tls_pump_read(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;

	br_ssl_engine_context *eng = tls_engine(conn);
	size_t len;
	unsigned char *buf = br_ssl_engine_recvrec_buf(eng, &len);
	if (!buf || len == 0) return JS_NewInt32(ctx, 0);

	ssize_t n = read(conn->fd, buf, len);
	if (n < 0) {
		if (errno == EAGAIN || errno == EWOULDBLOCK)
			return JS_NewInt32(ctx, -EAGAIN);
		return JS_NewInt32(ctx, -errno);
	}
	if (n == 0) return JS_NewInt32(ctx, 0);

	br_ssl_engine_recvrec_ack(eng, n);
	return JS_NewInt32(ctx, n);
}

/*
 * tlsPumpWrite(conn) -> bytes written, negative for error
 *
 * Non-blocking write from the engine's sendrec buffer to the socket fd.
 * Returns -EAGAIN if the socket buffer is full.
 */
static JSValue js_tls_pump_write(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;

	br_ssl_engine_context *eng = tls_engine(conn);
	size_t len;
	unsigned char *buf = br_ssl_engine_sendrec_buf(eng, &len);
	if (!buf || len == 0) return JS_NewInt32(ctx, 0);

	ssize_t n = write(conn->fd, buf, len);
	if (n < 0) {
		if (errno == EAGAIN || errno == EWOULDBLOCK)
			return JS_NewInt32(ctx, -EAGAIN);
		return JS_NewInt32(ctx, -errno);
	}

	br_ssl_engine_sendrec_ack(eng, n);
	return JS_NewInt32(ctx, n);
}

/*
 * tlsSendApp(conn, buffer, offset, length) -> bytes copied into engine
 *
 * Copies plaintext data from a JS buffer into the engine's sendapp buffer.
 * Returns bytes actually copied (may be less than requested).
 */
static JSValue js_tls_send_app(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;

	size_t buf_size;
	uint8_t *buf = JS_GetArrayBuffer(ctx, &buf_size, argv[1]);
	if (!buf) return JS_EXCEPTION;

	uint64_t off, len;
	if (JS_ToIndex(ctx, &off, argv[2])) return JS_EXCEPTION;
	if (JS_ToIndex(ctx, &len, argv[3])) return JS_EXCEPTION;
	if (off + len > buf_size) return JS_ThrowRangeError(ctx, "buffer overflow");

	br_ssl_engine_context *eng = tls_engine(conn);
	size_t avail;
	unsigned char *app_buf = br_ssl_engine_sendapp_buf(eng, &avail);
	if (!app_buf || avail == 0) return JS_NewInt32(ctx, 0);

	size_t to_copy = len < avail ? len : avail;
	memcpy(app_buf, buf + off, to_copy);
	br_ssl_engine_sendapp_ack(eng, to_copy);
	return JS_NewInt32(ctx, to_copy);
}

/*
 * tlsRecvApp(conn, buffer, offset, length) -> bytes copied from engine
 *
 * Copies decrypted plaintext from the engine's recvapp buffer into a JS buffer.
 * Returns bytes actually copied (may be less than requested).
 */
static JSValue js_tls_recv_app(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;

	size_t buf_size;
	uint8_t *buf = JS_GetArrayBuffer(ctx, &buf_size, argv[1]);
	if (!buf) return JS_EXCEPTION;

	uint64_t off, len;
	if (JS_ToIndex(ctx, &off, argv[2])) return JS_EXCEPTION;
	if (JS_ToIndex(ctx, &len, argv[3])) return JS_EXCEPTION;
	if (off + len > buf_size) return JS_ThrowRangeError(ctx, "buffer overflow");

	br_ssl_engine_context *eng = tls_engine(conn);
	size_t avail;
	unsigned char *app_buf = br_ssl_engine_recvapp_buf(eng, &avail);
	if (!app_buf || avail == 0) return JS_NewInt32(ctx, 0);

	size_t to_copy = len < avail ? len : avail;
	memcpy(buf + off, app_buf, to_copy);
	br_ssl_engine_recvapp_ack(eng, to_copy);
	return JS_NewInt32(ctx, to_copy);
}

/*
 * tlsFlush(conn, force) -> undefined
 *
 * Flushes buffered sendapp data into a TLS record for sending.
 */
static JSValue js_tls_flush(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;
	int force = 0;
	if (argc > 1 && !JS_IsUndefined(argv[1]))
		JS_ToInt32(ctx, &force, argv[1]);
	br_ssl_engine_flush(tls_engine(conn), force);
	return JS_UNDEFINED;
}

/*
 * tlsClose(conn) -> undefined
 *
 * Initiates TLS closure by assembling a close_notify alert.
 * The JS side must pump the engine to actually send it.
 */
static JSValue js_tls_close(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
	tls_conn_t *conn = JS_GetOpaque2(ctx, argv[0], tls_conn_class_id);
	if (!conn) return JS_EXCEPTION;
	br_ssl_engine_close(tls_engine(conn));
	return JS_UNDEFINED;
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
	JS_CFUNC_DEF("tlsLoadServerCert", 2, js_tls_load_server_cert),
	JS_CFUNC_DEF("tlsConnect", 2, js_tls_connect),
	JS_CFUNC_DEF("tlsAccept", 2, js_tls_accept),
	JS_CFUNC_DEF("tlsState", 1, js_tls_state),
	JS_CFUNC_DEF("tlsError", 1, js_tls_error),
	JS_CFUNC_DEF("tlsPumpRead", 1, js_tls_pump_read),
	JS_CFUNC_DEF("tlsPumpWrite", 1, js_tls_pump_write),
	JS_CFUNC_DEF("tlsSendApp", 4, js_tls_send_app),
	JS_CFUNC_DEF("tlsRecvApp", 4, js_tls_recv_app),
	JS_CFUNC_DEF("tlsFlush", 1, js_tls_flush),
	JS_CFUNC_DEF("tlsClose", 1, js_tls_close),
	JS_CFUNC_DEF("tlsCaCertCount", 0, js_tls_ca_cert_count),
	JS_PROP_INT32_DEF("TLS_CLOSED", BR_SSL_CLOSED, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("TLS_SENDREC", BR_SSL_SENDREC, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("TLS_RECVREC", BR_SSL_RECVREC, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("TLS_SENDAPP", BR_SSL_SENDAPP, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("TLS_RECVAPP", BR_SSL_RECVAPP, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("EAGAIN", EAGAIN, JS_PROP_CONFIGURABLE),
};

static int js_tls_init(JSContext *ctx, JSModuleDef *m)
{
	JS_NewClassID(&tls_conn_class_id);
	JS_NewClass(JS_GetRuntime(ctx), tls_conn_class_id, &tls_conn_class);

	JS_NewClassID(&tls_server_cred_class_id);
	JS_NewClass(JS_GetRuntime(ctx), tls_server_cred_class_id, &tls_server_cred_class);

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

/*
 * qn-wireguard.c - QuickJS WireGuard tunnel module
 *
 * Exposes WireGuard tunnel + lwIP TCP as a QuickJS native module.
 * The C side is non-blocking; the JS side drives async I/O using
 * os.setReadHandler and timers, following the same pattern as qn-tls.
 */

#include <string.h>
#include "quickjs.h"
#include "wg-netif.h"

#define countof(x) (sizeof(x) / sizeof((x)[0]))

/* ---- Tunnel class ---- */

static JSClassID wg_tunnel_class_id;

static void wg_tunnel_finalizer(JSRuntime *rt, JSValue val) {
	struct wg_tunnel *tunnel = JS_GetOpaque(val, wg_tunnel_class_id);
	if (tunnel) {
		wg_tunnel_destroy(tunnel);
		js_free_rt(rt, tunnel);
	}
}

static JSClassDef wg_tunnel_class = {
	"WireGuardTunnel",
	.finalizer = wg_tunnel_finalizer,
};

/* ---- Connection class ---- */

static JSClassID wg_conn_class_id;

typedef struct {
	struct wg_tunnel *tunnel;
	int conn_index;
} wg_conn_ref_t;

static void wg_conn_finalizer(JSRuntime *rt, JSValue val) {
	wg_conn_ref_t *ref = JS_GetOpaque(val, wg_conn_class_id);
	if (ref) {
		if (ref->tunnel && ref->conn_index >= 0)
			wg_tunnel_tcp_close(ref->tunnel, ref->conn_index);
		js_free_rt(rt, ref);
	}
}

static JSClassDef wg_conn_class = {
	"WireGuardConn",
	.finalizer = wg_conn_finalizer,
};

/* ---- JS API functions ---- */

/*
 * wgCreateTunnel(privateKey, address, netmask, listenAddress, listenPort) -> tunnel
 */
static JSValue js_wg_create_tunnel(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
	const char *private_key = JS_ToCString(ctx, argv[0]);
	if (!private_key) return JS_EXCEPTION;

	const char *address = JS_ToCString(ctx, argv[1]);
	if (!address) {
		JS_FreeCString(ctx, private_key);
		return JS_EXCEPTION;
	}

	const char *netmask = JS_ToCString(ctx, argv[2]);
	if (!netmask) {
		JS_FreeCString(ctx, private_key);
		JS_FreeCString(ctx, address);
		return JS_EXCEPTION;
	}

	const char *listen_address = NULL;
	if (argc > 3 && !JS_IsNull(argv[3]) && !JS_IsUndefined(argv[3])) {
		listen_address = JS_ToCString(ctx, argv[3]);
		if (!listen_address) {
			JS_FreeCString(ctx, private_key);
			JS_FreeCString(ctx, address);
			JS_FreeCString(ctx, netmask);
			return JS_EXCEPTION;
		}
	}

	int listen_port = 0;
	if (argc > 4 && !JS_IsUndefined(argv[4]))
		JS_ToInt32(ctx, &listen_port, argv[4]);

	struct wg_tunnel *tunnel = js_mallocz(ctx, sizeof(struct wg_tunnel));
	if (!tunnel) {
		JS_FreeCString(ctx, private_key);
		JS_FreeCString(ctx, address);
		JS_FreeCString(ctx, netmask);
		if (listen_address) JS_FreeCString(ctx, listen_address);
		return JS_EXCEPTION;
	}

	int rc = wg_tunnel_init(tunnel, private_key, address, netmask,
	                        listen_address, (uint16_t)listen_port);
	JS_FreeCString(ctx, private_key);
	JS_FreeCString(ctx, address);
	JS_FreeCString(ctx, netmask);
	if (listen_address) JS_FreeCString(ctx, listen_address);

	if (rc != 0) {
		js_free(ctx, tunnel);
		return JS_ThrowInternalError(ctx, "WireGuard: failed to initialize tunnel");
	}

	JSValue obj = JS_NewObjectClass(ctx, wg_tunnel_class_id);
	if (JS_IsException(obj)) {
		wg_tunnel_destroy(tunnel);
		js_free(ctx, tunnel);
		return obj;
	}
	JS_SetOpaque(obj, tunnel);
	return obj;
}

/*
 * wgGetFd(tunnel) -> fd number
 */
static JSValue js_wg_get_fd(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;
	return JS_NewInt32(ctx, wg_tunnel_get_fd(tunnel));
}

/*
 * wgAddPeer(tunnel, publicKey, presharedKey, endpoint, port, allowedIP, allowedMask, keepalive) -> peer_index
 */
static JSValue js_wg_add_peer(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;

	const char *public_key = JS_ToCString(ctx, argv[1]);
	if (!public_key) return JS_EXCEPTION;

	const char *preshared_key = NULL;
	if (!JS_IsNull(argv[2]) && !JS_IsUndefined(argv[2])) {
		preshared_key = JS_ToCString(ctx, argv[2]);
		if (!preshared_key) {
			JS_FreeCString(ctx, public_key);
			return JS_EXCEPTION;
		}
	}

	const char *endpoint = JS_ToCString(ctx, argv[3]);
	if (!endpoint) {
		JS_FreeCString(ctx, public_key);
		if (preshared_key) JS_FreeCString(ctx, preshared_key);
		return JS_EXCEPTION;
	}

	int port;
	JS_ToInt32(ctx, &port, argv[4]);

	const char *allowed_ip = JS_ToCString(ctx, argv[5]);
	if (!allowed_ip) {
		JS_FreeCString(ctx, public_key);
		if (preshared_key) JS_FreeCString(ctx, preshared_key);
		JS_FreeCString(ctx, endpoint);
		return JS_EXCEPTION;
	}

	const char *allowed_mask = JS_ToCString(ctx, argv[6]);
	if (!allowed_mask) {
		JS_FreeCString(ctx, public_key);
		if (preshared_key) JS_FreeCString(ctx, preshared_key);
		JS_FreeCString(ctx, endpoint);
		JS_FreeCString(ctx, allowed_ip);
		return JS_EXCEPTION;
	}

	int keepalive = 0;
	if (argc > 7)
		JS_ToInt32(ctx, &keepalive, argv[7]);

	int idx = wg_tunnel_add_peer(tunnel, public_key, preshared_key,
	                             endpoint, (uint16_t)port,
	                             allowed_ip, allowed_mask, (uint16_t)keepalive);

	JS_FreeCString(ctx, public_key);
	if (preshared_key) JS_FreeCString(ctx, preshared_key);
	JS_FreeCString(ctx, endpoint);
	JS_FreeCString(ctx, allowed_ip);
	JS_FreeCString(ctx, allowed_mask);

	if (idx < 0)
		return JS_ThrowInternalError(ctx, "WireGuard: failed to add peer");

	return JS_NewInt32(ctx, idx);
}

/*
 * wgConnect(tunnel, peerIndex) -> undefined
 */
static JSValue js_wg_connect(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;

	int peer_index;
	JS_ToInt32(ctx, &peer_index, argv[1]);

	if (wg_tunnel_connect(tunnel, peer_index) != 0)
		return JS_ThrowInternalError(ctx, "WireGuard: failed to connect to peer");

	return JS_UNDEFINED;
}

/*
 * wgPeerIsUp(tunnel, peerIndex) -> boolean
 */
static JSValue js_wg_peer_is_up(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;

	int peer_index;
	JS_ToInt32(ctx, &peer_index, argv[1]);

	return JS_NewBool(ctx, wg_tunnel_peer_is_up(tunnel, peer_index));
}

/*
 * wgProcessInput(tunnel) -> number of packets processed, or negative on error
 */
static JSValue js_wg_process_input(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;
	return JS_NewInt32(ctx, wg_tunnel_process_input(tunnel));
}

/*
 * wgCheckTimeouts(tunnel)
 */
static JSValue js_wg_check_timeouts(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;
	wg_tunnel_check_timeouts(tunnel);
	return JS_UNDEFINED;
}

/*
 * wgTcpListen(tunnel, port) -> listener_index
 */
static JSValue js_wg_tcp_listen(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;

	int port;
	JS_ToInt32(ctx, &port, argv[1]);

	int idx = wg_tunnel_tcp_listen(tunnel, (uint16_t)port);
	if (idx < 0)
		return JS_ThrowInternalError(ctx, "WireGuard: failed to listen on port %d", port);

	return JS_NewInt32(ctx, idx);
}

/*
 * wgTcpAccept(tunnel, listener_index) -> conn or undefined
 */
static JSValue js_wg_tcp_accept(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;

	int listener_index;
	JS_ToInt32(ctx, &listener_index, argv[1]);

	int conn_idx = wg_tunnel_tcp_accept(tunnel, listener_index);
	if (conn_idx < 0)
		return JS_UNDEFINED;

	wg_conn_ref_t *ref = js_mallocz(ctx, sizeof(wg_conn_ref_t));
	if (!ref) return JS_EXCEPTION;
	ref->tunnel = tunnel;
	ref->conn_index = conn_idx;

	JSValue obj = JS_NewObjectClass(ctx, wg_conn_class_id);
	if (JS_IsException(obj)) {
		wg_tunnel_tcp_close(tunnel, conn_idx);
		js_free(ctx, ref);
		return obj;
	}
	JS_SetOpaque(obj, ref);

	/* Prevent tunnel from being GC'd while connection exists */
	JS_DefinePropertyValueStr(ctx, obj, "_tunnel",
		JS_DupValue(ctx, argv[0]), 0);

	return obj;
}

/*
 * wgTcpUnlisten(tunnel, listener_index)
 */
static JSValue js_wg_tcp_unlisten(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;

	int listener_index;
	JS_ToInt32(ctx, &listener_index, argv[1]);

	wg_tunnel_tcp_unlisten(tunnel, listener_index);
	return JS_UNDEFINED;
}

/*
 * wgTcpConnect(tunnel, host, port) -> conn
 */
static JSValue js_wg_tcp_connect(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;

	const char *host = JS_ToCString(ctx, argv[1]);
	if (!host) return JS_EXCEPTION;

	int port;
	JS_ToInt32(ctx, &port, argv[2]);

	int conn_idx = wg_tunnel_tcp_connect(tunnel, host, (uint16_t)port);
	JS_FreeCString(ctx, host);

	if (conn_idx < 0)
		return JS_ThrowInternalError(ctx, "WireGuard: failed to create TCP connection");

	wg_conn_ref_t *ref = js_mallocz(ctx, sizeof(wg_conn_ref_t));
	if (!ref) return JS_EXCEPTION;
	ref->tunnel = tunnel;
	ref->conn_index = conn_idx;

	JSValue obj = JS_NewObjectClass(ctx, wg_conn_class_id);
	if (JS_IsException(obj)) {
		wg_tunnel_tcp_close(tunnel, conn_idx);
		js_free(ctx, ref);
		return obj;
	}
	JS_SetOpaque(obj, ref);

	/* Prevent tunnel from being GC'd while connection exists */
	JS_DefinePropertyValueStr(ctx, obj, "_tunnel",
		JS_DupValue(ctx, argv[0]), 0);

	return obj;
}

/*
 * wgTcpState(conn) -> state number
 */
static JSValue js_wg_tcp_state(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
	wg_conn_ref_t *ref = JS_GetOpaque2(ctx, argv[0], wg_conn_class_id);
	if (!ref) return JS_EXCEPTION;
	return JS_NewInt32(ctx, (int)wg_tunnel_tcp_state(ref->tunnel, ref->conn_index));
}

/*
 * wgTcpWrite(conn, buffer, offset, length) -> bytes written
 */
static JSValue js_wg_tcp_write(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
	wg_conn_ref_t *ref = JS_GetOpaque2(ctx, argv[0], wg_conn_class_id);
	if (!ref) return JS_EXCEPTION;

	size_t buf_size;
	uint8_t *buf = JS_GetArrayBuffer(ctx, &buf_size, argv[1]);
	if (!buf) return JS_EXCEPTION;

	uint64_t off, len;
	if (JS_ToIndex(ctx, &off, argv[2])) return JS_EXCEPTION;
	if (JS_ToIndex(ctx, &len, argv[3])) return JS_EXCEPTION;
	if (off + len > buf_size)
		return JS_ThrowRangeError(ctx, "buffer overflow");

	int n = wg_tunnel_tcp_write(ref->tunnel, ref->conn_index, buf + off, (size_t)len);
	return JS_NewInt32(ctx, n);
}

/*
 * wgTcpRead(conn, buffer, offset, length) -> bytes read
 */
static JSValue js_wg_tcp_read(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
	wg_conn_ref_t *ref = JS_GetOpaque2(ctx, argv[0], wg_conn_class_id);
	if (!ref) return JS_EXCEPTION;

	size_t buf_size;
	uint8_t *buf = JS_GetArrayBuffer(ctx, &buf_size, argv[1]);
	if (!buf) return JS_EXCEPTION;

	uint64_t off, len;
	if (JS_ToIndex(ctx, &off, argv[2])) return JS_EXCEPTION;
	if (JS_ToIndex(ctx, &len, argv[3])) return JS_EXCEPTION;
	if (off + len > buf_size)
		return JS_ThrowRangeError(ctx, "buffer overflow");

	int n = wg_tunnel_tcp_read(ref->tunnel, ref->conn_index, buf + off, (size_t)len);
	return JS_NewInt32(ctx, n);
}

/*
 * wgTcpReadable(conn) -> number of bytes available to read
 */
static JSValue js_wg_tcp_readable(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
	wg_conn_ref_t *ref = JS_GetOpaque2(ctx, argv[0], wg_conn_class_id);
	if (!ref) return JS_EXCEPTION;
	return JS_NewInt32(ctx, (int)wg_tunnel_tcp_readable(ref->tunnel, ref->conn_index));
}

/*
 * wgTcpClose(conn)
 */
static JSValue js_wg_tcp_close(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
	wg_conn_ref_t *ref = JS_GetOpaque2(ctx, argv[0], wg_conn_class_id);
	if (!ref) return JS_EXCEPTION;
	wg_tunnel_tcp_close(ref->tunnel, ref->conn_index);
	ref->conn_index = -1;
	return JS_UNDEFINED;
}

/*
 * wgClose(tunnel)
 */
static JSValue js_wg_close(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;
	wg_tunnel_destroy(tunnel);
	return JS_UNDEFINED;
}

/* ---- UDP API ---- */

/*
 * wgUdpBind(tunnel, port) -> sock_index
 */
static JSValue js_wg_udp_bind(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;

	int port;
	JS_ToInt32(ctx, &port, argv[1]);

	int idx = wg_tunnel_udp_bind(tunnel, (uint16_t)port);
	if (idx < 0)
		return JS_ThrowInternalError(ctx, "WireGuard: failed to bind UDP port %d", port);

	return JS_NewInt32(ctx, idx);
}

/*
 * wgUdpSendTo(tunnel, sock_index, buffer, offset, length, host, port) -> bytes sent
 */
static JSValue js_wg_udp_sendto(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;

	int sock_index;
	JS_ToInt32(ctx, &sock_index, argv[1]);

	size_t buf_size;
	uint8_t *buf = JS_GetArrayBuffer(ctx, &buf_size, argv[2]);
	if (!buf) return JS_EXCEPTION;

	uint64_t off, len;
	if (JS_ToIndex(ctx, &off, argv[3])) return JS_EXCEPTION;
	if (JS_ToIndex(ctx, &len, argv[4])) return JS_EXCEPTION;
	if (off + len > buf_size)
		return JS_ThrowRangeError(ctx, "buffer overflow");

	const char *host = JS_ToCString(ctx, argv[5]);
	if (!host) return JS_EXCEPTION;

	int port;
	JS_ToInt32(ctx, &port, argv[6]);

	int n = wg_tunnel_udp_sendto(tunnel, sock_index, buf + off, (size_t)len,
	                              host, (uint16_t)port);
	JS_FreeCString(ctx, host);

	return JS_NewInt32(ctx, n);
}

/*
 * wgUdpRecv(tunnel, sock_index, buffer, offset, length) -> { n, fromIp, fromPort } or undefined
 */
static JSValue js_wg_udp_recv(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;

	int sock_index;
	JS_ToInt32(ctx, &sock_index, argv[1]);

	size_t buf_size;
	uint8_t *buf = JS_GetArrayBuffer(ctx, &buf_size, argv[2]);
	if (!buf) return JS_EXCEPTION;

	uint64_t off, len;
	if (JS_ToIndex(ctx, &off, argv[3])) return JS_EXCEPTION;
	if (JS_ToIndex(ctx, &len, argv[4])) return JS_EXCEPTION;
	if (off + len > buf_size)
		return JS_ThrowRangeError(ctx, "buffer overflow");

	uint32_t from_ip = 0;
	uint16_t from_port = 0;
	int n = wg_tunnel_udp_recv(tunnel, sock_index, buf + off, (size_t)len,
	                            &from_ip, &from_port);
	if (n <= 0)
		return JS_UNDEFINED;

	/* Format IP as string */
	char ip_str[16];
	snprintf(ip_str, sizeof(ip_str), "%u.%u.%u.%u",
	         (from_ip >> 24) & 0xFF, (from_ip >> 16) & 0xFF,
	         (from_ip >> 8) & 0xFF, from_ip & 0xFF);

	JSValue result = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, result, "n", JS_NewInt32(ctx, n));
	JS_SetPropertyStr(ctx, result, "address", JS_NewString(ctx, ip_str));
	JS_SetPropertyStr(ctx, result, "port", JS_NewInt32(ctx, from_port));
	return result;
}

/*
 * wgUdpPending(tunnel, sock_index) -> number of queued datagrams
 */
static JSValue js_wg_udp_pending(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;

	int sock_index;
	JS_ToInt32(ctx, &sock_index, argv[1]);

	return JS_NewInt32(ctx, wg_tunnel_udp_pending(tunnel, sock_index));
}

/*
 * wgUdpClose(tunnel, sock_index)
 */
static JSValue js_wg_udp_close(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
	struct wg_tunnel *tunnel = JS_GetOpaque2(ctx, argv[0], wg_tunnel_class_id);
	if (!tunnel) return JS_EXCEPTION;

	int sock_index;
	JS_ToInt32(ctx, &sock_index, argv[1]);

	wg_tunnel_udp_close(tunnel, sock_index);
	return JS_UNDEFINED;
}

/* ---- Module definition ---- */

static const JSCFunctionListEntry js_wg_funcs[] = {
	JS_CFUNC_DEF("wgCreateTunnel", 5, js_wg_create_tunnel),
	JS_CFUNC_DEF("wgGetFd", 1, js_wg_get_fd),
	JS_CFUNC_DEF("wgAddPeer", 8, js_wg_add_peer),
	JS_CFUNC_DEF("wgConnect", 2, js_wg_connect),
	JS_CFUNC_DEF("wgPeerIsUp", 2, js_wg_peer_is_up),
	JS_CFUNC_DEF("wgProcessInput", 1, js_wg_process_input),
	JS_CFUNC_DEF("wgCheckTimeouts", 1, js_wg_check_timeouts),
	JS_CFUNC_DEF("wgTcpListen", 2, js_wg_tcp_listen),
	JS_CFUNC_DEF("wgTcpAccept", 2, js_wg_tcp_accept),
	JS_CFUNC_DEF("wgTcpUnlisten", 2, js_wg_tcp_unlisten),
	JS_CFUNC_DEF("wgTcpConnect", 3, js_wg_tcp_connect),
	JS_CFUNC_DEF("wgTcpState", 1, js_wg_tcp_state),
	JS_CFUNC_DEF("wgTcpWrite", 4, js_wg_tcp_write),
	JS_CFUNC_DEF("wgTcpRead", 4, js_wg_tcp_read),
	JS_CFUNC_DEF("wgTcpReadable", 1, js_wg_tcp_readable),
	JS_CFUNC_DEF("wgTcpClose", 1, js_wg_tcp_close),
	JS_CFUNC_DEF("wgClose", 1, js_wg_close),
	/* UDP */
	JS_CFUNC_DEF("wgUdpBind", 2, js_wg_udp_bind),
	JS_CFUNC_DEF("wgUdpSendTo", 7, js_wg_udp_sendto),
	JS_CFUNC_DEF("wgUdpRecv", 5, js_wg_udp_recv),
	JS_CFUNC_DEF("wgUdpPending", 2, js_wg_udp_pending),
	JS_CFUNC_DEF("wgUdpClose", 2, js_wg_udp_close),
	/* State constants */
	JS_PROP_INT32_DEF("WG_TCP_NONE", WG_TCP_NONE, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("WG_TCP_CONNECTING", WG_TCP_CONNECTING, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("WG_TCP_CONNECTED", WG_TCP_CONNECTED, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("WG_TCP_CLOSING", WG_TCP_CLOSING, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("WG_TCP_CLOSED", WG_TCP_CLOSED, JS_PROP_CONFIGURABLE),
	JS_PROP_INT32_DEF("WG_TCP_ERROR", WG_TCP_ERROR, JS_PROP_CONFIGURABLE),
};

static int js_wg_init(JSContext *ctx, JSModuleDef *m) {
	/* Initialize tunnel class */
	JS_NewClassID(&wg_tunnel_class_id);
	JS_NewClass(JS_GetRuntime(ctx), wg_tunnel_class_id, &wg_tunnel_class);

	/* Initialize connection class */
	JS_NewClassID(&wg_conn_class_id);
	JS_NewClass(JS_GetRuntime(ctx), wg_conn_class_id, &wg_conn_class);

	return JS_SetModuleExportList(ctx, m, js_wg_funcs, countof(js_wg_funcs));
}

JSModuleDef *js_init_module_qn_wireguard(JSContext *ctx, const char *module_name) {
	JSModuleDef *m;
	m = JS_NewCModule(ctx, module_name, js_wg_init);
	if (!m)
		return NULL;
	JS_AddModuleExportList(ctx, m, js_wg_funcs, countof(js_wg_funcs));
	return m;
}

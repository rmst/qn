/*
 * qn_uv_dns - Async DNS resolution via libuv
 *
 * Replaces the pthread+pipe approach in qn-socket.c with libuv's
 * built-in uv_getaddrinfo (uses libuv's threadpool internally).
 *
 * Adapted from txiki.js mod_dns.c by Saul Ibarra Corretge (MIT).
 */

#include "qn-uv-utils.h"

#include <string.h>

typedef struct {
	JSContext *ctx;
	uv_getaddrinfo_t req;
	QNPromise result;
} QNGetAddrInfoReq;

static JSValue addrinfo2arr(JSContext *ctx, struct addrinfo *ai) {
	JSValue arr = JS_NewArray(ctx);
	uint32_t i = 0;

	for (struct addrinfo *ptr = ai; ptr; ptr = ptr->ai_next) {
		char buf[INET6_ADDRSTRLEN + 1];
		const char *ip = NULL;
		int family = ptr->ai_family;

		if (family == AF_INET) {
			struct sockaddr_in *a4 = (struct sockaddr_in *)ptr->ai_addr;
			ip = uv_ip4_name(a4, buf, sizeof(buf)) == 0 ? buf : NULL;
		} else if (family == AF_INET6) {
			struct sockaddr_in6 *a6 = (struct sockaddr_in6 *)ptr->ai_addr;
			ip = uv_ip6_name(a6, buf, sizeof(buf)) == 0 ? buf : NULL;
		}

		if (ip) {
			JSValue obj = JS_NewObject(ctx);
			JS_DefinePropertyValueStr(ctx, obj, "family",
				JS_NewInt32(ctx, family), JS_PROP_C_W_E);
			JS_DefinePropertyValueStr(ctx, obj, "address",
				JS_NewString(ctx, ip), JS_PROP_C_W_E);
			JS_DefinePropertyValueUint32(ctx, arr, i++, obj, JS_PROP_C_W_E);
		}
	}

	return arr;
}

static void uv__getaddrinfo_cb(uv_getaddrinfo_t *req, int status, struct addrinfo *res) {
	QNGetAddrInfoReq *gr = req->data;
	JSContext *ctx = gr->ctx;
	JSValue arg;
	bool is_reject = (status != 0);

	if (is_reject) {
		arg = qn_new_error(ctx, status);
	} else {
		arg = addrinfo2arr(ctx, res);
	}

	qn_promise_settle(ctx, &gr->result, is_reject, 1, &arg);

	uv_freeaddrinfo(res);
	js_free(ctx, gr);
}

/* getaddrinfo(host, port, hints) → Promise<[{family, address}]>
 *
 * hints is optional: { family, socktype }
 * Compatible with the shape returned by qn_socket's getaddrinfo. */
static JSValue js_uv_getaddrinfo(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
	const char *host = NULL;
	const char *service = NULL;
	char port_str[16];

	if (!JS_IsUndefined(argv[0]) && !JS_IsNull(argv[0])) {
		host = JS_ToCString(ctx, argv[0]);
		if (!host)
			return JS_EXCEPTION;
	}

	/* Second arg: port number or service string */
	if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
		if (JS_IsNumber(argv[1])) {
			int port;
			if (JS_ToInt32(ctx, &port, argv[1])) {
				JS_FreeCString(ctx, host);
				return JS_EXCEPTION;
			}
			snprintf(port_str, sizeof(port_str), "%d", port);
			service = port_str;
		} else {
			service = JS_ToCString(ctx, argv[1]);
			if (!service) {
				JS_FreeCString(ctx, host);
				return JS_EXCEPTION;
			}
		}
	}

	struct addrinfo hints;
	memset(&hints, 0, sizeof(hints));
	hints.ai_family = AF_UNSPEC;
	hints.ai_socktype = SOCK_STREAM;

	if (argc >= 3 && !JS_IsUndefined(argv[2])) {
		JSValue val;
		val = JS_GetPropertyStr(ctx, argv[2], "family");
		if (!JS_IsUndefined(val))
			JS_ToInt32(ctx, &hints.ai_family, val);
		JS_FreeValue(ctx, val);

		val = JS_GetPropertyStr(ctx, argv[2], "socktype");
		if (!JS_IsUndefined(val))
			JS_ToInt32(ctx, &hints.ai_socktype, val);
		JS_FreeValue(ctx, val);
	}

	QNGetAddrInfoReq *gr = js_malloc(ctx, sizeof(*gr));
	if (!gr) {
		JS_FreeCString(ctx, host);
		if (service && service != port_str)
			JS_FreeCString(ctx, service);
		return JS_EXCEPTION;
	}

	gr->ctx = ctx;
	gr->req.data = gr;

	int r = uv_getaddrinfo(js_uv_loop(ctx), &gr->req, uv__getaddrinfo_cb,
	                        host, service, &hints);

	JS_FreeCString(ctx, host);
	if (service && service != port_str)
		JS_FreeCString(ctx, service);

	if (r != 0) {
		js_free(ctx, gr);
		return qn_throw_errno(ctx, r);
	}

	return qn_promise_init(ctx, &gr->result);
}

static const JSCFunctionListEntry js_uv_dns_funcs[] = {
	QN_CFUNC_DEF("getaddrinfo", 3, js_uv_getaddrinfo),
};

static int js_uv_dns_init(JSContext *ctx, JSModuleDef *m) {
	return JS_SetModuleExportList(ctx, m, js_uv_dns_funcs,
		sizeof(js_uv_dns_funcs) / sizeof(js_uv_dns_funcs[0]));
}

JSModuleDef *js_init_module_qn_uv_dns(JSContext *ctx, const char *module_name) {
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_uv_dns_init);
	if (!m)
		return NULL;
	JS_AddModuleExportList(ctx, m, js_uv_dns_funcs,
		sizeof(js_uv_dns_funcs) / sizeof(js_uv_dns_funcs[0]));
	return m;
}

/*
 * qn-socket.c - POSIX socket bindings for QuickJS
 *
 * Provides low-level socket syscall wrappers. Higher-level async I/O
 * is built in JavaScript using os.setReadHandler/os.setWriteHandler
 * and os.read/os.write which already work on socket file descriptors.
 */

#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <netdb.h>
#include "quickjs.h"

#define countof(x) (sizeof(x) / sizeof((x)[0]))

/* Helper: set fd to non-blocking mode */
static int set_nonblock(int fd)
{
	int flags = fcntl(fd, F_GETFL);
	if (flags < 0)
		return -1;
	return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/* Helper: convert sockaddr to JS object { address, port, family } */
static JSValue sockaddr_to_js(JSContext *ctx, struct sockaddr_storage *addr)
{
	JSValue obj = JS_NewObject(ctx);
	char host[INET6_ADDRSTRLEN];

	if (addr->ss_family == AF_INET) {
		struct sockaddr_in *a4 = (struct sockaddr_in *)addr;
		inet_ntop(AF_INET, &a4->sin_addr, host, sizeof(host));
		JS_SetPropertyStr(ctx, obj, "address", JS_NewString(ctx, host));
		JS_SetPropertyStr(ctx, obj, "port", JS_NewInt32(ctx, ntohs(a4->sin_port)));
		JS_SetPropertyStr(ctx, obj, "family", JS_NewInt32(ctx, AF_INET));
	} else if (addr->ss_family == AF_INET6) {
		struct sockaddr_in6 *a6 = (struct sockaddr_in6 *)addr;
		inet_ntop(AF_INET6, &a6->sin6_addr, host, sizeof(host));
		JS_SetPropertyStr(ctx, obj, "address", JS_NewString(ctx, host));
		JS_SetPropertyStr(ctx, obj, "port", JS_NewInt32(ctx, ntohs(a6->sin6_port)));
		JS_SetPropertyStr(ctx, obj, "family", JS_NewInt32(ctx, AF_INET6));
	} else {
		JS_FreeValue(ctx, obj);
		return JS_ThrowTypeError(ctx, "unsupported address family: %d", addr->ss_family);
	}

	return obj;
}

/* Helper: convert host string + port to sockaddr.
 * Returns 0 on success, -1 on failure (exception set). */
static int js_to_sockaddr(JSContext *ctx, const char *host, int port, int family,
                          struct sockaddr_storage *addr, socklen_t *addrlen)
{
	memset(addr, 0, sizeof(*addr));

	if (family == AF_INET || family == 0) {
		struct sockaddr_in *a4 = (struct sockaddr_in *)addr;
		if (inet_pton(AF_INET, host, &a4->sin_addr) == 1) {
			a4->sin_family = AF_INET;
			a4->sin_port = htons(port);
			*addrlen = sizeof(*a4);
			return 0;
		}
	}

	if (family == AF_INET6 || family == 0) {
		struct sockaddr_in6 *a6 = (struct sockaddr_in6 *)addr;
		if (inet_pton(AF_INET6, host, &a6->sin6_addr) == 1) {
			a6->sin6_family = AF_INET6;
			a6->sin6_port = htons(port);
			*addrlen = sizeof(*a6);
			return 0;
		}
	}

	JS_ThrowTypeError(ctx, "invalid address: %s", host);
	return -1;
}

/*
 * socket(family, type) -> fd
 *
 * Creates a new socket. The socket is set to non-blocking mode.
 * family: AF_INET (2) or AF_INET6 (10)
 * type: SOCK_STREAM (1) or SOCK_DGRAM (2)
 */
static JSValue js_socket(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
	int family, type, fd;

	if (JS_ToInt32(ctx, &family, argv[0]))
		return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &type, argv[1]))
		return JS_EXCEPTION;

	fd = socket(family, type, 0);
	if (fd < 0)
		return JS_ThrowTypeError(ctx, "socket error: %s", strerror(errno));

	if (set_nonblock(fd) < 0) {
		close(fd);
		return JS_ThrowTypeError(ctx, "fcntl error: %s", strerror(errno));
	}

	return JS_NewInt32(ctx, fd);
}

/*
 * bind(fd, host, port) -> 0
 */
static JSValue js_bind(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
	int fd, port, ret;
	const char *host;
	struct sockaddr_storage addr;
	socklen_t addrlen;

	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;
	host = JS_ToCString(ctx, argv[1]);
	if (!host)
		return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &port, argv[2])) {
		JS_FreeCString(ctx, host);
		return JS_EXCEPTION;
	}

	if (js_to_sockaddr(ctx, host, port, 0, &addr, &addrlen) < 0) {
		JS_FreeCString(ctx, host);
		return JS_EXCEPTION;
	}
	JS_FreeCString(ctx, host);

	ret = bind(fd, (struct sockaddr *)&addr, addrlen);
	if (ret < 0)
		return JS_ThrowTypeError(ctx, "bind error: %s", strerror(errno));

	return JS_NewInt32(ctx, 0);
}

/*
 * listen(fd, backlog) -> 0
 */
static JSValue js_listen(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
	int fd, backlog, ret;

	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;
	if (argc >= 2) {
		if (JS_ToInt32(ctx, &backlog, argv[1]))
			return JS_EXCEPTION;
	} else {
		backlog = 128;
	}

	ret = listen(fd, backlog);
	if (ret < 0)
		return JS_ThrowTypeError(ctx, "listen error: %s", strerror(errno));

	return JS_NewInt32(ctx, 0);
}

/*
 * accept(fd) -> { fd, address, port, family } or null if EAGAIN/EWOULDBLOCK
 *
 * Non-blocking accept. Returns null when no connection is pending.
 * Use os.setReadHandler() on the listening socket to know when to call accept().
 */
static JSValue js_accept(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
	int lfd, cfd;
	struct sockaddr_storage addr;
	socklen_t addrlen = sizeof(addr);
	JSValue obj, addrobj;

	if (JS_ToInt32(ctx, &lfd, argv[0]))
		return JS_EXCEPTION;

	cfd = accept(lfd, (struct sockaddr *)&addr, &addrlen);
	if (cfd < 0) {
		if (errno == EAGAIN || errno == EWOULDBLOCK)
			return JS_NULL;
		return JS_ThrowTypeError(ctx, "accept error: %s", strerror(errno));
	}

	if (set_nonblock(cfd) < 0) {
		close(cfd);
		return JS_ThrowTypeError(ctx, "fcntl error: %s", strerror(errno));
	}

	addrobj = sockaddr_to_js(ctx, &addr);
	if (JS_IsException(addrobj)) {
		close(cfd);
		return JS_EXCEPTION;
	}

	obj = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, obj, "fd", JS_NewInt32(ctx, cfd));
	JS_SetPropertyStr(ctx, obj, "address",
	                  JS_GetPropertyStr(ctx, addrobj, "address"));
	JS_SetPropertyStr(ctx, obj, "port",
	                  JS_GetPropertyStr(ctx, addrobj, "port"));
	JS_SetPropertyStr(ctx, obj, "family",
	                  JS_GetPropertyStr(ctx, addrobj, "family"));
	JS_FreeValue(ctx, addrobj);

	return obj;
}

/*
 * connect(fd, host, port) -> 0 or -EINPROGRESS
 *
 * Non-blocking connect. Returns 0 if immediately connected,
 * -EINPROGRESS if connection is in progress.
 * Use os.setWriteHandler() to detect when connect completes,
 * then call connectFinish(fd) to check the result.
 */
static JSValue js_connect(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
	int fd, port, ret;
	const char *host;
	struct sockaddr_storage addr;
	socklen_t addrlen;

	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;
	host = JS_ToCString(ctx, argv[1]);
	if (!host)
		return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &port, argv[2])) {
		JS_FreeCString(ctx, host);
		return JS_EXCEPTION;
	}

	if (js_to_sockaddr(ctx, host, port, 0, &addr, &addrlen) < 0) {
		JS_FreeCString(ctx, host);
		return JS_EXCEPTION;
	}
	JS_FreeCString(ctx, host);

	ret = connect(fd, (struct sockaddr *)&addr, addrlen);
	if (ret < 0) {
		if (errno == EINPROGRESS)
			return JS_NewInt32(ctx, -EINPROGRESS);
		return JS_ThrowTypeError(ctx, "connect error: %s", strerror(errno));
	}

	return JS_NewInt32(ctx, 0);
}

/*
 * connectFinish(fd) -> 0 on success, throws on error
 *
 * Called after os.setWriteHandler fires to check if connect() succeeded.
 */
static JSValue js_connect_finish(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
	int fd, err;
	socklen_t len = sizeof(err);

	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) < 0)
		return JS_ThrowTypeError(ctx, "getsockopt error: %s", strerror(errno));

	if (err != 0)
		return JS_ThrowTypeError(ctx, "connect error: %s", strerror(err));

	return JS_NewInt32(ctx, 0);
}

/*
 * setsockopt(fd, level, optname, value) -> 0
 */
static JSValue js_setsockopt(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
	int fd, level, optname, value, ret;

	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &level, argv[1]))
		return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &optname, argv[2]))
		return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &value, argv[3]))
		return JS_EXCEPTION;

	ret = setsockopt(fd, level, optname, &value, sizeof(value));
	if (ret < 0)
		return JS_ThrowTypeError(ctx, "setsockopt error: %s", strerror(errno));

	return JS_NewInt32(ctx, 0);
}

/*
 * getsockname(fd) -> { address, port, family }
 */
static JSValue js_getsockname(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
	int fd;
	struct sockaddr_storage addr;
	socklen_t addrlen = sizeof(addr);

	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	if (getsockname(fd, (struct sockaddr *)&addr, &addrlen) < 0)
		return JS_ThrowTypeError(ctx, "getsockname error: %s", strerror(errno));

	return sockaddr_to_js(ctx, &addr);
}

/*
 * getpeername(fd) -> { address, port, family }
 */
static JSValue js_getpeername(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
	int fd;
	struct sockaddr_storage addr;
	socklen_t addrlen = sizeof(addr);

	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	if (getpeername(fd, (struct sockaddr *)&addr, &addrlen) < 0)
		return JS_ThrowTypeError(ctx, "getpeername error: %s", strerror(errno));

	return sockaddr_to_js(ctx, &addr);
}

/*
 * shutdown(fd, how) -> 0
 * how: 0=SHUT_RD, 1=SHUT_WR, 2=SHUT_RDWR
 */
static JSValue js_shutdown(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
	int fd, how, ret;

	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &how, argv[1]))
		return JS_EXCEPTION;

	ret = shutdown(fd, how);
	if (ret < 0)
		return JS_ThrowTypeError(ctx, "shutdown error: %s", strerror(errno));

	return JS_NewInt32(ctx, 0);
}

/*
 * getaddrinfo(host, port, hints) -> [{ family, address }]
 *
 * Resolves hostname. hints is optional: { family, socktype }
 * Note: this is a blocking call.
 */
static JSValue js_getaddrinfo(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
	const char *host, *service = NULL;
	char port_str[16];
	struct addrinfo hints, *res, *rp;
	JSValue arr, obj;
	int ret, idx = 0;

	host = JS_ToCString(ctx, argv[0]);
	if (!host)
		return JS_EXCEPTION;

	/* Second arg can be port number or service name */
	if (argc >= 2 && !JS_IsUndefined(argv[1])) {
		int port;
		if (JS_IsNumber(argv[1])) {
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

	memset(&hints, 0, sizeof(hints));
	hints.ai_family = AF_UNSPEC;
	hints.ai_socktype = SOCK_STREAM;

	if (argc >= 3 && !JS_IsUndefined(argv[2])) {
		JSValue val;
		val = JS_GetPropertyStr(ctx, argv[2], "family");
		if (!JS_IsUndefined(val)) {
			JS_ToInt32(ctx, &hints.ai_family, val);
		}
		JS_FreeValue(ctx, val);

		val = JS_GetPropertyStr(ctx, argv[2], "socktype");
		if (!JS_IsUndefined(val)) {
			JS_ToInt32(ctx, &hints.ai_socktype, val);
		}
		JS_FreeValue(ctx, val);
	}

	ret = getaddrinfo(host, service, &hints, &res);
	JS_FreeCString(ctx, host);
	if (service && service != port_str)
		JS_FreeCString(ctx, service);

	if (ret != 0)
		return JS_ThrowTypeError(ctx, "getaddrinfo error: %s", gai_strerror(ret));

	arr = JS_NewArray(ctx);
	for (rp = res; rp != NULL; rp = rp->ai_next) {
		char addr_str[INET6_ADDRSTRLEN];
		const char *p = NULL;

		if (rp->ai_family == AF_INET) {
			struct sockaddr_in *a4 = (struct sockaddr_in *)rp->ai_addr;
			p = inet_ntop(AF_INET, &a4->sin_addr, addr_str, sizeof(addr_str));
		} else if (rp->ai_family == AF_INET6) {
			struct sockaddr_in6 *a6 = (struct sockaddr_in6 *)rp->ai_addr;
			p = inet_ntop(AF_INET6, &a6->sin6_addr, addr_str, sizeof(addr_str));
		}

		if (p) {
			obj = JS_NewObject(ctx);
			JS_SetPropertyStr(ctx, obj, "family", JS_NewInt32(ctx, rp->ai_family));
			JS_SetPropertyStr(ctx, obj, "address", JS_NewString(ctx, addr_str));
			JS_SetPropertyUint32(ctx, arr, idx++, obj);
		}
	}

	freeaddrinfo(res);
	return arr;
}

/*
 * send(fd, buffer, offset, length) -> bytes sent or -EAGAIN
 *
 * Like os.write but uses send() with MSG_NOSIGNAL to avoid SIGPIPE.
 */
static JSValue js_send(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
	int fd;
	size_t size;
	uint64_t off, len;
	uint8_t *buf;
	ssize_t ret;

	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	buf = JS_GetArrayBuffer(ctx, &size, argv[1]);
	if (!buf)
		return JS_EXCEPTION;

	if (JS_ToIndex(ctx, &off, argv[2]))
		return JS_EXCEPTION;
	if (JS_ToIndex(ctx, &len, argv[3]))
		return JS_EXCEPTION;

	if (off + len > size)
		return JS_ThrowRangeError(ctx, "buffer overflow");

	ret = send(fd, buf + off, len, MSG_NOSIGNAL);
	if (ret < 0) {
		if (errno == EAGAIN || errno == EWOULDBLOCK)
			return JS_NewInt32(ctx, -EAGAIN);
		return JS_ThrowTypeError(ctx, "send error: %s", strerror(errno));
	}

	return JS_NewInt64(ctx, ret);
}

/*
 * recv(fd, buffer, offset, length) -> bytes received, 0 for EOF, or -EAGAIN
 */
static JSValue js_recv(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
	int fd;
	size_t size;
	uint64_t off, len;
	uint8_t *buf;
	ssize_t ret;

	if (JS_ToInt32(ctx, &fd, argv[0]))
		return JS_EXCEPTION;

	buf = JS_GetArrayBuffer(ctx, &size, argv[1]);
	if (!buf)
		return JS_EXCEPTION;

	if (JS_ToIndex(ctx, &off, argv[2]))
		return JS_EXCEPTION;
	if (JS_ToIndex(ctx, &len, argv[3]))
		return JS_EXCEPTION;

	if (off + len > size)
		return JS_ThrowRangeError(ctx, "buffer overflow");

	ret = recv(fd, buf + off, len, 0);
	if (ret < 0) {
		if (errno == EAGAIN || errno == EWOULDBLOCK)
			return JS_NewInt32(ctx, -EAGAIN);
		return JS_ThrowTypeError(ctx, "recv error: %s", strerror(errno));
	}

	return JS_NewInt64(ctx, ret);
}

static const JSCFunctionListEntry js_socket_funcs[] = {
	JS_CFUNC_DEF("socket", 2, js_socket),
	JS_CFUNC_DEF("bind", 3, js_bind),
	JS_CFUNC_DEF("listen", 2, js_listen),
	JS_CFUNC_DEF("accept", 1, js_accept),
	JS_CFUNC_DEF("connect", 3, js_connect),
	JS_CFUNC_DEF("connectFinish", 1, js_connect_finish),
	JS_CFUNC_DEF("setsockopt", 4, js_setsockopt),
	JS_CFUNC_DEF("getsockname", 1, js_getsockname),
	JS_CFUNC_DEF("getpeername", 1, js_getpeername),
	JS_CFUNC_DEF("shutdown", 2, js_shutdown),
	JS_CFUNC_DEF("getaddrinfo", 3, js_getaddrinfo),
	JS_CFUNC_DEF("send", 4, js_send),
	JS_CFUNC_DEF("recv", 4, js_recv),

	/* Constants */
	JS_PROP_INT32_DEF("AF_INET", AF_INET, 0),
	JS_PROP_INT32_DEF("AF_INET6", AF_INET6, 0),
	JS_PROP_INT32_DEF("AF_UNSPEC", AF_UNSPEC, 0),
	JS_PROP_INT32_DEF("SOCK_STREAM", SOCK_STREAM, 0),
	JS_PROP_INT32_DEF("SOCK_DGRAM", SOCK_DGRAM, 0),
	JS_PROP_INT32_DEF("SOL_SOCKET", SOL_SOCKET, 0),
	JS_PROP_INT32_DEF("IPPROTO_TCP", IPPROTO_TCP, 0),
	JS_PROP_INT32_DEF("SO_REUSEADDR", SO_REUSEADDR, 0),
	JS_PROP_INT32_DEF("SO_REUSEPORT", SO_REUSEPORT, 0),
	JS_PROP_INT32_DEF("SO_KEEPALIVE", SO_KEEPALIVE, 0),
	JS_PROP_INT32_DEF("SO_ERROR", SO_ERROR, 0),
	JS_PROP_INT32_DEF("TCP_NODELAY", TCP_NODELAY, 0),
	JS_PROP_INT32_DEF("SHUT_RD", SHUT_RD, 0),
	JS_PROP_INT32_DEF("SHUT_WR", SHUT_WR, 0),
	JS_PROP_INT32_DEF("SHUT_RDWR", SHUT_RDWR, 0),
	JS_PROP_INT32_DEF("EAGAIN", EAGAIN, 0),
	JS_PROP_INT32_DEF("EINPROGRESS", EINPROGRESS, 0),
};

static int js_socket_init(JSContext *ctx, JSModuleDef *m)
{
	return JS_SetModuleExportList(ctx, m, js_socket_funcs,
	                              countof(js_socket_funcs));
}

JSModuleDef *js_init_module_qn_socket(JSContext *ctx, const char *module_name)
{
	JSModuleDef *m;
	m = JS_NewCModule(ctx, module_name, js_socket_init);
	if (!m)
		return NULL;
	JS_AddModuleExportList(ctx, m, js_socket_funcs,
	                       countof(js_socket_funcs));
	return m;
}

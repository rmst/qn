/*
 * qn-uv-stream.h - Public interface for the stream module
 *
 * Used by qn-uv-process.c to create pipe handles and wrap them as streams.
 */

#ifndef QN_UV_STREAM_H
#define QN_UV_STREAM_H

#include "qn-uv-utils.h"

typedef struct QNStream {
	JSContext *ctx;
	int closed;
	int finalized;
	union {
		uv_handle_t handle;
		uv_stream_t stream;
		uv_tcp_t tcp;
		uv_pipe_t pipe;
		uv_tty_t tty;
	} h;
	JSValue on_read, on_connection, on_connect, on_shutdown;
	JSValue this_val;
	struct QNStream *next; /* linked list of all streams */
} QNStream;

extern JSClassID qn_stream_class_id;

/* Allocate and zero-init a QNStream. Caller must init the libuv handle. */
QNStream *qn_stream_new(JSContext *ctx);

/* Wrap an initialized QNStream into a JS object. Sets this_val to prevent GC. */
JSValue qn_stream_wrap(JSContext *ctx, QNStream *s);

/* Release prevent-GC refs on all streams. Called during runtime shutdown
 * so that the cycle collector can free remaining stream objects. */
void qn_stream_cleanup(JSRuntime *rt);

#endif /* QN_UV_STREAM_H */

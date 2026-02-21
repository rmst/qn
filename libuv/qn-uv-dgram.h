/*
 * qn-uv-dgram.h - Public interface for the UDP datagram module
 */

#ifndef QN_UV_DGRAM_H
#define QN_UV_DGRAM_H

#include "qn-uv-utils.h"

typedef struct QNDgram {
	JSContext *ctx;
	int closed;
	int finalized;
	uv_udp_t handle;
	JSValue on_message;
	JSValue this_val;
	struct QNDgram *next; /* linked list of all dgram handles */
} QNDgram;

/* Release prevent-GC refs on all dgram handles. Called during runtime
 * shutdown so that the cycle collector can free remaining objects. */
void qn_dgram_cleanup(JSRuntime *rt);

#endif /* QN_UV_DGRAM_H */

/*
 * wireguard-platform.c - Platform functions for wireguard-lwip
 */

#include "wireguard-platform.h"

#include <time.h>
#include <string.h>
#ifdef __APPLE__
#include <stdlib.h>
#else
#include <sys/random.h>
#endif

uint32_t wireguard_sys_now(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

void wireguard_random_bytes(void *bytes, size_t size) {
#ifdef __APPLE__
	arc4random_buf(bytes, size);
#else
	getrandom(bytes, size, 0);
#endif
}

void wireguard_tai64n_now(uint8_t *output) {
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	/* TAI64N: 8 bytes seconds (TAI offset 2^62) + 4 bytes nanoseconds */
	uint64_t tai64_secs = (uint64_t)ts.tv_sec + 4611686018427387914ULL;
	uint32_t nano = (uint32_t)ts.tv_nsec;
	output[0] = (tai64_secs >> 56) & 0xFF;
	output[1] = (tai64_secs >> 48) & 0xFF;
	output[2] = (tai64_secs >> 40) & 0xFF;
	output[3] = (tai64_secs >> 32) & 0xFF;
	output[4] = (tai64_secs >> 24) & 0xFF;
	output[5] = (tai64_secs >> 16) & 0xFF;
	output[6] = (tai64_secs >> 8) & 0xFF;
	output[7] = (tai64_secs) & 0xFF;
	output[8] = (nano >> 24) & 0xFF;
	output[9] = (nano >> 16) & 0xFF;
	output[10] = (nano >> 8) & 0xFF;
	output[11] = (nano) & 0xFF;
}

bool wireguard_is_under_load(void) {
	return false;
}

/* lwIP requires sys_now() in NO_SYS mode for timeouts */
#include "lwip/arch.h"
u32_t sys_now(void) {
	return (u32_t)wireguard_sys_now();
}

/*
 * lwIP architecture config for Linux userspace
 */

#ifndef LWIP_ARCH_CC_H
#define LWIP_ARCH_CC_H

#define LWIP_UNIX_LINUX

#define LWIP_TIMEVAL_PRIVATE 0
#include <sys/time.h>

#define LWIP_ERRNO_INCLUDE <errno.h>
#define LWIP_ERRNO_STDINCLUDE 1

#define LWIP_RAND() ((u32_t)random())

typedef unsigned int sys_prot_t;

#endif /* LWIP_ARCH_CC_H */

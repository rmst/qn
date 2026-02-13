/*
 * lwIP configuration for qn WireGuard module
 *
 * NO_SYS=1 (no OS), raw API only, minimal feature set for
 * userspace TCP through a WireGuard tunnel.
 */

#ifndef LWIP_LWIPOPTS_H
#define LWIP_LWIPOPTS_H

/* No OS / threading */
#define NO_SYS						1
#define SYS_LIGHTWEIGHT_PROT		0
#define LWIP_NETCONN				0
#define LWIP_SOCKET					0
#define LWIP_COMPAT_SOCKETS			0

/* IPv4 only */
#define LWIP_IPV4					1
#define LWIP_IPV6					0

/* Core protocol features */
#define LWIP_TCP					1
#define LWIP_UDP					1
#define LWIP_ICMP					1
#define LWIP_RAW					0

/* Disabled features (not needed for tunnel) */
#define LWIP_DHCP					0
#define LWIP_AUTOIP					0
#define LWIP_DNS					0
#define LWIP_ARP					0
#define LWIP_IGMP					0
#define LWIP_ACD					0
#define LWIP_NETIF_HOSTNAME			0
#define LWIP_NETIF_STATUS_CALLBACK	1
#define LWIP_NETIF_LINK_CALLBACK	1

/* Memory configuration */
#define MEM_ALIGNMENT				4
#define MEM_SIZE					(256 * 1024)
#define MEMP_NUM_PBUF				64
#define MEMP_NUM_UDP_PCB			4
#define MEMP_NUM_TCP_PCB			16
#define MEMP_NUM_TCP_PCB_LISTEN		4
#define MEMP_NUM_TCP_SEG			256
#define MEMP_NUM_SYS_TIMEOUT		16
#define PBUF_POOL_SIZE				64
#define PBUF_POOL_BUFSIZE			1600

/* TCP tuning (sized for Linux, not embedded) */
#define TCP_MSS						1360
#define TCP_WND						(32 * TCP_MSS)
#define TCP_SND_BUF					(32 * TCP_MSS)
#define TCP_SND_QUEUELEN			128
#define TCP_QUEUE_OOSEQ				1
#define LWIP_TCP_SACK_OUT			1

/* Checksum - we generate in software */
#define LWIP_CHECKSUM_CTRL_PER_NETIF 1
#define CHECKSUM_GEN_IP				1
#define CHECKSUM_GEN_TCP			1
#define CHECKSUM_GEN_UDP			1
#define CHECKSUM_GEN_ICMP			1
#define CHECKSUM_CHECK_IP			1
#define CHECKSUM_CHECK_TCP			1
#define CHECKSUM_CHECK_UDP			1
#define CHECKSUM_CHECK_ICMP			1

/* Disable debug output */
#define LWIP_DEBUG					0

/* Avoid name conflicts with system headers */
#define LWIP_DONT_PROVIDE_BYTEORDER_FUNCTIONS 1
#define LWIP_ERRNO_INCLUDE			<errno.h>
#define LWIP_ERRNO_STDINCLUDE		1

/* Timeval - use system definition */
#define LWIP_TIMEVAL_PRIVATE		0

#endif /* LWIP_LWIPOPTS_H */

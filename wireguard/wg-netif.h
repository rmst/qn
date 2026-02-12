/*
 * wg-netif.h - WireGuard netif using kernel UDP sockets
 *
 * Modified from wireguardif.c (Copyright Daniel Hope, BSD-3-Clause)
 * to use kernel UDP sockets instead of lwIP UDP for the WireGuard
 * outer transport, enabling purely userspace operation.
 */

#ifndef WG_NETIF_H
#define WG_NETIF_H

/* Include lwIP headers before system headers to avoid macro redefinition warnings */
#include "lwip/netif.h"
#include "lwip/ip_addr.h"
#include "wireguard.h"

#include <netinet/in.h>

#define WG_MTU 1420
#define WG_RX_BUF_SIZE 2048
#define WG_TCP_RX_BUF_SIZE (32 * 1024)
#define WG_MAX_TCP_CONNS 16
#define WG_MAX_TCP_LISTENERS 4
#define WG_ACCEPT_QUEUE_SIZE 8
#define WG_MAX_UDP_SOCKETS 4
#define WG_UDP_QUEUE_SIZE 16
#define WG_UDP_MAX_DGRAM 1400

enum wg_tcp_state {
	WG_TCP_NONE = 0,
	WG_TCP_CONNECTING,
	WG_TCP_CONNECTED,
	WG_TCP_CLOSING,
	WG_TCP_CLOSED,
	WG_TCP_ERROR,
};

struct wg_tcp_conn {
	struct tcp_pcb *pcb;
	enum wg_tcp_state state;
	err_t last_err;
	/* Receive ring buffer */
	uint8_t rx_buf[WG_TCP_RX_BUF_SIZE];
	size_t rx_head;
	size_t rx_tail;
	/* Pending pbuf that didn't fit in ring buffer (backpressure) */
	struct pbuf *pending_pbuf;
	size_t pending_offset;
	/* Write readiness tracking */
	size_t tx_space;
};

struct wg_udp_dgram {
	uint8_t data[WG_UDP_MAX_DGRAM];
	uint16_t len;
	uint32_t from_ip;
	uint16_t from_port;
};

struct wg_udp_socket {
	struct udp_pcb *pcb;
	struct wg_tunnel *tunnel;
	uint16_t port;
	struct wg_udp_dgram queue[WG_UDP_QUEUE_SIZE];
	int queue_head;
	int queue_tail;
	int active;
};

struct wg_tcp_listener {
	struct tcp_pcb *pcb;
	struct wg_tunnel *tunnel;
	uint16_t port;
	int accept_queue[WG_ACCEPT_QUEUE_SIZE];
	int queue_head;
	int queue_tail;
	int active;
};

struct wg_tunnel {
	struct wireguard_device device;
	struct netif netif;
	int sock_fd;
	uint8_t rx_buf[WG_RX_BUF_SIZE];
	struct wg_tcp_conn conns[WG_MAX_TCP_CONNS];
	struct wg_tcp_listener listeners[WG_MAX_TCP_LISTENERS];
	struct wg_udp_socket udp_sockets[WG_MAX_UDP_SOCKETS];
	int initialized;
};

/* Initialize a tunnel with the given private key and tunnel IP */
int wg_tunnel_init(struct wg_tunnel *tunnel, const char *private_key,
                   const char *address, const char *netmask,
                   const char *listen_address, uint16_t listen_port);

/* Add a peer to the tunnel, returns peer index or -1 on error */
int wg_tunnel_add_peer(struct wg_tunnel *tunnel, const char *public_key,
                       const char *preshared_key,
                       const char *endpoint, uint16_t endpoint_port,
                       const char *allowed_ip, const char *allowed_mask,
                       uint16_t keepalive);

/* Initiate handshake with a peer */
int wg_tunnel_connect(struct wg_tunnel *tunnel, int peer_index);

/* Update peer endpoint address and port */
int wg_tunnel_update_peer_endpoint(struct wg_tunnel *tunnel, int peer_index,
                                   const char *endpoint, uint16_t endpoint_port);

/* Remove a peer */
int wg_tunnel_remove_peer(struct wg_tunnel *tunnel, int peer_index);

/* Check if peer has an active session */
int wg_tunnel_peer_is_up(struct wg_tunnel *tunnel, int peer_index);

/* Process incoming data from the UDP socket (non-blocking) */
int wg_tunnel_process_input(struct wg_tunnel *tunnel);

/* Process lwIP and WireGuard timers */
void wg_tunnel_check_timeouts(struct wg_tunnel *tunnel);

/* Listen for incoming TCP connections on a port, returns listener index or -1 */
int wg_tunnel_tcp_listen(struct wg_tunnel *tunnel, uint16_t port);

/* Accept a pending connection on a listener, returns conn index or -1 if none */
int wg_tunnel_tcp_accept(struct wg_tunnel *tunnel, int listener_index);

/* Stop listening and free the listener */
void wg_tunnel_tcp_unlisten(struct wg_tunnel *tunnel, int listener_index);

/* Initiate a TCP connection through the tunnel */
int wg_tunnel_tcp_connect(struct wg_tunnel *tunnel, const char *host, uint16_t port);

/* Get TCP connection state */
enum wg_tcp_state wg_tunnel_tcp_state(struct wg_tunnel *tunnel, int conn_index);

/* Write data to a TCP connection, returns bytes written */
int wg_tunnel_tcp_write(struct wg_tunnel *tunnel, int conn_index,
                        const uint8_t *data, size_t len);

/* Read data from a TCP connection, returns bytes read */
int wg_tunnel_tcp_read(struct wg_tunnel *tunnel, int conn_index,
                       uint8_t *buf, size_t len);

/* Close a TCP connection */
void wg_tunnel_tcp_close(struct wg_tunnel *tunnel, int conn_index);

/* Get available bytes to read from a TCP connection */
size_t wg_tunnel_tcp_readable(struct wg_tunnel *tunnel, int conn_index);

/* Bind a UDP socket on the tunnel, returns socket index or -1 */
int wg_tunnel_udp_bind(struct wg_tunnel *tunnel, uint16_t port);

/* Send a UDP datagram through the tunnel */
int wg_tunnel_udp_sendto(struct wg_tunnel *tunnel, int sock_index,
                         const uint8_t *data, size_t len,
                         const char *host, uint16_t port);

/* Receive a UDP datagram (non-blocking), returns bytes read or 0 if none.
 * from_ip (host-order u32) and from_port are filled if non-NULL. */
int wg_tunnel_udp_recv(struct wg_tunnel *tunnel, int sock_index,
                       uint8_t *buf, size_t len,
                       uint32_t *from_ip, uint16_t *from_port);

/* Number of queued datagrams ready to read */
int wg_tunnel_udp_pending(struct wg_tunnel *tunnel, int sock_index);

/* Close a UDP socket */
void wg_tunnel_udp_close(struct wg_tunnel *tunnel, int sock_index);

/* Get the UDP socket fd for event loop integration */
int wg_tunnel_get_fd(struct wg_tunnel *tunnel);

/* Destroy the tunnel and free resources */
void wg_tunnel_destroy(struct wg_tunnel *tunnel);

#endif /* WG_NETIF_H */

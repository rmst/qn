/*
 * wg-netif.c - WireGuard netif using kernel UDP sockets
 *
 * Based on wireguardif.c by Daniel Hope (BSD-3-Clause)
 * Modified to use kernel UDP sockets for transport instead of lwIP UDP,
 * enabling purely userspace operation on Linux.
 *
 * Architecture:
 *   - Kernel UDP socket handles WireGuard encrypted transport
 *   - lwIP processes decrypted IP packets (TCP/IP stack)
 *   - Raw TCP API provides tunnel TCP connections to JS
 */

/* Include lwIP headers before system headers to avoid htons/ntohs redefinition */
#include "lwip/init.h"
#include "lwip/netif.h"
#include "lwip/ip.h"
#include "lwip/tcp.h"
#include "lwip/udp.h"
#include "lwip/pbuf.h"
#include "lwip/mem.h"
#include "lwip/timeouts.h"

#include "wg-netif.h"

#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <arpa/inet.h>
#include <sys/socket.h>

#include "wireguard.h"
#include "crypto.h"

#define WG_TIMER_MSECS 400

/* ---- Forward declarations ---- */

static err_t wg_netif_output(struct netif *netif, struct pbuf *q, const ip4_addr_t *ipaddr);
static void wg_timer_callback(void *arg);

/* ---- Helpers ---- */

static int set_nonblocking(int fd) {
	int flags = fcntl(fd, F_GETFL);
	if (flags < 0) return -1;
	return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static struct wireguard_peer *peer_lookup_by_allowed_ip(struct wireguard_device *device, const ip4_addr_t *ipaddr) {
	struct wireguard_peer *tmp;
	int x, y;
	for (x = 0; x < WIREGUARD_MAX_PEERS; x++) {
		tmp = &device->peers[x];
		if (tmp->valid) {
			for (y = 0; y < WIREGUARD_MAX_SRC_IPS; y++) {
				if (tmp->allowed_source_ips[y].valid &&
				    ip_addr_netcmp(ipaddr, &tmp->allowed_source_ips[y].ip, &tmp->allowed_source_ips[y].mask)) {
					return tmp;
				}
			}
		}
	}
	return NULL;
}

/* Send raw data to a peer's endpoint via kernel UDP socket */
static int wg_send_to_peer(struct wg_tunnel *tunnel, struct wireguard_peer *peer,
                           const uint8_t *data, size_t len) {
	struct sockaddr_in addr;
	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons(peer->port);
	addr.sin_addr.s_addr = ip4_addr_get_u32(ip_2_ip4(&peer->ip));

	ssize_t n = sendto(tunnel->sock_fd, data, len, 0,
	                   (struct sockaddr *)&addr, sizeof(addr));
	return (n < 0) ? -errno : (int)n;
}

/* Send a pbuf's data to a peer via kernel socket */
static err_t wg_peer_output(struct wg_tunnel *tunnel, struct pbuf *p, struct wireguard_peer *peer) {
	/* Linearize pbuf if chained */
	uint8_t buf[2048];
	if (p->tot_len > sizeof(buf)) return ERR_MEM;
	pbuf_copy_partial(p, buf, p->tot_len, 0);

	int n = wg_send_to_peer(tunnel, peer, buf, p->tot_len);
	return (n > 0) ? ERR_OK : ERR_IF;
}

/* Send encrypted transport data for an IP packet to a peer */
static err_t wg_output_to_peer(struct wg_tunnel *tunnel, struct pbuf *q, struct wireguard_peer *peer) {
	struct wireguard_keypair *keypair = &peer->curr_keypair;
	struct message_transport_data *hdr;
	struct pbuf *pbuf;
	err_t result;
	size_t unpadded_len, padded_len;
	size_t header_len = 16;
	uint8_t *dst;
	uint32_t now;

	if (keypair->valid && (!keypair->initiator) && (keypair->last_rx == 0))
		keypair = &peer->prev_keypair;

	if (!keypair->valid || (!keypair->initiator && keypair->last_rx == 0))
		return ERR_CONN;

	if (wireguard_expired(keypair->keypair_millis, REJECT_AFTER_TIME) ||
	    keypair->sending_counter >= REJECT_AFTER_MESSAGES) {
		keypair_destroy(keypair);
		return ERR_CONN;
	}

	unpadded_len = q ? q->tot_len : 0;
	padded_len = (unpadded_len + 15) & 0xFFFFFFF0;

	pbuf = pbuf_alloc(PBUF_TRANSPORT, header_len + padded_len + WIREGUARD_AUTHTAG_LEN, PBUF_RAM);
	if (!pbuf) return ERR_MEM;

	memset(pbuf->payload, 0, pbuf->tot_len);
	hdr = (struct message_transport_data *)pbuf->payload;
	hdr->type = MESSAGE_TRANSPORT_DATA;
	hdr->receiver = keypair->remote_index;
	U64TO8_LITTLE(hdr->counter, keypair->sending_counter);

	dst = &hdr->enc_packet[0];
	if (padded_len > 0 && q)
		pbuf_copy_partial(q, dst, unpadded_len, 0);

	wireguard_encrypt_packet(dst, dst, padded_len, keypair);

	result = wg_peer_output(tunnel, pbuf, peer);

	if (result == ERR_OK) {
		now = wireguard_sys_now();
		peer->last_tx = now;
		keypair->last_tx = now;
	}

	pbuf_free(pbuf);

	if (keypair->sending_counter >= REKEY_AFTER_MESSAGES)
		peer->send_handshake = true;
	else if (keypair->initiator && wireguard_expired(keypair->keypair_millis, REKEY_AFTER_TIME))
		peer->send_handshake = true;

	return result;
}

/* ---- Netif output callback ---- */

static err_t wg_netif_output(struct netif *netif, struct pbuf *q, const ip4_addr_t *ipaddr) {
	struct wireguard_device *device = (struct wireguard_device *)netif->state;
	struct wg_tunnel *tunnel = (struct wg_tunnel *)device;  /* device is first member */
	struct wireguard_peer *peer = peer_lookup_by_allowed_ip(device, ipaddr);
	if (peer)
		return wg_output_to_peer(tunnel, q, peer);
	return ERR_RTE;
}

/* ---- Handshake ---- */

static void wg_send_keepalive(struct wg_tunnel *tunnel, struct wireguard_peer *peer) {
	wg_output_to_peer(tunnel, NULL, peer);
}

static err_t wg_start_handshake(struct wg_tunnel *tunnel, struct wireguard_peer *peer) {
	struct message_handshake_initiation msg;
	if (!wireguard_create_handshake_initiation(&tunnel->device, peer, &msg))
		return ERR_ARG;

	int n = wg_send_to_peer(tunnel, peer, (uint8_t *)&msg, sizeof(msg));
	if (n > 0) {
		peer->send_handshake = false;
		peer->last_initiation_tx = wireguard_sys_now();
		memcpy(peer->handshake_mac1, msg.mac1, WIREGUARD_COOKIE_LEN);
		peer->handshake_mac1_valid = true;
		return ERR_OK;
	}
	return ERR_IF;
}

static void wg_send_handshake_response(struct wg_tunnel *tunnel, struct wireguard_peer *peer) {
	struct message_handshake_response packet;
	if (wireguard_create_handshake_response(&tunnel->device, peer, &packet)) {
		wireguard_start_session(peer, false);
		wg_send_to_peer(tunnel, peer, (uint8_t *)&packet, sizeof(packet));
	}
}

static void wg_process_response(struct wg_tunnel *tunnel, struct wireguard_peer *peer,
                                struct message_handshake_response *response,
                                const ip_addr_t *addr, u16_t port) {
	if (wireguard_process_handshake_response(&tunnel->device, peer, response)) {
		peer->ip = *addr;
		peer->port = port;
		wireguard_start_session(peer, true);
		wg_send_keepalive(tunnel, peer);
		netif_set_link_up(&tunnel->netif);
	}
}

static size_t get_source_addr_port(const ip_addr_t *addr, u16_t port, uint8_t *buf, size_t buflen) {
	size_t result = 0;
	if (IP_IS_V4(addr) && buflen >= 4) {
		U32TO8_BIG(buf + result, PP_NTOHL(ip4_addr_get_u32(ip_2_ip4(addr))));
		result += 4;
	}
	if (buflen >= result + 2) {
		U16TO8_BIG(buf + result, port);
		result += 2;
	}
	return result;
}

static void wg_send_cookie_reply(struct wg_tunnel *tunnel, const uint8_t *mac1,
                                 uint32_t index, const ip_addr_t *addr, u16_t port) {
	struct message_cookie_reply packet;
	uint8_t source_buf[18];
	size_t source_len = get_source_addr_port(addr, port, source_buf, sizeof(source_buf));
	wireguard_create_cookie_reply(&tunnel->device, &packet, mac1, index, source_buf, source_len);

	struct wireguard_peer dummy;
	memset(&dummy, 0, sizeof(dummy));
	dummy.ip = *addr;
	dummy.port = port;
	wg_send_to_peer(tunnel, &dummy, (uint8_t *)&packet, sizeof(packet));
}

static bool wg_check_initiation(struct wg_tunnel *tunnel, struct message_handshake_initiation *msg,
                                const ip_addr_t *addr, u16_t port) {
	uint8_t *data = (uint8_t *)msg;
	if (wireguard_check_mac1(&tunnel->device, data,
	    sizeof(struct message_handshake_initiation) - (2 * WIREGUARD_COOKIE_LEN), msg->mac1)) {
		if (!wireguard_is_under_load())
			return true;
		uint8_t source_buf[18];
		size_t source_len = get_source_addr_port(addr, port, source_buf, sizeof(source_buf));
		if (wireguard_check_mac2(&tunnel->device, data,
		    sizeof(struct message_handshake_initiation) - WIREGUARD_COOKIE_LEN,
		    source_buf, source_len, msg->mac2))
			return true;
		wg_send_cookie_reply(tunnel, msg->mac1, msg->sender, addr, port);
	}
	return false;
}

static bool wg_check_response(struct wg_tunnel *tunnel, struct message_handshake_response *msg,
                              const ip_addr_t *addr, u16_t port) {
	uint8_t *data = (uint8_t *)msg;
	if (wireguard_check_mac1(&tunnel->device, data,
	    sizeof(struct message_handshake_response) - (2 * WIREGUARD_COOKIE_LEN), msg->mac1)) {
		if (!wireguard_is_under_load())
			return true;
		uint8_t source_buf[18];
		size_t source_len = get_source_addr_port(addr, port, source_buf, sizeof(source_buf));
		if (wireguard_check_mac2(&tunnel->device, data,
		    sizeof(struct message_handshake_response) - WIREGUARD_COOKIE_LEN,
		    source_buf, source_len, msg->mac2))
			return true;
		wg_send_cookie_reply(tunnel, msg->mac1, msg->sender, addr, port);
	}
	return false;
}

/* ---- Process transport data ---- */

static void wg_process_data(struct wg_tunnel *tunnel, struct wireguard_peer *peer,
                            struct message_transport_data *data_hdr, size_t data_len,
                            const ip_addr_t *addr, u16_t port) {
	struct wireguard_keypair *keypair;
	uint64_t nonce;
	uint8_t *src;
	size_t src_len;
	struct pbuf *pbuf;
	struct ip_hdr *iphdr;
	ip_addr_t dest;
	bool dest_ok = false;
	uint32_t now;
	uint16_t header_len = 0xFFFF;
	int x;

	keypair = get_peer_keypair_for_idx(peer, data_hdr->receiver);
	if (!keypair) return;

	if (!keypair->receiving_valid ||
	    wireguard_expired(keypair->keypair_millis, REJECT_AFTER_TIME) ||
	    keypair->sending_counter >= REJECT_AFTER_MESSAGES) {
		keypair_destroy(keypair);
		return;
	}

	nonce = U8TO64_LITTLE(data_hdr->counter);
	src = &data_hdr->enc_packet[0];
	src_len = data_len;

	pbuf = pbuf_alloc(PBUF_RAW, src_len - WIREGUARD_AUTHTAG_LEN, PBUF_RAM);
	if (!pbuf) return;

	memset(pbuf->payload, 0, pbuf->tot_len);
	if (!wireguard_decrypt_packet(pbuf->payload, src, src_len, nonce, keypair)) {
		pbuf_free(pbuf);
		return;
	}

	peer->ip = *addr;
	peer->port = port;

	now = wireguard_sys_now();
	keypair->last_rx = now;
	peer->last_rx = now;

	keypair_update(peer, keypair);

	if (keypair->initiator &&
	    wireguard_expired(keypair->keypair_millis, REJECT_AFTER_TIME - peer->keepalive_interval - REKEY_TIMEOUT))
		peer->send_handshake = true;

	netif_set_link_up(&tunnel->netif);

	if (pbuf->tot_len > 0) {
		iphdr = (struct ip_hdr *)pbuf->payload;
		if (wireguard_check_replay(keypair, nonce)) {
			if (IPH_V(iphdr) == 4) {
				ip_addr_copy_from_ip4(dest, iphdr->dest);
				for (x = 0; x < WIREGUARD_MAX_SRC_IPS; x++) {
					if (peer->allowed_source_ips[x].valid &&
					    ip_addr_netcmp(&dest, &peer->allowed_source_ips[x].ip,
					                   &peer->allowed_source_ips[x].mask)) {
						dest_ok = true;
						header_len = PP_NTOHS(IPH_LEN(iphdr));
						break;
					}
				}
			}
			if (dest_ok && header_len <= pbuf->tot_len) {
				/* Trim pbuf to actual IP packet length */
				if (header_len < pbuf->tot_len)
					pbuf_realloc(pbuf, header_len);
				ip_input(pbuf, &tunnel->netif);
				return;  /* pbuf owned by IP layer now */
			}
		}
	}
	/* Keep-alive or invalid - free pbuf */
	pbuf_free(pbuf);
}

/* ---- Process a received WireGuard message ---- */

static void wg_process_message(struct wg_tunnel *tunnel, uint8_t *data, size_t len,
                               const ip_addr_t *addr, u16_t port) {
	struct wireguard_peer *peer;
	uint8_t type = wireguard_get_message_type(data, len);

	switch (type) {
	case MESSAGE_HANDSHAKE_INITIATION: {
		if (len < sizeof(struct message_handshake_initiation)) break;
		struct message_handshake_initiation *msg = (struct message_handshake_initiation *)data;
		if (wg_check_initiation(tunnel, msg, addr, port)) {
			peer = wireguard_process_initiation_message(&tunnel->device, msg);
			if (peer) {
				peer->ip = *addr;
				peer->port = port;
				wg_send_handshake_response(tunnel, peer);
			}
		}
		break;
	}
	case MESSAGE_HANDSHAKE_RESPONSE: {
		if (len < sizeof(struct message_handshake_response)) break;
		struct message_handshake_response *msg = (struct message_handshake_response *)data;
		if (wg_check_response(tunnel, msg, addr, port)) {
			peer = peer_lookup_by_handshake(&tunnel->device, msg->receiver);
			if (peer)
				wg_process_response(tunnel, peer, msg, addr, port);
		}
		break;
	}
	case MESSAGE_COOKIE_REPLY: {
		if (len < sizeof(struct message_cookie_reply)) break;
		struct message_cookie_reply *msg = (struct message_cookie_reply *)data;
		peer = peer_lookup_by_handshake(&tunnel->device, msg->receiver);
		if (peer && wireguard_process_cookie_message(&tunnel->device, peer, msg)) {
			peer->ip = *addr;
			peer->port = port;
		}
		break;
	}
	case MESSAGE_TRANSPORT_DATA: {
		/* Minimum: 16-byte header + WIREGUARD_AUTHTAG_LEN (16) for auth tag */
		if (len < 32) break;
		struct message_transport_data *msg = (struct message_transport_data *)data;
		peer = peer_lookup_by_receiver(&tunnel->device, msg->receiver);
		if (peer)
			wg_process_data(tunnel, peer, msg, len - 16, addr, port);
		break;
	}
	}
}

/* ---- Timer ---- */

static bool wg_can_send_initiation(struct wireguard_peer *peer) {
	return (peer->last_initiation_tx == 0) || wireguard_expired(peer->last_initiation_tx, REKEY_TIMEOUT);
}

static bool wg_should_send_initiation(struct wireguard_peer *peer) {
	if (!wg_can_send_initiation(peer)) return false;
	if (peer->send_handshake) return true;
	if (peer->curr_keypair.valid && !peer->curr_keypair.initiator &&
	    wireguard_expired(peer->curr_keypair.keypair_millis, REJECT_AFTER_TIME - peer->keepalive_interval))
		return true;
	if (!peer->curr_keypair.valid && peer->active) return true;
	return false;
}

static void wg_timer_callback(void *arg) {
	struct wg_tunnel *tunnel = (struct wg_tunnel *)arg;
	struct wireguard_peer *peer;
	bool link_up = false;
	int x;

	sys_timeout(WG_TIMER_MSECS, wg_timer_callback, tunnel);

	for (x = 0; x < WIREGUARD_MAX_PEERS; x++) {
		peer = &tunnel->device.peers[x];
		if (!peer->valid) continue;

		/* Reset if no activity for too long */
		if (peer->curr_keypair.valid &&
		    wireguard_expired(peer->curr_keypair.keypair_millis, REJECT_AFTER_TIME * 3)) {
			keypair_destroy(&peer->next_keypair);
			keypair_destroy(&peer->curr_keypair);
			keypair_destroy(&peer->prev_keypair);
			peer->ip = peer->connect_ip;
			peer->port = peer->connect_port;
		}

		/* Destroy expired keypair */
		if (peer->curr_keypair.valid &&
		    (wireguard_expired(peer->curr_keypair.keypair_millis, REJECT_AFTER_TIME) ||
		     peer->curr_keypair.sending_counter >= REJECT_AFTER_MESSAGES))
			keypair_destroy(&peer->curr_keypair);

		/* Keepalive */
		if (peer->keepalive_interval > 0 &&
		    (peer->curr_keypair.valid || peer->prev_keypair.valid) &&
		    wireguard_expired(peer->last_tx, peer->keepalive_interval))
			wg_send_keepalive(tunnel, peer);

		/* Handshake initiation */
		if (wg_should_send_initiation(peer))
			wg_start_handshake(tunnel, peer);

		if (peer->curr_keypair.valid || peer->prev_keypair.valid)
			link_up = true;
	}

	if (!link_up)
		netif_set_link_down(&tunnel->netif);
}

/* ---- TCP raw API callbacks ---- */

static err_t wg_tcp_connected_cb(void *arg, struct tcp_pcb *tpcb, err_t err) {
	struct wg_tcp_conn *conn = (struct wg_tcp_conn *)arg;
	if (err == ERR_OK) {
		conn->state = WG_TCP_CONNECTED;
		conn->tx_space = tcp_sndbuf(tpcb);
	} else {
		conn->state = WG_TCP_ERROR;
		conn->last_err = err;
	}
	return ERR_OK;
}

/*
 * Drain pending pbuf data into the ring buffer.
 * Acknowledges consumed bytes via tcp_recved to open the TCP window.
 */
static void flush_pending(struct wg_tcp_conn *conn) {
	while (conn->pending_pbuf) {
		size_t available = (WG_TCP_RX_BUF_SIZE - 1 + conn->rx_tail - conn->rx_head) % WG_TCP_RX_BUF_SIZE;
		if (available == 0) break;

		struct pbuf *p = conn->pending_pbuf;
		size_t remaining = p->tot_len - conn->pending_offset;
		size_t to_copy = (remaining < available) ? remaining : available;

		/* Copy from pbuf into ring buffer, handling wrap-around */
		size_t pos = conn->rx_head % WG_TCP_RX_BUF_SIZE;
		size_t first = WG_TCP_RX_BUF_SIZE - pos;
		if (first >= to_copy) {
			pbuf_copy_partial(p, conn->rx_buf + pos, to_copy, conn->pending_offset);
		} else {
			pbuf_copy_partial(p, conn->rx_buf + pos, first, conn->pending_offset);
			pbuf_copy_partial(p, conn->rx_buf, to_copy - first, conn->pending_offset + first);
		}

		conn->rx_head = (conn->rx_head + to_copy) % WG_TCP_RX_BUF_SIZE;
		conn->pending_offset += to_copy;

		if (conn->pcb)
			tcp_recved(conn->pcb, to_copy);

		if (conn->pending_offset >= p->tot_len) {
			pbuf_free(p);
			conn->pending_pbuf = NULL;
			conn->pending_offset = 0;
		}
	}
}

static err_t wg_tcp_recv_cb(void *arg, struct tcp_pcb *tpcb, struct pbuf *p, err_t err) {
	struct wg_tcp_conn *conn = (struct wg_tcp_conn *)arg;

	if (!p || err != ERR_OK) {
		/* Connection closed by remote */
		conn->state = WG_TCP_CLOSED;
		if (p) pbuf_free(p);
		return ERR_OK;
	}

	/* Append to pending chain */
	if (conn->pending_pbuf) {
		pbuf_cat(conn->pending_pbuf, p);
	} else {
		conn->pending_pbuf = p;
		conn->pending_offset = 0;
	}

	/* Drain as much as possible into ring buffer */
	flush_pending(conn);
	return ERR_OK;
}

static err_t wg_tcp_sent_cb(void *arg, struct tcp_pcb *tpcb, u16_t len) {
	struct wg_tcp_conn *conn = (struct wg_tcp_conn *)arg;
	conn->tx_space = tcp_sndbuf(tpcb);
	return ERR_OK;
}

static void wg_tcp_err_cb(void *arg, err_t err) {
	struct wg_tcp_conn *conn = (struct wg_tcp_conn *)arg;
	conn->state = WG_TCP_ERROR;
	conn->last_err = err;
	conn->pcb = NULL;  /* PCB is already freed by lwIP on error */
}

/* ---- Netif init callback ---- */

static err_t wg_netif_init_cb(struct netif *netif) {
	netif->name[0] = 'w';
	netif->name[1] = 'g';
	netif->output = wg_netif_output;
	netif->linkoutput = NULL;
	netif->hwaddr_len = 0;
	netif->mtu = WG_MTU;
	netif->flags = 0;
#if LWIP_CHECKSUM_CTRL_PER_NETIF
	NETIF_SET_CHECKSUM_CTRL(netif, NETIF_CHECKSUM_ENABLE_ALL);
#endif
	return ERR_OK;
}

/* ---- Public API ---- */

int wg_tunnel_init(struct wg_tunnel *tunnel, const char *private_key,
                   const char *address, const char *netmask,
                   const char *listen_address, uint16_t listen_port) {
	uint8_t priv_key[WIREGUARD_PRIVATE_KEY_LEN];
	size_t priv_key_len = sizeof(priv_key);
	ip4_addr_t addr, mask, gw;

	memset(tunnel, 0, sizeof(struct wg_tunnel));

	/* Initialize lwIP (safe to call multiple times) */
	lwip_init();

	/* Initialize WireGuard */
	wireguard_init();

	/* Decode private key */
	if (!wireguard_base64_decode(private_key, priv_key, &priv_key_len) ||
	    priv_key_len != WIREGUARD_PRIVATE_KEY_LEN) {
		crypto_zero(priv_key, sizeof(priv_key));
		return -1;
	}

	/* Initialize device */
	if (!wireguard_device_init(&tunnel->device, priv_key)) {
		crypto_zero(priv_key, sizeof(priv_key));
		return -1;
	}
	crypto_zero(priv_key, sizeof(priv_key));

	/* Parse tunnel IP */
	if (!ip4addr_aton(address, &addr)) return -1;
	if (!ip4addr_aton(netmask, &mask)) return -1;
	ip4_addr_set_zero(&gw);

	/* Create kernel UDP socket */
	tunnel->sock_fd = socket(AF_INET, SOCK_DGRAM, 0);
	if (tunnel->sock_fd < 0) return -1;

	if (set_nonblocking(tunnel->sock_fd) < 0) {
		close(tunnel->sock_fd);
		return -1;
	}

	/* Bind to listen address/port */
	struct sockaddr_in bind_addr;
	memset(&bind_addr, 0, sizeof(bind_addr));
	bind_addr.sin_family = AF_INET;
	bind_addr.sin_port = htons(listen_port);
	if (listen_address && listen_address[0]) {
		if (!inet_pton(AF_INET, listen_address, &bind_addr.sin_addr)) {
			close(tunnel->sock_fd);
			return -1;
		}
	} else {
		bind_addr.sin_addr.s_addr = INADDR_ANY;
	}

	if (bind(tunnel->sock_fd, (struct sockaddr *)&bind_addr, sizeof(bind_addr)) < 0) {
		close(tunnel->sock_fd);
		return -1;
	}

	/* Add netif to lwIP */
	tunnel->device.netif = &tunnel->netif;
	tunnel->device.udp_pcb = NULL;  /* We don't use lwIP UDP for transport */

	if (!netif_add(&tunnel->netif, &addr, &mask, &gw,
	               &tunnel->device, wg_netif_init_cb, ip_input)) {
		close(tunnel->sock_fd);
		return -1;
	}

	netif_set_up(&tunnel->netif);

	/* Start WireGuard timer */
	sys_timeout(WG_TIMER_MSECS, wg_timer_callback, tunnel);

	tunnel->initialized = 1;
	return 0;
}

int wg_tunnel_add_peer(struct wg_tunnel *tunnel, const char *public_key,
                       const char *preshared_key,
                       const char *endpoint, uint16_t endpoint_port,
                       const char *allowed_ip, const char *allowed_mask,
                       uint16_t keepalive) {
	uint8_t pub_key[WIREGUARD_PUBLIC_KEY_LEN];
	size_t pub_key_len = sizeof(pub_key);
	uint8_t psk[WIREGUARD_SESSION_KEY_LEN];
	const uint8_t *psk_ptr = NULL;

	if (!wireguard_base64_decode(public_key, pub_key, &pub_key_len) ||
	    pub_key_len != WIREGUARD_PUBLIC_KEY_LEN) {
		crypto_zero(pub_key, sizeof(pub_key));
		return -1;
	}

	if (preshared_key) {
		size_t psk_len = sizeof(psk);
		if (!wireguard_base64_decode(preshared_key, psk, &psk_len) ||
		    psk_len != WIREGUARD_SESSION_KEY_LEN) {
			crypto_zero(pub_key, sizeof(pub_key));
			crypto_zero(psk, sizeof(psk));
			return -1;
		}
		psk_ptr = psk;
	}

	struct wireguard_peer *peer = peer_alloc(&tunnel->device);
	if (!peer) {
		crypto_zero(pub_key, sizeof(pub_key));
		if (psk_ptr) crypto_zero(psk, sizeof(psk));
		return -1;
	}

	if (!wireguard_peer_init(&tunnel->device, peer, pub_key, psk_ptr)) {
		crypto_zero(pub_key, sizeof(pub_key));
		if (psk_ptr) crypto_zero(psk, sizeof(psk));
		return -1;
	}
	crypto_zero(pub_key, sizeof(pub_key));
	if (psk_ptr) crypto_zero(psk, sizeof(psk));

	/* Set endpoint */
	if (endpoint) {
		ip4_addr_t ep_addr;
		if (ip4addr_aton(endpoint, &ep_addr)) {
			ip_addr_copy_from_ip4(peer->connect_ip, ep_addr);
			peer->connect_port = endpoint_port;
			peer->ip = peer->connect_ip;
			peer->port = peer->connect_port;
		}
	}

	/* Set keepalive */
	peer->keepalive_interval = keepalive;

	/* Add allowed IP */
	if (allowed_ip && allowed_mask) {
		ip4_addr_t aip, amask;
		if (ip4addr_aton(allowed_ip, &aip) && ip4addr_aton(allowed_mask, &amask)) {
			ip_addr_t lip, lmask;
			ip_addr_copy_from_ip4(lip, aip);
			ip_addr_copy_from_ip4(lmask, amask);
			/* Add to peer's allowed IPs */
			int i;
			for (i = 0; i < WIREGUARD_MAX_SRC_IPS; i++) {
				if (!peer->allowed_source_ips[i].valid) {
					peer->allowed_source_ips[i].valid = true;
					peer->allowed_source_ips[i].ip = lip;
					peer->allowed_source_ips[i].mask = lmask;
					break;
				}
			}
		}
	}

	return wireguard_peer_index(&tunnel->device, peer);
}

int wg_tunnel_connect(struct wg_tunnel *tunnel, int peer_index) {
	struct wireguard_peer *peer = peer_lookup_by_peer_index(&tunnel->device, peer_index);
	if (!peer) return -1;

	if (ip_addr_isany(&peer->connect_ip) || peer->connect_port == 0)
		return -1;

	peer->active = true;
	peer->ip = peer->connect_ip;
	peer->port = peer->connect_port;
	return 0;
}

int wg_tunnel_update_peer_endpoint(struct wg_tunnel *tunnel, int peer_index,
                                   const char *endpoint, uint16_t endpoint_port) {
	struct wireguard_peer *peer = peer_lookup_by_peer_index(&tunnel->device, peer_index);
	if (!peer) return -1;

	ip4_addr_t ep_addr;
	if (!ip4addr_aton(endpoint, &ep_addr)) return -1;

	ip_addr_copy_from_ip4(peer->connect_ip, ep_addr);
	peer->connect_port = endpoint_port;
	return 0;
}

int wg_tunnel_remove_peer(struct wg_tunnel *tunnel, int peer_index) {
	struct wireguard_peer *peer = peer_lookup_by_peer_index(&tunnel->device, peer_index);
	if (!peer) return -1;
	crypto_zero(peer, sizeof(struct wireguard_peer));
	peer->valid = false;
	return 0;
}

int wg_tunnel_peer_is_up(struct wg_tunnel *tunnel, int peer_index) {
	struct wireguard_peer *peer = peer_lookup_by_peer_index(&tunnel->device, peer_index);
	if (!peer) return 0;
	return (peer->curr_keypair.valid || peer->prev_keypair.valid) ? 1 : 0;
}

int wg_tunnel_process_input(struct wg_tunnel *tunnel) {
	struct sockaddr_in from;
	socklen_t from_len = sizeof(from);
	int count = 0;

	for (;;) {
		ssize_t n = recvfrom(tunnel->sock_fd, tunnel->rx_buf, WG_RX_BUF_SIZE, 0,
		                     (struct sockaddr *)&from, &from_len);
		if (n < 0) {
			if (errno == EAGAIN || errno == EWOULDBLOCK)
				break;
			return -errno;
		}
		if (n == 0) break;

		/* Convert to lwIP address */
		ip_addr_t addr;
		ip4_addr_t ip4;
		ip4.addr = from.sin_addr.s_addr;
		ip_addr_copy_from_ip4(addr, ip4);
		u16_t port = ntohs(from.sin_port);

		wg_process_message(tunnel, tunnel->rx_buf, n, &addr, port);
		count++;
	}

	return count;
}

void wg_tunnel_check_timeouts(struct wg_tunnel *tunnel) {
	sys_check_timeouts();
}

/* ---- TCP Listen/Accept ---- */

/* Find a free connection slot and initialize it for an accepted connection */
static int wg_accept_conn_init(struct wg_tunnel *tunnel, struct tcp_pcb *newpcb) {
	int i;
	for (i = 0; i < WG_MAX_TCP_CONNS; i++) {
		if (tunnel->conns[i].state == WG_TCP_NONE)
			break;
	}
	if (i >= WG_MAX_TCP_CONNS) return -1;

	struct wg_tcp_conn *conn = &tunnel->conns[i];
	memset(conn, 0, sizeof(struct wg_tcp_conn));
	conn->pcb = newpcb;
	conn->state = WG_TCP_CONNECTED;
	conn->tx_space = tcp_sndbuf(newpcb);

	tcp_arg(newpcb, conn);
	tcp_recv(newpcb, wg_tcp_recv_cb);
	tcp_sent(newpcb, wg_tcp_sent_cb);
	tcp_err(newpcb, wg_tcp_err_cb);

	return i;
}

static err_t wg_tcp_accept_cb(void *arg, struct tcp_pcb *newpcb, err_t err) {
	struct wg_tcp_listener *listener = (struct wg_tcp_listener *)arg;
	if (err != ERR_OK || !newpcb) return ERR_VAL;

	struct wg_tunnel *tunnel = listener->tunnel;

	/* Check if accept queue is full */
	int next_head = (listener->queue_head + 1) % WG_ACCEPT_QUEUE_SIZE;
	if (next_head == listener->queue_tail) {
		/* Queue full, reject */
		return ERR_MEM;
	}

	int conn_idx = wg_accept_conn_init(tunnel, newpcb);
	if (conn_idx < 0) return ERR_MEM;

	listener->accept_queue[listener->queue_head] = conn_idx;
	listener->queue_head = next_head;

	return ERR_OK;
}

int wg_tunnel_tcp_listen(struct wg_tunnel *tunnel, uint16_t port) {
	/* Find free listener slot */
	int i;
	for (i = 0; i < WG_MAX_TCP_LISTENERS; i++) {
		if (!tunnel->listeners[i].active)
			break;
	}
	if (i >= WG_MAX_TCP_LISTENERS) return -1;

	struct tcp_pcb *pcb = tcp_new();
	if (!pcb) return -1;

	err_t err = tcp_bind(pcb, IP_ADDR_ANY, port);
	if (err != ERR_OK) {
		tcp_close(pcb);
		return -1;
	}

	struct tcp_pcb *lpcb = tcp_listen(pcb);
	if (!lpcb) {
		tcp_close(pcb);
		return -1;
	}

	tcp_bind_netif(lpcb, &tunnel->netif);

	struct wg_tcp_listener *listener = &tunnel->listeners[i];
	memset(listener, 0, sizeof(struct wg_tcp_listener));
	listener->pcb = lpcb;
	listener->tunnel = tunnel;
	listener->port = port;
	listener->active = 1;

	tcp_arg(lpcb, listener);
	tcp_accept(lpcb, wg_tcp_accept_cb);

	return i;
}

int wg_tunnel_tcp_accept(struct wg_tunnel *tunnel, int listener_index) {
	if (listener_index < 0 || listener_index >= WG_MAX_TCP_LISTENERS)
		return -1;

	struct wg_tcp_listener *listener = &tunnel->listeners[listener_index];
	if (!listener->active) return -1;

	/* Check if queue is empty */
	if (listener->queue_head == listener->queue_tail)
		return -1;

	int conn_idx = listener->accept_queue[listener->queue_tail];
	listener->queue_tail = (listener->queue_tail + 1) % WG_ACCEPT_QUEUE_SIZE;
	return conn_idx;
}

void wg_tunnel_tcp_unlisten(struct wg_tunnel *tunnel, int listener_index) {
	if (listener_index < 0 || listener_index >= WG_MAX_TCP_LISTENERS)
		return;

	struct wg_tcp_listener *listener = &tunnel->listeners[listener_index];
	if (!listener->active) return;

	if (listener->pcb) {
		tcp_arg(listener->pcb, NULL);
		tcp_accept(listener->pcb, NULL);
		tcp_close(listener->pcb);
		listener->pcb = NULL;
	}
	listener->active = 0;
}

int wg_tunnel_tcp_connect(struct wg_tunnel *tunnel, const char *host, uint16_t port) {
	ip4_addr_t addr;
	if (!ip4addr_aton(host, &addr))
		return -1;

	/* Find free connection slot */
	int i;
	for (i = 0; i < WG_MAX_TCP_CONNS; i++) {
		if (tunnel->conns[i].state == WG_TCP_NONE)
			break;
	}
	if (i >= WG_MAX_TCP_CONNS) return -1;

	struct wg_tcp_conn *conn = &tunnel->conns[i];
	memset(conn, 0, sizeof(struct wg_tcp_conn));

	struct tcp_pcb *pcb = tcp_new();
	if (!pcb) return -1;

	tcp_bind_netif(pcb, &tunnel->netif);

	conn->pcb = pcb;
	conn->state = WG_TCP_CONNECTING;

	tcp_arg(pcb, conn);
	tcp_recv(pcb, wg_tcp_recv_cb);
	tcp_sent(pcb, wg_tcp_sent_cb);
	tcp_err(pcb, wg_tcp_err_cb);

	ip_addr_t lip;
	ip_addr_copy_from_ip4(lip, addr);

	err_t err = tcp_connect(pcb, &lip, port, wg_tcp_connected_cb);
	if (err != ERR_OK) {
		tcp_abort(pcb);
		conn->pcb = NULL;
		conn->state = WG_TCP_NONE;
		return -1;
	}

	return i;
}

enum wg_tcp_state wg_tunnel_tcp_state(struct wg_tunnel *tunnel, int conn_index) {
	if (conn_index < 0 || conn_index >= WG_MAX_TCP_CONNS)
		return WG_TCP_NONE;
	return tunnel->conns[conn_index].state;
}

int wg_tunnel_tcp_write(struct wg_tunnel *tunnel, int conn_index,
                        const uint8_t *data, size_t len) {
	if (conn_index < 0 || conn_index >= WG_MAX_TCP_CONNS)
		return -1;

	struct wg_tcp_conn *conn = &tunnel->conns[conn_index];
	if (conn->state != WG_TCP_CONNECTED || !conn->pcb)
		return -1;

	u16_t space = tcp_sndbuf(conn->pcb);
	if (space == 0) return 0;

	u16_t to_write = (len > space) ? space : (u16_t)len;
	err_t err = tcp_write(conn->pcb, data, to_write, TCP_WRITE_FLAG_COPY);
	if (err != ERR_OK) return -1;

	tcp_output(conn->pcb);
	conn->tx_space = tcp_sndbuf(conn->pcb);
	return to_write;
}

int wg_tunnel_tcp_read(struct wg_tunnel *tunnel, int conn_index,
                       uint8_t *buf, size_t len) {
	if (conn_index < 0 || conn_index >= WG_MAX_TCP_CONNS)
		return -1;

	struct wg_tcp_conn *conn = &tunnel->conns[conn_index];
	if (conn->rx_head == conn->rx_tail)
		return 0;  /* No data available */

	size_t available = (WG_TCP_RX_BUF_SIZE + conn->rx_head - conn->rx_tail) % WG_TCP_RX_BUF_SIZE;
	size_t to_read = (len < available) ? len : available;

	/* Copy from ring buffer, handling wrap-around */
	size_t first = WG_TCP_RX_BUF_SIZE - conn->rx_tail;
	if (first >= to_read) {
		memcpy(buf, conn->rx_buf + conn->rx_tail, to_read);
	} else {
		memcpy(buf, conn->rx_buf + conn->rx_tail, first);
		memcpy(buf + first, conn->rx_buf, to_read - first);
	}
	conn->rx_tail = (conn->rx_tail + to_read) % WG_TCP_RX_BUF_SIZE;

	/* Reading freed ring buffer space — drain any pending pbuf data */
	flush_pending(conn);

	return (int)to_read;
}

size_t wg_tunnel_tcp_readable(struct wg_tunnel *tunnel, int conn_index) {
	if (conn_index < 0 || conn_index >= WG_MAX_TCP_CONNS)
		return 0;
	struct wg_tcp_conn *conn = &tunnel->conns[conn_index];
	return (WG_TCP_RX_BUF_SIZE + conn->rx_head - conn->rx_tail) % WG_TCP_RX_BUF_SIZE;
}

void wg_tunnel_tcp_close(struct wg_tunnel *tunnel, int conn_index) {
	if (conn_index < 0 || conn_index >= WG_MAX_TCP_CONNS)
		return;

	struct wg_tcp_conn *conn = &tunnel->conns[conn_index];
	if (conn->pcb) {
		tcp_arg(conn->pcb, NULL);
		tcp_recv(conn->pcb, NULL);
		tcp_sent(conn->pcb, NULL);
		tcp_err(conn->pcb, NULL);
		tcp_close(conn->pcb);
		conn->pcb = NULL;
	}
	if (conn->pending_pbuf) {
		pbuf_free(conn->pending_pbuf);
		conn->pending_pbuf = NULL;
		conn->pending_offset = 0;
	}
	conn->state = WG_TCP_NONE;  /* Recycle the slot */
}

/* ---- UDP socket API ---- */

static void wg_udp_recv_cb(void *arg, struct udp_pcb *pcb, struct pbuf *p,
                            const ip_addr_t *addr, u16_t port) {
	struct wg_udp_socket *sock = (struct wg_udp_socket *)arg;
	if (!p) return;

	int next_head = (sock->queue_head + 1) % WG_UDP_QUEUE_SIZE;
	if (next_head == sock->queue_tail) {
		/* Queue full, drop */
		pbuf_free(p);
		return;
	}

	struct wg_udp_dgram *dgram = &sock->queue[sock->queue_head];
	size_t copy_len = p->tot_len;
	if (copy_len > WG_UDP_MAX_DGRAM)
		copy_len = WG_UDP_MAX_DGRAM;

	pbuf_copy_partial(p, dgram->data, copy_len, 0);
	dgram->len = (uint16_t)copy_len;
	dgram->from_ip = ntohl(ip4_addr_get_u32(ip_2_ip4(addr)));
	dgram->from_port = port;

	sock->queue_head = next_head;
	pbuf_free(p);
}

int wg_tunnel_udp_bind(struct wg_tunnel *tunnel, uint16_t port) {
	int i;
	for (i = 0; i < WG_MAX_UDP_SOCKETS; i++) {
		if (!tunnel->udp_sockets[i].active)
			break;
	}
	if (i >= WG_MAX_UDP_SOCKETS) return -1;

	struct udp_pcb *pcb = udp_new();
	if (!pcb) return -1;

	udp_bind_netif(pcb, &tunnel->netif);

	err_t err = udp_bind(pcb, IP_ADDR_ANY, port);
	if (err != ERR_OK) {
		udp_remove(pcb);
		return -1;
	}

	struct wg_udp_socket *sock = &tunnel->udp_sockets[i];
	memset(sock, 0, sizeof(struct wg_udp_socket));
	sock->pcb = pcb;
	sock->tunnel = tunnel;
	sock->port = port;
	sock->active = 1;

	udp_recv(pcb, wg_udp_recv_cb, sock);
	return i;
}

int wg_tunnel_udp_sendto(struct wg_tunnel *tunnel, int sock_index,
                         const uint8_t *data, size_t len,
                         const char *host, uint16_t port) {
	if (sock_index < 0 || sock_index >= WG_MAX_UDP_SOCKETS)
		return -1;

	struct wg_udp_socket *sock = &tunnel->udp_sockets[sock_index];
	if (!sock->active || !sock->pcb)
		return -1;

	ip4_addr_t addr;
	if (!ip4addr_aton(host, &addr))
		return -1;

	if (len > 0xFFFF) return -1;

	ip_addr_t lip;
	ip_addr_copy_from_ip4(lip, addr);

	struct pbuf *p = pbuf_alloc(PBUF_TRANSPORT, (u16_t)len, PBUF_RAM);
	if (!p) return -1;

	memcpy(p->payload, data, len);

	err_t err = udp_sendto(sock->pcb, p, &lip, port);
	pbuf_free(p);

	return (err == ERR_OK) ? (int)len : -1;
}

int wg_tunnel_udp_recv(struct wg_tunnel *tunnel, int sock_index,
                       uint8_t *buf, size_t len,
                       uint32_t *from_ip, uint16_t *from_port) {
	if (sock_index < 0 || sock_index >= WG_MAX_UDP_SOCKETS)
		return -1;

	struct wg_udp_socket *sock = &tunnel->udp_sockets[sock_index];
	if (!sock->active) return -1;

	if (sock->queue_head == sock->queue_tail)
		return 0;

	struct wg_udp_dgram *dgram = &sock->queue[sock->queue_tail];
	size_t copy_len = dgram->len;
	if (copy_len > len)
		copy_len = len;

	memcpy(buf, dgram->data, copy_len);
	if (from_ip) *from_ip = dgram->from_ip;
	if (from_port) *from_port = dgram->from_port;

	sock->queue_tail = (sock->queue_tail + 1) % WG_UDP_QUEUE_SIZE;
	return (int)copy_len;
}

int wg_tunnel_udp_pending(struct wg_tunnel *tunnel, int sock_index) {
	if (sock_index < 0 || sock_index >= WG_MAX_UDP_SOCKETS)
		return 0;

	struct wg_udp_socket *sock = &tunnel->udp_sockets[sock_index];
	if (!sock->active) return 0;

	return (WG_UDP_QUEUE_SIZE + sock->queue_head - sock->queue_tail) % WG_UDP_QUEUE_SIZE;
}

void wg_tunnel_udp_close(struct wg_tunnel *tunnel, int sock_index) {
	if (sock_index < 0 || sock_index >= WG_MAX_UDP_SOCKETS)
		return;

	struct wg_udp_socket *sock = &tunnel->udp_sockets[sock_index];
	if (!sock->active) return;

	if (sock->pcb) {
		udp_recv(sock->pcb, NULL, NULL);
		udp_remove(sock->pcb);
		sock->pcb = NULL;
	}
	sock->active = 0;
}

int wg_tunnel_get_fd(struct wg_tunnel *tunnel) {
	return tunnel->sock_fd;
}

void wg_tunnel_destroy(struct wg_tunnel *tunnel) {
	if (!tunnel->initialized) return;

	/* Close all UDP sockets */
	int i;
	for (i = 0; i < WG_MAX_UDP_SOCKETS; i++) {
		if (tunnel->udp_sockets[i].active)
			wg_tunnel_udp_close(tunnel, i);
	}

	/* Close all listeners */
	for (i = 0; i < WG_MAX_TCP_LISTENERS; i++) {
		if (tunnel->listeners[i].active)
			wg_tunnel_tcp_unlisten(tunnel, i);
	}

	/* Close all TCP connections */
	for (i = 0; i < WG_MAX_TCP_CONNS; i++) {
		if (tunnel->conns[i].state != WG_TCP_NONE)
			wg_tunnel_tcp_close(tunnel, i);
	}

	/* Cancel timers */
	sys_untimeout(wg_timer_callback, tunnel);

	/* Remove netif */
	netif_set_down(&tunnel->netif);
	netif_remove(&tunnel->netif);

	/* Close UDP socket */
	if (tunnel->sock_fd >= 0) {
		close(tunnel->sock_fd);
		tunnel->sock_fd = -1;
	}

	/* Zero out crypto material */
	crypto_zero(&tunnel->device, sizeof(tunnel->device));

	tunnel->initialized = 0;
}

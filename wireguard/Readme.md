# qn:wireguard

Userspace WireGuard tunnels for qn. Provides encrypted point-to-point networking with TCP, UDP, and a SOCKS5 proxy — all running unprivileged, no kernel module or root required.

Built on [wireguard-lwip](https://github.com/smartalock/wireguard-lwip) (WireGuard protocol) and [lwIP](https://savannah.nongnu.org/projects/lwip/) (TCP/IP stack). Compile with `USE_WIREGUARD=1` (default) or disable with `USE_WIREGUARD=0`.


## Quick start

```js
import { WireGuardTunnel } from "qn:wireguard"

const tunnel = new WireGuardTunnel({
	privateKey: "base64-encoded-x25519-private-key",
	address: "10.0.0.1",
	listenPort: 51820,
	peers: [{
		publicKey: "base64-encoded-peer-public-key",
		endpoint: "1.2.3.4",
		endpointPort: 51820,
	}],
})

await tunnel.waitForPeer()
const sock = await tunnel.connect("10.0.0.2", 8080)
await sock.write(new TextEncoder().encode("hello"))
const data = await sock.read()
sock.close()
tunnel.close()
```


## API

### `WireGuardTunnel`

```js
import { WireGuardTunnel } from "qn:wireguard"
```

#### Constructor config

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `privateKey` | string | yes | — | Base64-encoded X25519 private key |
| `address` | string | yes | — | Tunnel IP (e.g. `"10.0.0.1"`) |
| `netmask` | string | no | `"255.255.255.0"` | Tunnel netmask |
| `listenAddress` | string | no | all interfaces | UDP bind address |
| `listenPort` | number | no | `0` (random) | UDP listen port |
| `peers[]` | array | no | `[]` | Peer configurations |
| `peers[].publicKey` | string | yes | — | Base64-encoded peer public key |
| `peers[].presharedKey` | string | no | `null` | Base64-encoded pre-shared key |
| `peers[].endpoint` | string | no | — | Peer IP address |
| `peers[].endpointPort` | number | no | `0` | Peer UDP port (0 = passive, wait for peer to connect) |
| `peers[].allowedIP` | string | no | `"0.0.0.0"` | Allowed source IP |
| `peers[].allowedMask` | string | no | `"0.0.0.0"` | Allowed source mask |
| `peers[].keepalive` | number | no | `0` | Keepalive interval in seconds |

#### Methods

- **`waitForPeer(peerIndex?, { signal?, timeout? })`** — wait for a peer's WireGuard handshake to complete (default timeout: 30s)
- **`connect(host, port, { signal? })`** → `Promise<TunnelSocket>` — open a TCP connection through the tunnel
- **`listen(port)`** → `TunnelServer` — start a TCP listener on the tunnel interface
- **`udpBind(port)`** → `TunnelDgram` — bind a UDP socket on the tunnel interface
- **`fetch(url, init?)`** → `Promise<Response>` — HTTP fetch through the tunnel (http:// only)
- **`serve(port, handler)`** → `TunnelHttpServer` — HTTP server on the tunnel (handler: `(Request) → Response`)
- **`socksProxy({ port?, host? })`** → `Promise<SocksProxy>` — start a local SOCKS5 proxy routing through this tunnel
- **`peerIsUp(peerIndex?)`** → `boolean` — check if a peer has an active session
- **`close()`** — tear down the tunnel and all connections

### `TunnelSocket`

Represents a single TCP connection through the tunnel.

- **`read({ signal? })`** → `Promise<Uint8Array|null>` — read data; returns `null` on EOF
- **`write(data, { signal? })`** → `Promise<void>` — write a `Uint8Array`; handles backpressure internally
- **`readable`** → `number` — bytes available to read without blocking
- **`state`** → current TCP state (`WG_TCP_CONNECTED`, `WG_TCP_CLOSED`, etc.)
- **`close()`** — close the connection

### `TunnelServer`

TCP listener on the tunnel interface.

- **`accept({ signal?, timeout? })`** → `Promise<TunnelSocket>` — wait for the next incoming connection
- **`close()`** — stop listening

### `TunnelDgram`

UDP socket on the tunnel interface.

- **`sendTo(data, address, port)`** → `number` — send a datagram (synchronous)
- **`recvFrom()`** → `{ data, address, port } | null` — non-blocking receive
- **`recv({ signal?, timeout? })`** → `Promise<{ data, address, port }>` — blocking receive
- **`pending`** → `number` — number of queued datagrams
- **`close()`** — close the socket

### `TunnelHttpServer`

HTTP server running on the tunnel interface.

- **`close()`** — stop accepting connections, close all active ones

### `SocksProxy`

Returned by `tunnel.socksProxy()`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | `1080` | Local port (0 = random) |
| `host` | string | `"127.0.0.1"` | Local bind address |

- **`address()`** → `{ address, port, family }` — bound address
- **`close()`** — stop proxy, close all bridged connections


## SOCKS5 proxy

The SOCKS5 proxy lets external programs route TCP traffic through a WireGuard tunnel without any WireGuard-specific code:

```js
import { WireGuardTunnel } from "qn:wireguard"

const tunnel = new WireGuardTunnel({
	privateKey: MY_KEY,
	address: "10.0.0.1",
	listenPort: 51820,
	peers: [{
		publicKey: PEER_PUB,
		endpoint: "1.2.3.4",
		endpointPort: 51820,
		allowedIP: "0.0.0.0",
		allowedMask: "0.0.0.0",
	}],
})

await tunnel.waitForPeer()
const proxy = await tunnel.socksProxy({ port: 1080 })
```

Then from any app:

```sh
curl --proxy socks5://127.0.0.1:1080 http://10.0.0.2/
curl --proxy socks5h://127.0.0.1:1080 http://example.com/
```

(`socks5h` means the proxy resolves domain names locally before connecting through the tunnel.)

### What's supported

- **SOCKS5 CONNECT** — the standard TCP proxying command, used by browsers, curl, wget, SSH (`ProxyCommand`), and most tools that support SOCKS
- **IPv4 addresses and domain names** — domains are resolved locally via `getaddrinfo`
- **Multiple concurrent connections** — each SOCKS client gets its own independent tunnel TCP connection
- **Backpressure** — both directions handle slow readers/writers correctly

### What's not supported

- **UDP ASSOCIATE** — SOCKS5's UDP relay command. Rarely used; the main consumer would be DNS-over-SOCKS.
- **BIND** — SOCKS5's reverse-connect command. Only used by FTP active mode.
- **IPv6** — lwIP is configured with `LWIP_IPV6=0`
- **Authentication** — only anonymous/no-auth. Username/password auth (RFC 1929) could be added if needed.


## HTTP over tunnel

`tunnel.fetch()` and `tunnel.serve()` provide HTTP/1.1 client and server directly on the tunnel, using the same shared HTTP parsing as `node:fetch` and `node:http`.

### Client: `tunnel.fetch()`

```js
const tunnel = new WireGuardTunnel({ /* ... */ })
await tunnel.waitForPeer()

const resp = await tunnel.fetch("http://10.0.0.2:8080/api/data")
const json = await resp.json()

const resp2 = await tunnel.fetch("http://10.0.0.2:8080/submit", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ key: "value" }),
})
```

Same interface as `fetch()` — returns a standard `Response` with `.text()`, `.json()`, `.arrayBuffer()`, etc. Only `http://` is supported (no TLS inside the tunnel).

### Server: `tunnel.serve()`

Handler takes a standard `Request` and returns a `Response` — compatible with Hono, or any framework using the Fetch API pattern:

```js
// Plain handler
const httpServer = tunnel.serve(8080, async (req) => {
	const url = new URL(req.url)
	if (url.pathname === "/api/data")
		return Response.json({ hello: "world" })
	return new Response("not found", { status: 404 })
})

// With Hono
import { Hono } from "hono"
const app = new Hono()
app.get("/", c => c.text("hello from tunnel"))
const httpServer = tunnel.serve(8080, app.fetch)
```


## Limitations

- **IPv4 only** — lwIP is built without IPv6 support
- **No DNS inside tunnel** — `LWIP_DNS=0`; domain names are resolved on the host before connecting through the tunnel
- **HTTP only, no HTTPS** — `tunnel.fetch()` and `tunnel.serve()` only support `http://`. The WireGuard tunnel itself provides encryption, so TLS inside the tunnel is usually redundant.
- **Polling-based I/O** — the JS layer polls lwIP with 10-50ms sleeps; fine for most use cases but not ideal for latency-sensitive workloads
- **Unprivileged** — this is a userspace tunnel, not a TUN/TAP device. Only the qn process (and SOCKS clients) can use it; it doesn't affect system-wide routing


## Notes

- All I/O is async with `AbortSignal` support throughout.
- `read()` returns `null` on EOF — always check in your read loop.
- `write()` handles backpressure internally, retrying until all bytes are sent.
- Both peers must know each other's public keys upfront (standard WireGuard). At least one side needs a fixed `listenPort`.
- Tunnel IP addresses are virtual (lwIP); actual WireGuard UDP transport goes over the real network.
- Each `WireGuardTunnel` instance gets its own lwIP netif, so multiple independent tunnels work in the same process.
- Peers with `endpointPort: 0` are passive — they wait for the remote side to initiate the handshake.

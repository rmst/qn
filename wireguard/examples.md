# qn:wireguard Examples

## API Overview

```js
import {
	WireGuardTunnel, TunnelSocket, TunnelServer, TunnelDgram,
	WG_TCP_NONE, WG_TCP_CONNECTING, WG_TCP_CONNECTED,
	WG_TCP_CLOSING, WG_TCP_CLOSED, WG_TCP_ERROR,
} from "qn:wireguard"
```

### `WireGuardTunnel` constructor config

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `privateKey` | string | yes | — | Base64-encoded X25519 private key |
| `address` | string | yes | — | Tunnel IP (e.g. `"10.0.0.1"`) |
| `netmask` | string | no | `"255.255.255.0"` | Tunnel netmask |
| `listenAddress` | string | no | all interfaces | UDP bind address |
| `listenPort` | number | no | `0` (random) | UDP listen port |
| `peers[]` | array | no | `[]` | Peer configs |
| `peers[].publicKey` | string | yes | — | Base64-encoded peer public key |
| `peers[].presharedKey` | string | no | `null` | Base64-encoded PSK |
| `peers[].endpoint` | string | no | — | Peer IP address |
| `peers[].endpointPort` | number | no | `0` | Peer UDP port (0 = passive, wait for peer to connect) |
| `peers[].allowedIP` | string | no | `"0.0.0.0"` | Allowed IP |
| `peers[].allowedMask` | string | no | `"0.0.0.0"` | Allowed mask |
| `peers[].keepalive` | number | no | `0` | Keepalive seconds |

### `WireGuardTunnel` methods

- `waitForPeer(peerIndex?, { signal?, timeout? })` — wait for handshake
- `connect(host, port, { signal? })` → `Promise<TunnelSocket>` — TCP connect
- `listen(port)` → `TunnelServer` — TCP listener
- `udpBind(port)` → `TunnelDgram` — UDP socket
- `fetch(url, init?)` → `Promise<Response>` — HTTP fetch through tunnel
- `serve(port, handler)` → `TunnelHttpServer` — HTTP server on tunnel
- `socksProxy({ port?, host? })` → `Promise<SocksProxy>` — SOCKS5 proxy
- `peerIsUp(peerIndex?)` → `boolean` — check peer session
- `close()` — tear down tunnel

### `TunnelSocket`

- `read({ signal? })` → `Promise<Uint8Array|null>` — read (null = EOF)
- `write(data, { signal? })` → `Promise<void>` — write `Uint8Array`
- `readable` → `number` — bytes available
- `state` → connection state constant
- `close()`

### `TunnelServer`

- `accept({ signal?, timeout? })` → `Promise<TunnelSocket>`
- `close()`

### `TunnelDgram`

- `sendTo(data, address, port)` → `number` — sync send
- `recvFrom()` → `{ data, address, port } | null` — non-blocking
- `recv({ signal?, timeout? })` → `Promise<{ data, address, port }>` — blocking
- `pending` → `number` — queued datagrams
- `close()`


## Two peers communicating over TCP

```js
// -- Node A (client) --
import { WireGuardTunnel } from "qn:wireguard"

const client = new WireGuardTunnel({
	privateKey: CLIENT_PRIVATE_KEY,
	address: "10.0.0.1",
	listenPort: 51821,
	peers: [{
		publicKey: SERVER_PUBLIC_KEY,
		endpoint: "192.168.1.100",
		endpointPort: 51820,
		allowedIP: "10.0.0.0",
		allowedMask: "255.255.255.0",
	}],
})

await client.waitForPeer()
const sock = await client.connect("10.0.0.2", 8080)
await sock.write(new TextEncoder().encode("hello from client"))
const response = await sock.read()
console.log(new TextDecoder().decode(response))
sock.close()
client.close()
```

```js
// -- Node B (server) --
import { WireGuardTunnel } from "qn:wireguard"

const server = new WireGuardTunnel({
	privateKey: SERVER_PRIVATE_KEY,
	address: "10.0.0.2",
	listenPort: 51820,
	peers: [{
		publicKey: CLIENT_PUBLIC_KEY,
		endpoint: "192.168.1.101",
		endpointPort: 51821,
		allowedIP: "10.0.0.0",
		allowedMask: "255.255.255.0",
	}],
})

const listener = server.listen(8080)
await server.waitForPeer()

const conn = await listener.accept()
const data = await conn.read()
console.log(new TextDecoder().decode(data)) // "hello from client"
await conn.write(new TextEncoder().encode("hello back"))
conn.close()

listener.close()
server.close()
```


## TCP echo server (multiple connections)

```js
import { WireGuardTunnel } from "qn:wireguard"

const tunnel = new WireGuardTunnel({
	privateKey: MY_KEY,
	address: "10.0.0.1",
	listenPort: 51820,
	peers: [/* ... */],
})

const listener = tunnel.listen(9000)
await tunnel.waitForPeer()

const ac = new AbortController()

while (!ac.signal.aborted) {
	const conn = await listener.accept({ signal: ac.signal })
	// Handle each connection concurrently
	;(async () => {
		let chunk
		while ((chunk = await conn.read()) !== null) {
			await conn.write(chunk)
		}
		conn.close()
	})()
}

listener.close()
tunnel.close()
```


## UDP messaging

```js
// -- Sender --
import { WireGuardTunnel } from "qn:wireguard"

const t1 = new WireGuardTunnel({
	privateKey: KEY_A,
	address: "10.0.0.1",
	listenPort: 51821,
	peers: [{
		publicKey: PUB_B,
		endpoint: "127.0.0.1",
		endpointPort: 51822,
		allowedIP: "10.0.0.0",
		allowedMask: "255.255.255.0",
	}],
})

await t1.waitForPeer()
const udp = t1.udpBind(5000)
udp.sendTo(new TextEncoder().encode("ping"), "10.0.0.2", 5000)

const reply = await udp.recv({ timeout: 5000 })
console.log(new TextDecoder().decode(reply.data)) // "pong"
console.log(reply.address, reply.port) // "10.0.0.2" 5000

udp.close()
t1.close()
```

```js
// -- Receiver --
import { WireGuardTunnel } from "qn:wireguard"

const t2 = new WireGuardTunnel({
	privateKey: KEY_B,
	address: "10.0.0.2",
	listenPort: 51822,
	peers: [{
		publicKey: PUB_A,
		endpoint: "127.0.0.1",
		endpointPort: 51821,
		allowedIP: "10.0.0.0",
		allowedMask: "255.255.255.0",
	}],
})

await t2.waitForPeer()
const udp = t2.udpBind(5000)

const msg = await udp.recv({ timeout: 5000 })
console.log(new TextDecoder().decode(msg.data)) // "ping"

udp.sendTo(new TextEncoder().encode("pong"), msg.address, msg.port)

udp.close()
t2.close()
```


## Multiple independent tunnels

Each `WireGuardTunnel` gets its own lwIP netif, so multiple tunnels work independently in the same process:

```js
import { WireGuardTunnel } from "qn:wireguard"

const tunnelA = new WireGuardTunnel({
	privateKey: MY_KEY,
	address: "10.0.0.1",
	peers: [{ publicKey: PEER_A_PUB, endpoint: "1.2.3.4", endpointPort: 51820, ... }],
})

const tunnelB = new WireGuardTunnel({
	privateKey: MY_KEY,
	address: "10.1.0.1",
	peers: [{ publicKey: PEER_B_PUB, endpoint: "5.6.7.8", endpointPort: 51820, ... }],
})

const sockA = await tunnelA.connect("10.0.0.2", 80)
const sockB = await tunnelB.connect("10.1.0.2", 80)
```


## HTTP fetch through tunnel

```js
import { WireGuardTunnel } from "qn:wireguard"

const tunnel = new WireGuardTunnel({
	privateKey: MY_KEY,
	address: "10.0.0.1",
	listenPort: 51820,
	peers: [{ publicKey: PEER_PUB, endpoint: "1.2.3.4", endpointPort: 51820 }],
})

await tunnel.waitForPeer()

const resp = await tunnel.fetch("http://10.0.0.2:8080/api/data")
const json = await resp.json()

tunnel.close()
```


## HTTP server on tunnel

Handler takes a `Request` and returns a `Response` — compatible with Hono or any Fetch API framework.

```js
import { WireGuardTunnel } from "qn:wireguard"

const tunnel = new WireGuardTunnel({
	privateKey: MY_KEY,
	address: "10.0.0.2",
	listenPort: 51820,
	peers: [{ publicKey: PEER_PUB }],
})

const httpServer = tunnel.serve(8080, async (req) => {
	const url = new URL(req.url)
	if (url.pathname === "/api/data")
		return Response.json({ hello: "world" })
	return new Response("not found", { status: 404 })
})

// With Hono:
// import { Hono } from "hono"
// const app = new Hono()
// app.get("/", c => c.text("hello from tunnel"))
// const httpServer = tunnel.serve(8080, app.fetch)
```


## SOCKS5 proxy

`tunnel.socksProxy()` starts a local SOCKS5 proxy that routes TCP traffic through the WireGuard tunnel. Other programs (browsers, curl, etc.) can use it without any WireGuard-specific code.

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
console.log("SOCKS5 proxy listening on", proxy.address())

// Other apps can now use:
//   curl --proxy socks5://127.0.0.1:1080 http://10.0.0.2/
//   curl --proxy socks5h://127.0.0.1:1080 http://example.com/
//     (socks5h = proxy resolves hostnames locally)
```


## Notes

- All I/O is async. The tunnel runs an internal event loop (fd read handler + 100ms timer) driving lwIP.
- `read()` returns `null` on EOF/close — always check in your read loop.
- `write()` handles backpressure internally, retrying until all bytes are sent.
- `AbortSignal` is supported throughout for cancellation.
- Both peers must know each other's public keys and endpoints upfront (standard WireGuard).
- Tunnel IP addresses are virtual (lwIP stack); actual UDP transport uses the real network.
- `listenPort: 0` picks a random port — at least one side needs a fixed port so the peer knows where to connect.

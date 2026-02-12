/**
 * qn:wireguard - WireGuard tunnel with TCP connections
 *
 * Provides userspace WireGuard tunnels using lwIP for TCP/IP processing.
 * The C module (qn_wireguard) exposes non-blocking primitives;
 * this module wraps them with async I/O using the QuickJS event loop.
 */

import {
	wgCreateTunnel, wgGetFd, wgAddPeer, wgConnect, wgPeerIsUp,
	wgProcessInput, wgCheckTimeouts,
	wgTcpListen, wgTcpAccept, wgTcpUnlisten,
	wgTcpConnect, wgTcpState, wgTcpWrite, wgTcpRead, wgTcpReadable, wgTcpClose,
	wgUdpBind, wgUdpSendTo, wgUdpRecv, wgUdpPending, wgUdpClose,
	wgClose,
	WG_TCP_NONE, WG_TCP_CONNECTING, WG_TCP_CONNECTED,
	WG_TCP_CLOSING, WG_TCP_CLOSED, WG_TCP_ERROR,
} from 'qn_wireguard'
import * as os from 'os'
import * as tls from 'node:tls'
import { existsSync } from 'node:fs'
import {
	buildRequest, readResponseHead, readRequestHead, bodyStream,
	requestBodyStream, chunkedRequestBodyStream, writeChunkedBody,
	concatChunks,
} from 'node:http/parse'
import { Headers } from 'node:fetch/Headers'
import { Response } from 'node:fetch/Response'
import { Request } from 'node:fetch/Request'
import { SocksProxy } from './wireguard-socks.js'

const SYSTEM_CA_PATHS = [
	'/etc/ssl/certs/ca-certificates.crt',
	'/etc/pki/tls/certs/ca-bundle.crt',
	'/etc/ssl/cert.pem',
	'/etc/ssl/ca-bundle.pem',
	'/usr/local/share/certs/ca-root-nss.crt',
	'/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
]

let _caCertsLoaded = false
function ensureCACerts() {
	if (_caCertsLoaded) return
	_caCertsLoaded = true
	const sslCertFile = globalThis.process?.env?.SSL_CERT_FILE
	if (sslCertFile) {
		tls.loadCACerts(sslCertFile)
	} else {
		for (const p of SYSTEM_CA_PATHS) {
			if (existsSync(p)) { tls.loadCACerts(p); break }
		}
	}
	const extraCerts = globalThis.process?.env?.NODE_EXTRA_CA_CERTS
	if (extraCerts) tls.loadCACerts(extraCerts)
}

export { WG_TCP_NONE, WG_TCP_CONNECTING, WG_TCP_CONNECTED, WG_TCP_CLOSING, WG_TCP_CLOSED, WG_TCP_ERROR }

export class WireGuardTunnel {
	#tunnel
	#fd
	#timerHandle
	#destroyed = false
	#pumpWaiters = []

	/**
	 * Create a WireGuard tunnel.
	 *
	 * @param {Object} config
	 * @param {string} config.privateKey - Base64-encoded private key
	 * @param {string} config.address - Tunnel IP address (e.g. "10.0.0.2")
	 * @param {string} [config.netmask="255.255.255.0"] - Tunnel netmask
	 * @param {string} [config.listenAddress] - UDP bind address (default: all interfaces)
	 * @param {number} [config.listenPort=0] - UDP listen port (0 = random)
	 * @param {Object[]} [config.peers] - Peer configurations
	 * @param {string} config.peers[].publicKey - Base64-encoded peer public key
	 * @param {string} [config.peers[].presharedKey] - Base64-encoded PSK
	 * @param {string} config.peers[].endpoint - Peer endpoint IP
	 * @param {number} config.peers[].endpointPort - Peer endpoint port
	 * @param {string} [config.peers[].allowedIP="0.0.0.0"] - Allowed IP
	 * @param {string} [config.peers[].allowedMask="0.0.0.0"] - Allowed mask
	 * @param {number} [config.peers[].keepalive=0] - Keepalive interval in seconds
	 */
	constructor(config) {
		this.#tunnel = wgCreateTunnel(
			config.privateKey,
			config.address,
			config.netmask || "255.255.255.0",
			config.listenAddress || null,
			config.listenPort || 0,
		)
		this.#fd = wgGetFd(this.#tunnel)

		if (config.peers) {
			for (const peer of config.peers) {
				const idx = wgAddPeer(
					this.#tunnel,
					peer.publicKey,
					peer.presharedKey || null,
					peer.endpoint || "0.0.0.0",
					peer.endpointPort || 0,
					peer.allowedIP || "0.0.0.0",
					peer.allowedMask || "0.0.0.0",
					peer.keepalive || 0,
				)
				if (peer.endpointPort)
					wgConnect(this.#tunnel, idx)
			}
		}

		this.#startEventLoop()
	}

	#pump() {
		if (this.#destroyed) return
		wgProcessInput(this.#tunnel)
		wgCheckTimeouts(this.#tunnel)
		const waiters = this.#pumpWaiters
		this.#pumpWaiters = []
		for (const w of waiters) w()
	}

	#startEventLoop() {
		os.setReadHandler(this.#fd, () => this.#pump())

		const tick = () => {
			if (this.#destroyed) return
			this.#pump()
			this.#timerHandle = os.setTimeout(tick, 100)
		}
		this.#timerHandle = os.setTimeout(tick, 100)
	}

	/** Wait for the next pump cycle (incoming data or timer tick) */
	waitForPump(signal) {
		if (signal?.aborted) return Promise.reject(signal.reason)
		if (this.#destroyed) return Promise.reject(new Error("WireGuard: tunnel closed"))
		return new Promise((resolve, reject) => {
			let settled = false
			const waiter = () => {
				if (settled) return
				settled = true
				if (signal) signal.removeEventListener('abort', onAbort)
				resolve()
			}
			const onAbort = () => {
				if (settled) return
				settled = true
				const idx = this.#pumpWaiters.indexOf(waiter)
				if (idx >= 0) this.#pumpWaiters.splice(idx, 1)
				reject(signal.reason)
			}
			if (signal) signal.addEventListener('abort', onAbort, { once: true })
			this.#pumpWaiters.push(waiter)
		})
	}

	/** Wait for at least one peer to establish a WireGuard session */
	async waitForPeer(peerIndex = 0, { signal, timeout = 30000 } = {}) {
		const start = Date.now()
		while (!wgPeerIsUp(this.#tunnel, peerIndex)) {
			if (signal?.aborted) throw signal.reason
			if (Date.now() - start > timeout)
				throw new Error("WireGuard: peer handshake timed out")
			await this.waitForPump(signal)
		}
	}

	/**
	 * Listen for incoming TCP connections on a port.
	 *
	 * @param {number} port - Port to listen on
	 * @returns {TunnelServer}
	 */
	listen(port) {
		const listenerIndex = wgTcpListen(this.#tunnel, port)
		return new TunnelServer(this, listenerIndex)
	}

	/**
	 * Bind a UDP socket on the tunnel.
	 *
	 * @param {number} port - Port to bind
	 * @returns {TunnelDgram}
	 */
	udpBind(port) {
		const sockIndex = wgUdpBind(this.#tunnel, port)
		return new TunnelDgram(this, sockIndex)
	}

	/**
	 * Open a TCP connection through the tunnel.
	 *
	 * @param {string} host - Destination IP address
	 * @param {number} port - Destination port
	 * @param {Object} [options]
	 * @param {AbortSignal} [options.signal] - Abort signal
	 * @returns {Promise<TunnelSocket>}
	 */
	async connect(host, port, { signal } = {}) {
		const conn = wgTcpConnect(this.#tunnel, host, port)

		while (wgTcpState(conn) === WG_TCP_CONNECTING) {
			if (signal?.aborted) {
				wgTcpClose(conn)
				throw signal.reason
			}
			await this.waitForPump(signal)
		}

		const state = wgTcpState(conn)
		if (state !== WG_TCP_CONNECTED) {
			wgTcpClose(conn)
			throw new Error("WireGuard: TCP connection failed")
		}

		return new TunnelSocket(this, conn)
	}

	get fd() { return this.#fd }
	get _tunnel() { return this.#tunnel }

	/**
	 * Fetch an HTTP resource through the tunnel.
	 *
	 * @param {string|URL} input - URL to fetch (http:// only)
	 * @param {Object} [init] - Fetch options (method, headers, body, signal)
	 * @returns {Promise<Response>}
	 */
	async fetch(input, init = {}) {
		const url = typeof input === 'string' ? new URL(input) : input
		const isHttps = url.protocol === 'https:'
		if (url.protocol !== 'http:' && !isHttps)
			throw new TypeError('tunnel.fetch: only http:// and https:// are supported')

		const signal = init.signal || null
		const method = (init.method || 'GET').toUpperCase()
		const headers = init.headers instanceof Headers
			? new Headers(init.headers)
			: new Headers(init.headers || {})

		let bodyBytes = null
		let bodyIter = null
		if (init.body != null) {
			if (typeof init.body === 'string') {
				bodyBytes = new TextEncoder().encode(init.body)
				if (!headers.has('content-type'))
					headers.set('content-type', 'text/plain;charset=UTF-8')
				headers.set('content-length', String(bodyBytes.byteLength))
			} else if (init.body instanceof Uint8Array) {
				bodyBytes = init.body
				headers.set('content-length', String(bodyBytes.byteLength))
			} else if (init.body instanceof ArrayBuffer) {
				bodyBytes = new Uint8Array(init.body)
				headers.set('content-length', String(bodyBytes.byteLength))
			} else if (typeof init.body?.[Symbol.asyncIterator] === 'function'
				|| typeof init.body?.[Symbol.iterator] === 'function') {
				bodyIter = init.body
				if (!headers.has('transfer-encoding'))
					headers.set('transfer-encoding', 'chunked')
			} else {
				throw new TypeError('Unsupported body type')
			}
		}

		const host = url.hostname
		const defaultPort = isHttps ? 443 : 80
		const port = url.port ? parseInt(url.port, 10) : defaultPort
		const path = (url.pathname || '/') + (url.search || '')

		const sock = await this.connect(host, port, { signal })

		let reader
		if (isHttps) {
			ensureCACerts()
			const tlsConn = tls.connectBuf(host)
			try {
				await tls.handshake(tlsConn, sock, signal)
				const reqBytes = new TextEncoder().encode(
					buildRequest(method, path, host, port, headers, port === defaultPort),
				)
				await tls.writeAll(tlsConn, sock, reqBytes, signal)
				if (bodyBytes) await tls.writeAll(tlsConn, sock, bodyBytes, signal)
				else if (bodyIter) await writeChunkedBody(
					data => tls.writeAll(tlsConn, sock, data, signal), bodyIter,
				)
			} catch (e) {
				try { await tls.close(tlsConn, sock) } catch {}
				sock.close()
				throw e
			}
			reader = {
				async read(buf, off, len) {
					return tls.read(tlsConn, sock, buf, off, len, signal)
				},
				async close() {
					try { await tls.close(tlsConn, sock) } catch {}
					sock.close()
				},
			}
		} else {
			const reqStr = buildRequest(method, path, host, port, headers, port === defaultPort)
			await sock.write(new TextEncoder().encode(reqStr), { signal })
			if (bodyBytes) {
				await sock.write(bodyBytes, { signal })
			} else if (bodyIter) {
				await writeChunkedBody(data => sock.write(data, { signal }), bodyIter)
			}
			reader = tunnelReader(sock, signal)
		}

		const head = await readResponseHead(reader)
		if (!head) {
			await reader.close()
			throw new TypeError('tunnel.fetch: invalid HTTP response')
		}

		const te = head.headers.get('transfer-encoding')
		const cl = head.headers.get('content-length')
		const isChunked = te && te.toLowerCase().includes('chunked')
		const contentLength = cl !== null ? parseInt(cl, 10) : null
		if (isChunked) head.headers.delete('transfer-encoding')

		const body = bodyStream(reader, head.leftover, contentLength, isChunked)
		const chunks = []
		for await (const chunk of body) chunks.push(chunk)

		return new Response(concatChunks(chunks), {
			status: head.status,
			statusText: head.statusText,
			headers: head.headers,
			url: url.href,
		})
	}

	/**
	 * Start an HTTP server on the tunnel interface.
	 * Handler receives standard Request, returns Response (compatible with Hono).
	 *
	 * @param {number} port - Port to listen on
	 * @param {(request: Request) => Promise<Response>|Response} handler
	 * @param {Object} [options]
	 * @param {(err: Error) => void} [options.onError] - Error callback
	 * @returns {TunnelHttpServer}
	 */
	serve(port, handler, options) {
		return new TunnelHttpServer(this, port, handler, options)
	}

	/**
	 * Start a SOCKS5 proxy that routes external apps through this tunnel.
	 *
	 * @param {Object} [options]
	 * @param {number} [options.port=1080] - Local port (0 = random)
	 * @param {string} [options.host="127.0.0.1"] - Local bind address
	 * @returns {Promise<SocksProxy>}
	 */
	async socksProxy({ port = 1080, host = "127.0.0.1" } = {}) {
		const proxy = new SocksProxy(this)
		await proxy.listen(port, host)
		return proxy
	}

	/** Check if a peer has an active session */
	peerIsUp(peerIndex = 0) {
		return wgPeerIsUp(this.#tunnel, peerIndex)
	}

	/** Close the tunnel and all connections */
	close() {
		if (this.#destroyed) return
		this.#destroyed = true
		if (this.#timerHandle !== undefined)
			os.clearTimeout(this.#timerHandle)
		os.setReadHandler(this.#fd, null)
		wgClose(this.#tunnel)
		const waiters = this.#pumpWaiters
		this.#pumpWaiters = []
		for (const w of waiters) w()
	}
}

export class TunnelSocket {
	#wg
	#conn
	#closed = false
	#readBuf = new ArrayBuffer(65536)

	constructor(wg, conn) {
		this.#wg = wg
		this.#conn = conn
	}

	/**
	 * Write data through the tunnel.
	 *
	 * @param {Uint8Array} data
	 * @param {Object} [options]
	 * @param {AbortSignal} [options.signal]
	 */
	async write(data, { signal } = {}) {
		let offset = 0
		while (offset < data.byteLength) {
			if (signal?.aborted) throw signal.reason
			const state = wgTcpState(this.#conn)
			if (state !== WG_TCP_CONNECTED) throw new Error("WireGuard: connection closed")
			const n = wgTcpWrite(this.#conn, data.buffer, data.byteOffset + offset, data.byteLength - offset)
			if (n > 0) {
				offset += n
			} else {
				await this.#wg.waitForPump(signal)
			}
		}
	}

	/**
	 * Read data from the tunnel.
	 * Returns a Uint8Array with the data, or null on EOF.
	 *
	 * @param {Object} [options]
	 * @param {AbortSignal} [options.signal]
	 * @returns {Promise<Uint8Array|null>}
	 */
	async read({ signal } = {}) {
		for (;;) {
			if (signal?.aborted) throw signal.reason

			const n = wgTcpRead(this.#conn, this.#readBuf, 0, this.#readBuf.byteLength)
			if (n > 0) return new Uint8Array(this.#readBuf.slice(0, n))

			const state = wgTcpState(this.#conn)
			if (state === WG_TCP_CLOSED || state === WG_TCP_ERROR || state === WG_TCP_NONE)
				return null

			await this.#wg.waitForPump(signal)
		}
	}

	/** Number of bytes available to read without blocking */
	get readable() {
		return wgTcpReadable(this.#conn)
	}

	/** Current connection state */
	get state() {
		return wgTcpState(this.#conn)
	}

	/** Close this connection */
	close() {
		if (this.#closed) return
		this.#closed = true
		wgTcpClose(this.#conn)
	}
}

export class TunnelServer {
	#wg
	#listenerIndex
	#closed = false

	constructor(wg, listenerIndex) {
		this.#wg = wg
		this.#listenerIndex = listenerIndex
	}

	/**
	 * Accept the next incoming connection, waiting if necessary.
	 *
	 * @param {Object} [options]
	 * @param {AbortSignal} [options.signal]
	 * @param {number} [options.timeout=0] - Timeout in ms (0 = no timeout)
	 * @returns {Promise<TunnelSocket>}
	 */
	async accept({ signal, timeout = 0 } = {}) {
		const start = Date.now()
		for (;;) {
			if (signal?.aborted) throw signal.reason
			if (this.#closed) throw new Error("WireGuard: server closed")
			if (timeout > 0 && Date.now() - start > timeout)
				throw new Error("WireGuard: accept timed out")

			const conn = wgTcpAccept(this.#wg._tunnel, this.#listenerIndex)
			if (conn !== undefined)
				return new TunnelSocket(this.#wg, conn)

			await this.#wg.waitForPump(signal)
		}
	}

	/** Close the listener */
	close() {
		if (this.#closed) return
		this.#closed = true
		wgTcpUnlisten(this.#wg._tunnel, this.#listenerIndex)
	}
}

export class TunnelDgram {
	#wg
	#sockIndex
	#closed = false
	#recvBuf = new ArrayBuffer(1500)

	constructor(wg, sockIndex) {
		this.#wg = wg
		this.#sockIndex = sockIndex
	}

	/**
	 * Send a UDP datagram.
	 *
	 * @param {Uint8Array} data
	 * @param {string} address - Destination IP
	 * @param {number} port - Destination port
	 * @returns {number} bytes sent
	 */
	sendTo(data, address, port) {
		return wgUdpSendTo(
			this.#wg._tunnel, this.#sockIndex,
			data.buffer, data.byteOffset, data.byteLength,
			address, port,
		)
	}

	/**
	 * Receive a UDP datagram (non-blocking).
	 *
	 * @returns {{ data: Uint8Array, address: string, port: number } | null}
	 */
	recvFrom() {
		const result = wgUdpRecv(
			this.#wg._tunnel, this.#sockIndex,
			this.#recvBuf, 0, this.#recvBuf.byteLength,
		)
		if (result === undefined) return null
		return {
			data: new Uint8Array(this.#recvBuf.slice(0, result.n)),
			address: result.address,
			port: result.port,
		}
	}

	/**
	 * Wait for and receive a datagram.
	 *
	 * @param {Object} [options]
	 * @param {AbortSignal} [options.signal]
	 * @param {number} [options.timeout=0]
	 * @returns {Promise<{ data: Uint8Array, address: string, port: number }>}
	 */
	async recv({ signal, timeout = 0 } = {}) {
		const start = Date.now()
		for (;;) {
			if (signal?.aborted) throw signal.reason
			if (this.#closed) throw new Error("WireGuard: UDP socket closed")
			if (timeout > 0 && Date.now() - start > timeout)
				throw new Error("WireGuard: recv timed out")

			const result = this.recvFrom()
			if (result) return result

			await this.#wg.waitForPump(signal)
		}
	}

	/** Number of datagrams queued */
	get pending() {
		return wgUdpPending(this.#wg._tunnel, this.#sockIndex)
	}

	/** Close this UDP socket */
	close() {
		if (this.#closed) return
		this.#closed = true
		wgUdpClose(this.#wg._tunnel, this.#sockIndex)
	}
}

/**
 * Adapt a TunnelSocket into the reader interface used by HTTP parsing:
 * { read(buf, off, len) → Promise<number>, close() }
 */
function tunnelReader(sock, signal) {
	let leftover = null
	return {
		async read(buf, off, len) {
			if (leftover && leftover.length > 0) {
				const n = Math.min(leftover.length, len)
				new Uint8Array(buf, off, n).set(leftover.subarray(0, n))
				leftover = leftover.length > n ? leftover.subarray(n) : null
				return n
			}
			const data = await sock.read({ signal })
			if (!data) return 0
			const n = Math.min(data.length, len)
			new Uint8Array(buf, off, n).set(data.subarray(0, n))
			if (data.length > n) leftover = data.subarray(n)
			return n
		},
		close() {
			sock.close()
		},
	}
}

/**
 * HTTP server running on a WireGuard tunnel interface.
 * Accepts TCP connections, parses HTTP requests, calls a (Request) → Response handler.
 */
export class TunnelHttpServer {
	#tunnel
	#listener
	#handler
	#onError
	#closed = false
	#connections = new Set()

	/**
	 * @param {WireGuardTunnel} tunnel
	 * @param {number} port
	 * @param {(req: Request) => Response|Promise<Response>} handler
	 * @param {Object} [options]
	 * @param {(err: Error) => void} [options.onError]
	 */
	constructor(tunnel, port, handler, options) {
		this.#tunnel = tunnel
		this.#handler = handler
		this.#onError = options?.onError || null
		this.#listener = tunnel.listen(port)
		this.#acceptLoop()
	}

	async #acceptLoop() {
		while (!this.#closed) {
			let conn
			try {
				conn = await this.#listener.accept()
			} catch {
				break
			}
			this.#connections.add(conn)
			this.#handleConnection(conn)
		}
	}

	async #handleConnection(conn) {
		try {
			const reader = tunnelReader(conn, null)
			const head = await readRequestHead(reader)
			if (!head) { conn.close(); return }

			const host = head.headers['host'] || 'localhost'
			const url = `http://${host}${head.url}`
			const contentLength = parseInt(head.headers['content-length'], 10) || 0
			const te = head.headers['transfer-encoding']
			const isChunked = te && te.toLowerCase().includes('chunked')

			let body = null
			if (head.method !== 'GET' && head.method !== 'HEAD') {
				if (isChunked) {
					body = chunkedRequestBodyStream(reader, head.leftover)
				} else if (contentLength > 0) {
					body = requestBodyStream(reader, head.leftover, contentLength)
				}
			}

			const request = new Request(url, {
				method: head.method,
				headers: head.headers,
				body,
			})

			const response = await this.#handler(request)

			const status = response.status || 200
			const statusText = response.statusText || 'OK'
			const hasContentLength = response.headers.has('content-length')

			// If the response has a body stream and no content-length, use chunked TE
			const useChunked = response.body && !hasContentLength

			let respHead = `HTTP/1.1 ${status} ${statusText}\r\n`
			for (const [k, v] of response.headers) {
				respHead += `${k}: ${v}\r\n`
			}
			if (useChunked)
				respHead += 'transfer-encoding: chunked\r\n'
			respHead += 'connection: close\r\n\r\n'
			await conn.write(new TextEncoder().encode(respHead))

			if (response.body) {
				if (useChunked) {
					await writeChunkedBody(data => conn.write(data), response.body)
				} else {
					for await (const chunk of response.body) {
						const data = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
						await conn.write(data)
					}
				}
			}
		} catch (err) {
			if (this.#onError) this.#onError(err)
		} finally {
			conn.close()
			this.#connections.delete(conn)
		}
	}

	close() {
		if (this.#closed) return
		this.#closed = true
		this.#listener.close()
		for (const conn of this.#connections) conn.close()
		this.#connections.clear()
	}
}

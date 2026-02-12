/**
 * SOCKS5 proxy that routes TCP traffic through a WireGuard tunnel.
 * Imported by qn:wireguard — use tunnel.socksProxy() to create.
 */

import { createServer } from 'node:net'
import { getaddrinfo } from 'qn_socket'

const SOCKS_VERSION = 0x05
const AUTH_NONE = 0x00
const CMD_CONNECT = 0x01
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04
const REP_SUCCESS = 0x00
const REP_GENERAL_FAILURE = 0x01
const REP_CONN_REFUSED = 0x05
const REP_ADDR_NOT_SUPPORTED = 0x08

export class SocksProxy {
	#tunnel
	#server
	#connections = new Set()

	constructor(tunnel) {
		this.#tunnel = tunnel
		this.#server = createServer(socket => this.#handleClient(socket))
	}

	listen(port, host) {
		return new Promise((resolve, reject) => {
			this.#server.on('error', reject)
			this.#server.listen(port, host, () => {
				this.#server.removeListener('error', reject)
				resolve()
			})
		})
	}

	address() {
		return this.#server.address()
	}

	close() {
		for (const conn of this.#connections) {
			conn.tunnelSocket?.close()
			conn.localSocket.destroy()
		}
		this.#connections.clear()
		this.#server.close()
	}

	#handleClient(socket) {
		const conn = { localSocket: socket, tunnelSocket: null }
		this.#connections.add(conn)

		let buf = new Uint8Array(0)
		let state = 'greeting' // greeting -> request -> bridging

		socket.on('data', chunk => {
			if (state === 'bridging') return // shouldn't happen, read handler replaced
			buf = concat(buf, chunk)
			this.#process(conn, () => buf, b => { buf = b }, () => state, s => { state = s })
		})

		socket.on('error', () => this.#cleanup(conn))
		socket.on('close', () => this.#cleanup(conn))
	}

	#process(conn, getBuf, setBuf, getState, setState) {
		const buf = getBuf()
		const state = getState()

		if (state === 'greeting') {
			// Need at least 2 bytes: version + nmethods
			if (buf.length < 2) return
			if (buf[0] !== SOCKS_VERSION) {
				conn.localSocket.destroy()
				return
			}
			const nmethods = buf[1]
			if (buf.length < 2 + nmethods) return

			// We only support no-auth; check if client offers it
			let hasNoAuth = false
			for (let i = 0; i < nmethods; i++) {
				if (buf[2 + i] === AUTH_NONE) hasNoAuth = true
			}
			if (!hasNoAuth) {
				conn.localSocket.write(new Uint8Array([SOCKS_VERSION, 0xFF]))
				conn.localSocket.destroy()
				return
			}

			conn.localSocket.write(new Uint8Array([SOCKS_VERSION, AUTH_NONE]))
			setBuf(buf.subarray(2 + nmethods))
			setState('request')
			// Process remaining bytes
			this.#process(conn, getBuf, setBuf, getState, setState)
			return
		}

		if (state === 'request') {
			// Minimum: ver(1) + cmd(1) + rsv(1) + atyp(1) + addr(variable) + port(2)
			if (buf.length < 4) return

			if (buf[0] !== SOCKS_VERSION || buf[2] !== 0x00) {
				this.#sendReply(conn, REP_GENERAL_FAILURE)
				conn.localSocket.destroy()
				return
			}

			const cmd = buf[1]
			if (cmd !== CMD_CONNECT) {
				this.#sendReply(conn, REP_GENERAL_FAILURE)
				conn.localSocket.destroy()
				return
			}

			const atyp = buf[3]
			let host, port, headerLen

			if (atyp === ATYP_IPV4) {
				if (buf.length < 10) return
				host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
				port = (buf[8] << 8) | buf[9]
				headerLen = 10
			} else if (atyp === ATYP_DOMAIN) {
				if (buf.length < 5) return
				const domainLen = buf[4]
				if (buf.length < 5 + domainLen + 2) return
				const domain = new TextDecoder().decode(buf.subarray(5, 5 + domainLen))
				port = (buf[5 + domainLen] << 8) | buf[5 + domainLen + 1]
				headerLen = 5 + domainLen + 2
				// Resolve domain locally
				host = resolveDomain(domain)
				if (!host) {
					this.#sendReply(conn, REP_GENERAL_FAILURE)
					conn.localSocket.destroy()
					return
				}
			} else if (atyp === ATYP_IPV6) {
				this.#sendReply(conn, REP_ADDR_NOT_SUPPORTED)
				conn.localSocket.destroy()
				return
			} else {
				this.#sendReply(conn, REP_GENERAL_FAILURE)
				conn.localSocket.destroy()
				return
			}

			const remaining = buf.subarray(headerLen)
			setBuf(remaining)
			setState('bridging')

			this.#connectAndBridge(conn, host, port, remaining)
		}
	}

	async #connectAndBridge(conn, host, port, initialData) {
		let tunnelSocket
		try {
			tunnelSocket = await this.#tunnel.connect(host, port)
		} catch {
			this.#sendReply(conn, REP_CONN_REFUSED)
			conn.localSocket.destroy()
			return
		}

		conn.tunnelSocket = tunnelSocket
		this.#sendReply(conn, REP_SUCCESS)

		// Bridge: local → tunnel (serialized writes to prevent interleaving)
		let writeQueue = initialData.length > 0 ? Promise.resolve(initialData) : null
		const enqueueWrite = (data) => {
			const doWrite = async () => {
				try { await tunnelSocket.write(new Uint8Array(data)) }
				catch { this.#cleanup(conn) }
			}
			writeQueue = writeQueue ? writeQueue.then(doWrite) : doWrite()
		}

		if (initialData.length > 0) {
			writeQueue = tunnelSocket.write(initialData).catch(() => this.#cleanup(conn))
		}

		conn.localSocket.on('data', chunk => enqueueWrite(chunk))
		conn.localSocket.on('end', () => {
			const close = () => tunnelSocket.close()
			writeQueue ? writeQueue.then(close) : close()
		})

		// Bridge: tunnel → local
		this.#readLoop(conn)
	}

	async #readLoop(conn) {
		try {
			let chunk
			while ((chunk = await conn.tunnelSocket.read()) !== null) {
				if (conn.localSocket.readyState !== 'open') break
				const ok = conn.localSocket.write(chunk)
				if (!ok) {
					// Backpressure: wait for drain
					await new Promise(resolve => conn.localSocket.once('drain', resolve))
				}
			}
		} catch {
			// tunnel read error
		}
		this.#cleanup(conn)
	}

	#sendReply(conn, rep) {
		// reply: ver(5) rep rsv(0) atyp(IPv4) addr(0.0.0.0) port(0)
		conn.localSocket.write(new Uint8Array([
			SOCKS_VERSION, rep, 0x00, ATYP_IPV4,
			0, 0, 0, 0,
			0, 0,
		]))
	}

	#cleanup(conn) {
		if (!this.#connections.has(conn)) return
		this.#connections.delete(conn)
		conn.tunnelSocket?.close()
		conn.localSocket.destroy()
	}
}

function concat(a, b) {
	if (a.length === 0) return new Uint8Array(b)
	const result = new Uint8Array(a.length + b.length)
	result.set(a)
	result.set(new Uint8Array(b), a.length)
	return result
}

function resolveDomain(domain) {
	try {
		const results = getaddrinfo(domain)
		if (results && results.length > 0) return results[0].address
	} catch {}
	return null
}

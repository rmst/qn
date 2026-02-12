import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { testQnOnly, $, execAsync, QN } from './util.js'

const testDir = path.dirname(new URL(import.meta.url).pathname)
const tunnelCertFile = path.join(testDir, 'fixtures', 'tunnel-cert.pem')
const tunnelKeyFile = path.join(testDir, 'fixtures', 'tunnel-key.pem')

describe('qn:wireguard', () => {
	testQnOnly('exports state constants', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { WG_TCP_NONE, WG_TCP_CONNECTING, WG_TCP_CONNECTED, WG_TCP_CLOSING, WG_TCP_CLOSED, WG_TCP_ERROR } from 'qn:wireguard'
			console.log(JSON.stringify({
				WG_TCP_NONE, WG_TCP_CONNECTING, WG_TCP_CONNECTED,
				WG_TCP_CLOSING, WG_TCP_CLOSED, WG_TCP_ERROR,
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		const consts = JSON.parse(output)
		// Values must be distinct integers
		const values = Object.values(consts)
		assert.strictEqual(values.length, 6)
		assert.strictEqual(new Set(values).size, 6)
		for (const v of values) assert.strictEqual(typeof v, 'number')
		// Specific expected values from the C enum
		assert.strictEqual(consts.WG_TCP_NONE, 0)
		assert.strictEqual(consts.WG_TCP_CONNECTING, 1)
		assert.strictEqual(consts.WG_TCP_CONNECTED, 2)
	})

	testQnOnly('exports WireGuardTunnel class', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { WireGuardTunnel } from 'qn:wireguard'
			console.log(JSON.stringify({ type: typeof WireGuardTunnel }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { type: 'function' })
	})

	testQnOnly('low-level: create and close tunnel', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import {
				wgCreateTunnel, wgGetFd, wgPeerIsUp,
				wgProcessInput, wgCheckTimeouts, wgClose,
			} from 'qn_wireguard'

			const tunnel = wgCreateTunnel("YNqHbfBQKaGvlC4hHNFLhGn6gSVSCFBkZMhLYh9vI0k=", "10.0.0.2", "255.255.255.0", null, 0)
			const fd = wgGetFd(tunnel)
			const peerUp = wgPeerIsUp(tunnel, 0)
			const processed = wgProcessInput(tunnel)
			wgCheckTimeouts(tunnel)
			wgClose(tunnel)

			console.log(JSON.stringify({ fdValid: fd >= 0, peerUp, processed }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			fdValid: true,
			peerUp: false,
			processed: 0,
		})
	})

	testQnOnly('WireGuardTunnel class: create, inspect, close', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { WireGuardTunnel } from 'qn:wireguard'

			const tunnel = new WireGuardTunnel({
				privateKey: "YNqHbfBQKaGvlC4hHNFLhGn6gSVSCFBkZMhLYh9vI0k=",
				address: "10.0.0.2",
			})

			const fd = tunnel.fd
			const hasPeers = Object.keys(tunnel.peers).length === 0

			// Let the event loop tick once to verify timers don't crash
			setTimeout(() => {
				tunnel.close()
				// closing again should be a no-op
				tunnel.close()
				console.log(JSON.stringify({ fdValid: fd >= 0, hasPeers }))
			}, 60)
		`)
		const output = $({ timeout: 5000 })`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			fdValid: true,
			hasPeers: true,
		})
	})

	testQnOnly('invalid private key throws', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { wgCreateTunnel } from 'qn_wireguard'
			let threw = false
			try {
				wgCreateTunnel("not-a-valid-key", "10.0.0.2", "255.255.255.0", null, 0)
			} catch {
				threw = true
			}
			console.log(JSON.stringify({ threw }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { threw: true })
	})

	testQnOnly('listen/accept: basic', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { wgCreateTunnel, wgTcpListen, wgTcpAccept, wgTcpUnlisten, wgClose } from 'qn_wireguard'

			const tunnel = wgCreateTunnel("YNqHbfBQKaGvlC4hHNFLhGn6gSVSCFBkZMhLYh9vI0k=", "10.0.0.2", "255.255.255.0", null, 0)
			const li = wgTcpListen(tunnel, 8080)
			const noConn = wgTcpAccept(tunnel, li)
			wgTcpUnlisten(tunnel, li)
			wgClose(tunnel)
			console.log(JSON.stringify({ li: li >= 0, noConn: noConn === undefined }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { li: true, noConn: true })
	})

	testQnOnly('udp: bind and close', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			import { wgCreateTunnel, wgUdpBind, wgUdpPending, wgUdpClose, wgClose } from 'qn_wireguard'

			const tunnel = wgCreateTunnel("YNqHbfBQKaGvlC4hHNFLhGn6gSVSCFBkZMhLYh9vI0k=", "10.0.0.2", "255.255.255.0", null, 0)
			const si = wgUdpBind(tunnel, 5353)
			const pending = wgUdpPending(tunnel, si)
			wgUdpClose(tunnel, si)
			wgClose(tunnel)
			console.log(JSON.stringify({ si: si >= 0, pending }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { si: true, pending: 0 })
	})

	testQnOnly('two tunnels: TCP echo through WireGuard', async ({ bin, dir }) => {
		const PRIV_A = "4N9+QQTiIy3jLeBh9esGoECGfUXU383qOOSiQ3/vlEY="
		const PUB_A  = "1n+AWoDIGkuKQDkYf5bEn3p415Xc4r9vpxrDCWQ60FU="
		const PRIV_B = "ABmangI2LTOsUk8Dh93vjlMEfqCmQ2TUFAOXexemvEk="
		const PUB_B  = "HPBqprmBFlWl160jaW4rYYcEk25peXvyVpNwkj0/jx8="

		const portFile = `${dir}/port`

		// Server (tunnel A at 10.0.0.1): listen on TCP 7777, accept, echo, exit
		writeFileSync(`${dir}/server.js`, `
			import { writeFileSync } from 'node:fs'
			import {
				wgCreateTunnel, wgGetFd, wgAddPeer,
				wgTcpListen, wgTcpAccept, wgTcpRead, wgTcpWrite, wgTcpClose,
				wgProcessInput, wgCheckTimeouts, wgClose,
			} from 'qn_wireguard'
			import * as os from 'os'

			let tunnel, fd, udpPort
			for (udpPort = 51820; udpPort < 51920; udpPort++) {
				try {
					tunnel = wgCreateTunnel(${JSON.stringify(PRIV_A)}, "10.0.0.1", "255.255.255.0", null, udpPort)
					fd = wgGetFd(tunnel)
					break
				} catch { continue }
			}
			if (!tunnel) { console.error("no free port"); process.exit(1) }

			wgAddPeer(tunnel, ${JSON.stringify(PUB_B)}, null, "127.0.0.1", 0, "0.0.0.0", "0.0.0.0", 0)
			const li = wgTcpListen(tunnel, 7777)

			writeFileSync(${JSON.stringify(portFile)}, String(udpPort))

			const buf = new ArrayBuffer(4096)
			const pump = () => { wgProcessInput(tunnel); wgCheckTimeouts(tunnel) }
			os.setReadHandler(fd, pump)

			const tick = () => {
				pump()
				const conn = wgTcpAccept(tunnel, li)
				if (conn !== undefined) {
					const readLoop = () => {
						pump()
						const n = wgTcpRead(conn, buf, 0, 4096)
						if (n > 0) {
							wgTcpWrite(conn, buf, 0, n)
							// Give time for the echo to be sent
							os.setTimeout(() => {
								wgTcpClose(conn)
								os.setReadHandler(fd, null)
								wgClose(tunnel)
								process.exit(0)
							}, 200)
							return
						}
						os.setTimeout(readLoop, 10)
					}
					readLoop()
					return
				}
				os.setTimeout(tick, 50)
			}
			tick()

			os.setTimeout(() => { os.setReadHandler(fd, null); wgClose(tunnel); process.exit(1) }, 10000)
		`)

		// Client (tunnel B at 10.0.0.2): connect to A, send msg, read echo, exit
		writeFileSync(`${dir}/client.js`, `
			import { readFileSync, existsSync } from 'node:fs'
			import {
				wgCreateTunnel, wgGetFd, wgAddPeer, wgConnect, wgPeerIsUp,
				wgTcpConnect, wgTcpState, wgTcpWrite, wgTcpRead, wgTcpClose,
				wgProcessInput, wgCheckTimeouts, wgClose,
				WG_TCP_CONNECTING, WG_TCP_CONNECTED,
			} from 'qn_wireguard'
			import * as os from 'os'

			// Poll for port file
			let serverPort
			for (let i = 0; i < 200; i++) {
				try { serverPort = parseInt(readFileSync(${JSON.stringify(portFile)}, 'utf8')); break }
				catch { const s = Date.now(); while (Date.now() - s < 25) {} }
			}
			if (!serverPort) { console.error("no port file"); process.exit(1) }

			const tunnel = wgCreateTunnel(${JSON.stringify(PRIV_B)}, "10.0.0.2", "255.255.255.0", null, 0)
			const fd = wgGetFd(tunnel)
			const pi = wgAddPeer(tunnel, ${JSON.stringify(PUB_A)}, null,
				"127.0.0.1", serverPort, "0.0.0.0", "0.0.0.0", 0)
			wgConnect(tunnel, pi)

			const buf = new ArrayBuffer(4096)
			const pump = () => { wgProcessInput(tunnel); wgCheckTimeouts(tunnel) }
			os.setReadHandler(fd, pump)

			const exit = (result) => {
				os.setReadHandler(fd, null)
				wgClose(tunnel)
				console.log(JSON.stringify(result))
				process.exit(result.error ? 1 : 0)
			}

			const step = () => {
				pump()
				if (!wgPeerIsUp(tunnel, pi)) { os.setTimeout(step, 50); return }

				const conn = wgTcpConnect(tunnel, "10.0.0.1", 7777)
				const waitConn = () => {
					pump()
					const st = wgTcpState(conn)
					if (st === WG_TCP_CONNECTING) { os.setTimeout(waitConn, 10); return }
					if (st !== WG_TCP_CONNECTED) { exit({ error: "connect failed", state: st }); return }

					const msg = new TextEncoder().encode("hello wireguard")
					wgTcpWrite(conn, msg.buffer, 0, msg.byteLength)

					const waitEcho = () => {
						pump()
						const n = wgTcpRead(conn, buf, 0, 4096)
						if (n <= 0) { os.setTimeout(waitEcho, 10); return }
						const echo = new TextDecoder().decode(new Uint8Array(buf, 0, n))
						wgTcpClose(conn)
						exit({ echo })
					}
					waitEcho()
				}
				waitConn()
			}
			step()

			os.setTimeout(() => exit({ error: "timeout" }), 10000)
		`)

		// Start server, then client
		const serverP = execAsync(bin, [`${dir}/server.js`])
		const clientOutput = await execAsync(bin, [`${dir}/client.js`])
		const result = JSON.parse(clientOutput)
		assert.strictEqual(result.echo, "hello wireguard")
		await serverP
	})

	testQnOnly('SOCKS5 proxy through WireGuard tunnel', async ({ bin, dir }) => {
		const PRIV_A = "4N9+QQTiIy3jLeBh9esGoECGfUXU383qOOSiQ3/vlEY="
		const PUB_A  = "1n+AWoDIGkuKQDkYf5bEn3p415Xc4r9vpxrDCWQ60FU="
		const PRIV_B = "ABmangI2LTOsUk8Dh93vjlMEfqCmQ2TUFAOXexemvEk="
		const PUB_B  = "HPBqprmBFlWl160jaW4rYYcEk25peXvyVpNwkj0/jx8="

		const portFile = `${dir}/port`
		const socksPortFile = `${dir}/socks-port`

		// Server (tunnel B at 10.0.0.2): TCP echo on port 7777
		writeFileSync(`${dir}/server.js`, `
			import { writeFileSync, readFileSync } from 'node:fs'
			import { WireGuardTunnel } from 'qn:wireguard'
			import * as os from 'os'

			let tunnel, udpPort
			for (udpPort = 52100; udpPort < 52200; udpPort++) {
				try {
					tunnel = new WireGuardTunnel({
						privateKey: ${JSON.stringify(PRIV_B)},
						address: "10.0.0.2",
						listenPort: udpPort,
					})
					break
				} catch { continue }
			}
			if (!tunnel) { console.error("no free port"); process.exit(1) }
			tunnel.peers[${JSON.stringify(PUB_A)}] = {}

			writeFileSync(${JSON.stringify(portFile)}, String(udpPort))

			const listener = tunnel.listen(7777)
			await tunnel.waitForPeer(${JSON.stringify(PUB_A)})

			const conn = await listener.accept({ timeout: 10000 })
			const data = await conn.read()
			if (data) await conn.write(data)
			// Give time for data to be sent
			await new Promise(r => os.setTimeout(r, 200))
			conn.close()
			listener.close()
			tunnel.close()
		`)

		// SOCKS proxy (tunnel A at 10.0.0.1): proxy to tunnel network
		writeFileSync(`${dir}/proxy.js`, `
			import { readFileSync, writeFileSync } from 'node:fs'
			import { WireGuardTunnel } from 'qn:wireguard'
			import * as os from 'os'

			// Wait for server port
			let serverPort
			for (let i = 0; i < 200; i++) {
				try { serverPort = parseInt(readFileSync(${JSON.stringify(portFile)}, 'utf8')); break }
				catch { const s = Date.now(); while (Date.now() - s < 25) {} }
			}
			if (!serverPort) { console.error("no port file"); process.exit(1) }

			const tunnel = new WireGuardTunnel({
				privateKey: ${JSON.stringify(PRIV_A)},
				address: "10.0.0.1",
			})
			tunnel.peers[${JSON.stringify(PUB_B)}] = {
				endpoint: "127.0.0.1",
				endpointPort: serverPort,
			}

			await tunnel.waitForPeer(${JSON.stringify(PUB_B)})
			const proxy = await tunnel.socksProxy({ port: 0 })
			const addr = proxy.address()
			writeFileSync(${JSON.stringify(socksPortFile)}, String(addr.port))

			// Keep alive, exit after timeout
			os.setTimeout(() => {
				proxy.close()
				tunnel.close()
				process.exit(0)
			}, 15000)
		`)

		// Client: connect through SOCKS proxy using raw TCP
		writeFileSync(`${dir}/client.js`, `
			import { readFileSync } from 'node:fs'
			import { createConnection } from 'node:net'

			// Wait for socks port
			let socksPort
			for (let i = 0; i < 200; i++) {
				try { socksPort = parseInt(readFileSync(${JSON.stringify(socksPortFile)}, 'utf8')); break }
				catch { const s = Date.now(); while (Date.now() - s < 25) {} }
			}
			if (!socksPort) { console.error("no socks port file"); process.exit(1) }

			const sock = createConnection(socksPort, "127.0.0.1", () => {
				// SOCKS5 greeting: version 5, 1 method, no-auth
				sock.write(new Uint8Array([0x05, 0x01, 0x00]))
			})

			let phase = 'greeting'
			let chunks = []

			sock.on('data', (data) => {
				const buf = new Uint8Array(data.buffer || data)
				if (phase === 'greeting') {
					// Expect: 05 00 (no auth)
					if (buf[0] !== 0x05 || buf[1] !== 0x00) {
						console.log(JSON.stringify({ error: "bad greeting response" }))
						process.exit(1)
					}
					phase = 'request'
					// SOCKS5 CONNECT to 10.0.0.2:7777
					// ver(5) cmd(1=connect) rsv(0) atyp(1=ipv4) addr(10.0.0.2) port(7777)
					const port = 7777
					sock.write(new Uint8Array([
						0x05, 0x01, 0x00, 0x01,
						10, 0, 0, 2,
						(port >> 8) & 0xff, port & 0xff,
					]))
				} else if (phase === 'request') {
					if (buf[0] !== 0x05 || buf[1] !== 0x00) {
						console.log(JSON.stringify({ error: "connect failed", rep: buf[1] }))
						process.exit(1)
					}
					phase = 'data'
					sock.write(new TextEncoder().encode("socks hello"))
				} else if (phase === 'data') {
					chunks.push(buf)
					const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0))
					let off = 0
					for (const c of chunks) { all.set(c, off); off += c.length }
					const text = new TextDecoder().decode(all)
					if (text.length >= 11) {
						console.log(JSON.stringify({ echo: text }))
						sock.end()
						process.exit(0)
					}
				}
			})

			sock.on('error', (err) => {
				console.log(JSON.stringify({ error: err.message }))
				process.exit(1)
			})

			setTimeout(() => {
				console.log(JSON.stringify({ error: "timeout" }))
				process.exit(1)
			}, 12000)
		`)

		// Start server, then proxy, then client
		const serverP = execAsync(bin, [`${dir}/server.js`])
		const proxyP = execAsync(bin, [`${dir}/proxy.js`])
		const clientOutput = await execAsync(bin, [`${dir}/client.js`])
		const result = JSON.parse(clientOutput)
		assert.strictEqual(result.echo, "socks hello")
		// Clean up: server should exit on its own, proxy will timeout
		await serverP
		proxyP.then(() => {}, () => {}) // ignore proxy exit
	})

	testQnOnly('tunnel.serve() and tunnel.fetch()', async ({ bin, dir }) => {
		const PRIV_A = "4N9+QQTiIy3jLeBh9esGoECGfUXU383qOOSiQ3/vlEY="
		const PUB_A  = "1n+AWoDIGkuKQDkYf5bEn3p415Xc4r9vpxrDCWQ60FU="
		const PRIV_B = "ABmangI2LTOsUk8Dh93vjlMEfqCmQ2TUFAOXexemvEk="
		const PUB_B  = "HPBqprmBFlWl160jaW4rYYcEk25peXvyVpNwkj0/jx8="

		const portFile = `${dir}/port`

		// Server (tunnel B at 10.0.0.2): HTTP server via tunnel.serve()
		writeFileSync(`${dir}/server.js`, `
			import { writeFileSync } from 'node:fs'
			import { WireGuardTunnel } from 'qn:wireguard'
			import * as os from 'os'

			let tunnel, udpPort
			for (udpPort = 52300; udpPort < 52400; udpPort++) {
				try {
					tunnel = new WireGuardTunnel({
						privateKey: ${JSON.stringify(PRIV_B)},
						address: "10.0.0.2",
						listenPort: udpPort,
					})
					break
				} catch { continue }
			}
			if (!tunnel) { console.error("no free port"); process.exit(1) }
			tunnel.peers[${JSON.stringify(PUB_A)}] = {}

			const httpServer = tunnel.serve(8080, async (req) => {
				const url = new URL(req.url)
				if (url.pathname === '/echo') {
					const body = req.body ? await req.text() : ''
					return new Response('echo:' + body, {
						headers: { 'content-type': 'text/plain' },
					})
				}
				return new Response(JSON.stringify({ method: req.method, path: url.pathname }), {
					headers: { 'content-type': 'application/json' },
				})
			})

			writeFileSync(${JSON.stringify(portFile)}, String(udpPort))

			// Exit after test completes
			os.setTimeout(() => {
				httpServer.close()
				tunnel.close()
				process.exit(0)
			}, 12000)
		`)

		// Client (tunnel A at 10.0.0.1): use tunnel.fetch()
		writeFileSync(`${dir}/client.js`, `
			import { readFileSync } from 'node:fs'
			import { WireGuardTunnel } from 'qn:wireguard'

			let serverPort
			for (let i = 0; i < 200; i++) {
				try { serverPort = parseInt(readFileSync(${JSON.stringify(portFile)}, 'utf8')); break }
				catch { const s = Date.now(); while (Date.now() - s < 25) {} }
			}
			if (!serverPort) { console.error("no port file"); process.exit(1) }

			const tunnel = new WireGuardTunnel({
				privateKey: ${JSON.stringify(PRIV_A)},
				address: "10.0.0.1",
			})
			tunnel.peers[${JSON.stringify(PUB_B)}] = {
				endpoint: "127.0.0.1",
				endpointPort: serverPort,
			}

			await tunnel.waitForPeer(${JSON.stringify(PUB_B)})

			// Test GET
			const resp1 = await tunnel.fetch("http://10.0.0.2:8080/hello")
			const json = await resp1.json()

			// Test POST with body
			const resp2 = await tunnel.fetch("http://10.0.0.2:8080/echo", {
				method: "POST",
				body: "test body",
			})
			const echoText = await resp2.text()

			tunnel.close()
			console.log(JSON.stringify({
				status1: resp1.status,
				method: json.method,
				path: json.path,
				status2: resp2.status,
				echo: echoText,
			}))
		`)

		const serverP = execAsync(bin, [`${dir}/server.js`])
		const clientOutput = await execAsync(bin, [`${dir}/client.js`])
		const result = JSON.parse(clientOutput)
		assert.strictEqual(result.status1, 200)
		assert.strictEqual(result.method, "GET")
		assert.strictEqual(result.path, "/hello")
		assert.strictEqual(result.status2, 200)
		assert.strictEqual(result.echo, "echo:test body")
		serverP.then(() => {}, () => {})
	})

	testQnOnly('streaming: chunked response and async iterable request body', async ({ bin, dir }) => {
		const PRIV_A = "4N9+QQTiIy3jLeBh9esGoECGfUXU383qOOSiQ3/vlEY="
		const PUB_A  = "1n+AWoDIGkuKQDkYf5bEn3p415Xc4r9vpxrDCWQ60FU="
		const PRIV_B = "ABmangI2LTOsUk8Dh93vjlMEfqCmQ2TUFAOXexemvEk="
		const PUB_B  = "HPBqprmBFlWl160jaW4rYYcEk25peXvyVpNwkj0/jx8="

		const portFile = `${dir}/port`

		// Server: streams back 3 chunks, and echoes a streamed request body
		writeFileSync(`${dir}/server.js`, `
			import { writeFileSync } from 'node:fs'
			import { WireGuardTunnel } from 'qn:wireguard'
			import * as os from 'os'

			let tunnel, udpPort
			for (udpPort = 52400; udpPort < 52500; udpPort++) {
				try {
					tunnel = new WireGuardTunnel({
						privateKey: ${JSON.stringify(PRIV_B)},
						address: "10.0.0.2",
						listenPort: udpPort,
					})
					break
				} catch { continue }
			}
			if (!tunnel) { console.error("no free port"); process.exit(1) }
			tunnel.peers[${JSON.stringify(PUB_A)}] = {}

			const httpServer = tunnel.serve(8080, async (req) => {
				const url = new URL(req.url)

				if (url.pathname === '/stream') {
					// Return a streaming response (async iterable, no content-length)
					async function* chunks() {
						yield new TextEncoder().encode('chunk1,')
						yield new TextEncoder().encode('chunk2,')
						yield new TextEncoder().encode('chunk3')
					}
					return new Response(chunks(), {
						headers: { 'content-type': 'text/plain' },
					})
				}

				if (url.pathname === '/echo-stream') {
					// Read streaming request body and echo it
					const body = await req.text()
					return new Response('got:' + body, {
						headers: { 'content-type': 'text/plain' },
					})
				}

				return new Response('not found', { status: 404 })
			})

			writeFileSync(${JSON.stringify(portFile)}, String(udpPort))
			os.setTimeout(() => { httpServer.close(); tunnel.close(); process.exit(0) }, 12000)
		`)

		// Client: test streaming response + streaming request body
		writeFileSync(`${dir}/client.js`, `
			import { readFileSync } from 'node:fs'
			import { WireGuardTunnel } from 'qn:wireguard'

			let serverPort
			for (let i = 0; i < 200; i++) {
				try { serverPort = parseInt(readFileSync(${JSON.stringify(portFile)}, 'utf8')); break }
				catch { const s = Date.now(); while (Date.now() - s < 25) {} }
			}
			if (!serverPort) { console.error("no port file"); process.exit(1) }

			const tunnel = new WireGuardTunnel({
				privateKey: ${JSON.stringify(PRIV_A)},
				address: "10.0.0.1",
			})
			tunnel.peers[${JSON.stringify(PUB_B)}] = {
				endpoint: "127.0.0.1",
				endpointPort: serverPort,
			}

			await tunnel.waitForPeer(${JSON.stringify(PUB_B)})

			// Test 1: streaming response (server sends chunks, no content-length)
			const resp1 = await tunnel.fetch("http://10.0.0.2:8080/stream")
			const streamedText = await resp1.text()

			// Test 2: streaming request body (async iterable)
			async function* bodyChunks() {
				yield new TextEncoder().encode('part1-')
				yield new TextEncoder().encode('part2-')
				yield new TextEncoder().encode('part3')
			}
			const resp2 = await tunnel.fetch("http://10.0.0.2:8080/echo-stream", {
				method: "POST",
				body: bodyChunks(),
			})
			const echoText = await resp2.text()

			tunnel.close()
			console.log(JSON.stringify({
				streamed: streamedText,
				echo: echoText,
			}))
		`)

		const serverP = execAsync(bin, [`${dir}/server.js`])
		const clientOutput = await execAsync(bin, [`${dir}/client.js`])
		const result = JSON.parse(clientOutput)
		assert.strictEqual(result.streamed, "chunk1,chunk2,chunk3")
		assert.strictEqual(result.echo, "got:part1-part2-part3")
		serverP.then(() => {}, () => {})
	})

	testQnOnly('connection slot recycling: 20 sequential TCP connections', async ({ bin, dir }) => {
		const PRIV_A = "4N9+QQTiIy3jLeBh9esGoECGfUXU383qOOSiQ3/vlEY="
		const PUB_A  = "1n+AWoDIGkuKQDkYf5bEn3p415Xc4r9vpxrDCWQ60FU="
		const PRIV_B = "ABmangI2LTOsUk8Dh93vjlMEfqCmQ2TUFAOXexemvEk="
		const PUB_B  = "HPBqprmBFlWl160jaW4rYYcEk25peXvyVpNwkj0/jx8="

		const portFile = `${dir}/port`
		const NUM_CONNS = 20  // exceeds WG_MAX_TCP_CONNS (16)

		// Server (tunnel B): accept 20 connections, echo data, close each
		writeFileSync(`${dir}/server.js`, `
			import { writeFileSync } from 'node:fs'
			import { WireGuardTunnel } from 'qn:wireguard'
			import * as os from 'os'

			let tunnel, udpPort
			for (udpPort = 52500; udpPort < 52600; udpPort++) {
				try {
					tunnel = new WireGuardTunnel({
						privateKey: ${JSON.stringify(PRIV_B)},
						address: "10.0.0.2",
						listenPort: udpPort,
					})
					break
				} catch { continue }
			}
			if (!tunnel) { console.error("no free port"); process.exit(1) }
			tunnel.peers[${JSON.stringify(PUB_A)}] = {}

			const listener = tunnel.listen(7777)
			writeFileSync(${JSON.stringify(portFile)}, String(udpPort))

			for (let i = 0; i < ${NUM_CONNS}; i++) {
				const conn = await listener.accept({ timeout: 10000 })
				const data = await conn.read()
				if (data) await conn.write(data)
				await new Promise(r => os.setTimeout(r, 50))
				conn.close()
			}

			listener.close()
			tunnel.close()
		`)

		// Client (tunnel A): open 20 sequential connections, verify echo
		writeFileSync(`${dir}/client.js`, `
			import { readFileSync } from 'node:fs'
			import { WireGuardTunnel } from 'qn:wireguard'
			import * as os from 'os'

			let serverPort
			for (let i = 0; i < 200; i++) {
				try { serverPort = parseInt(readFileSync(${JSON.stringify(portFile)}, 'utf8')); break }
				catch { const s = Date.now(); while (Date.now() - s < 25) {} }
			}
			if (!serverPort) { console.error("no port file"); process.exit(1) }

			const tunnel = new WireGuardTunnel({
				privateKey: ${JSON.stringify(PRIV_A)},
				address: "10.0.0.1",
			})
			tunnel.peers[${JSON.stringify(PUB_B)}] = {
				endpoint: "127.0.0.1",
				endpointPort: serverPort,
			}

			await tunnel.waitForPeer(${JSON.stringify(PUB_B)})

			const results = []
			for (let i = 0; i < ${NUM_CONNS}; i++) {
				const sock = await tunnel.connect("10.0.0.2", 7777)
				const msg = new TextEncoder().encode("msg-" + i)
				await sock.write(msg)
				const data = await sock.read()
				results.push(data ? new TextDecoder().decode(data) : null)
				sock.close()
				await new Promise(r => os.setTimeout(r, 50))
			}

			tunnel.close()
			console.log(JSON.stringify({
				count: results.length,
				allOk: results.every((r, i) => r === "msg-" + i),
				first: results[0],
				last: results[results.length - 1],
			}))
		`)

		const serverP = execAsync(bin, [`${dir}/server.js`])
		const clientOutput = await execAsync(bin, [`${dir}/client.js`])
		const result = JSON.parse(clientOutput)
		assert.strictEqual(result.count, NUM_CONNS)
		assert.strictEqual(result.allOk, true)
		assert.strictEqual(result.first, "msg-0")
		assert.strictEqual(result.last, `msg-${NUM_CONNS - 1}`)
		await serverP
	})

	testQnOnly('large data transfer and sequential HTTP requests', async ({ bin, dir }) => {
		const PRIV_A = "4N9+QQTiIy3jLeBh9esGoECGfUXU383qOOSiQ3/vlEY="
		const PUB_A  = "1n+AWoDIGkuKQDkYf5bEn3p415Xc4r9vpxrDCWQ60FU="
		const PRIV_B = "ABmangI2LTOsUk8Dh93vjlMEfqCmQ2TUFAOXexemvEk="
		const PUB_B  = "HPBqprmBFlWl160jaW4rYYcEk25peXvyVpNwkj0/jx8="

		const portFile = `${dir}/port`

		// Server: HTTP server that echoes body stats and handles sequential requests
		writeFileSync(`${dir}/server.js`, `
			import { writeFileSync } from 'node:fs'
			import { WireGuardTunnel } from 'qn:wireguard'
			import * as os from 'os'

			let tunnel, udpPort
			for (udpPort = 52600; udpPort < 52700; udpPort++) {
				try {
					tunnel = new WireGuardTunnel({
						privateKey: ${JSON.stringify(PRIV_B)},
						address: "10.0.0.2",
						listenPort: udpPort,
					})
					break
				} catch { continue }
			}
			if (!tunnel) { console.error("no free port"); process.exit(1) }
			tunnel.peers[${JSON.stringify(PUB_A)}] = {}

			let requestCount = 0
			const httpServer = tunnel.serve(8080, async (req) => {
				requestCount++
				const url = new URL(req.url)

				if (url.pathname === '/large-echo') {
					const body = await req.arrayBuffer()
					const bytes = new Uint8Array(body)
					// Compute simple checksum (sum of all bytes mod 2^32)
					let sum = 0
					for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) >>> 0
					return new Response(JSON.stringify({
						length: bytes.length,
						checksum: sum,
						requestNum: requestCount,
					}), { headers: { 'content-type': 'application/json' } })
				}

				return new Response(JSON.stringify({
					method: req.method,
					path: url.pathname,
					requestNum: requestCount,
				}), { headers: { 'content-type': 'application/json' } })
			})

			writeFileSync(${JSON.stringify(portFile)}, String(udpPort))
			os.setTimeout(() => { httpServer.close(); tunnel.close(); process.exit(0) }, 30000)
		`)

		// Client: multiple sequential requests including a large POST
		writeFileSync(`${dir}/client.js`, `
			import { readFileSync } from 'node:fs'
			import { WireGuardTunnel } from 'qn:wireguard'

			let serverPort
			for (let i = 0; i < 200; i++) {
				try { serverPort = parseInt(readFileSync(${JSON.stringify(portFile)}, 'utf8')); break }
				catch { const s = Date.now(); while (Date.now() - s < 25) {} }
			}
			if (!serverPort) { console.error("no port file"); process.exit(1) }

			const tunnel = new WireGuardTunnel({
				privateKey: ${JSON.stringify(PRIV_A)},
				address: "10.0.0.1",
			})
			tunnel.peers[${JSON.stringify(PUB_B)}] = {
				endpoint: "127.0.0.1",
				endpointPort: serverPort,
			}

			await tunnel.waitForPeer(${JSON.stringify(PUB_B)})

			const results = []

			// Request 1: simple GET
			const r1 = await tunnel.fetch("http://10.0.0.2:8080/first")
			results.push(await r1.json())

			// Request 2: POST with small body
			const r2 = await tunnel.fetch("http://10.0.0.2:8080/large-echo", {
				method: "POST",
				body: "small",
			})
			results.push(await r2.json())

			// Request 3: POST with 256KB body (exercises ring buffer)
			const bigBody = new Uint8Array(256 * 1024)
			for (let i = 0; i < bigBody.length; i++) bigBody[i] = i & 0xFF
			let expectedSum = 0
			for (let i = 0; i < bigBody.length; i++) expectedSum = (expectedSum + bigBody[i]) >>> 0

			const r3 = await tunnel.fetch("http://10.0.0.2:8080/large-echo", {
				method: "POST",
				body: bigBody,
			})
			results.push(await r3.json())

			// Request 4: another GET to verify server still works
			const r4 = await tunnel.fetch("http://10.0.0.2:8080/final")
			results.push(await r4.json())

			tunnel.close()
			console.log(JSON.stringify({
				count: results.length,
				r1_path: results[0].path,
				r2_length: results[1].length,
				r3_length: results[2].length,
				r3_checksum: results[2].checksum,
				expectedSum: expectedSum,
				r4_path: results[3].path,
				sequential: results.map(r => r.requestNum),
			}))
		`)

		const serverP = execAsync(bin, [`${dir}/server.js`])
		const clientOutput = await execAsync(bin, [`${dir}/client.js`])
		const result = JSON.parse(clientOutput)
		assert.strictEqual(result.count, 4)
		assert.strictEqual(result.r1_path, "/first")
		assert.strictEqual(result.r2_length, 5)  // "small"
		assert.strictEqual(result.r3_length, 256 * 1024)
		assert.strictEqual(result.r3_checksum, result.expectedSum)
		assert.strictEqual(result.r4_path, "/final")
		assert.deepStrictEqual(result.sequential, [1, 2, 3, 4])
		serverP.then(() => {}, () => {})
	})

	testQnOnly('tunnel.fetch() HTTPS through WireGuard', async ({ bin, dir }) => {
		const PRIV_A = "4N9+QQTiIy3jLeBh9esGoECGfUXU383qOOSiQ3/vlEY="
		const PUB_A  = "1n+AWoDIGkuKQDkYf5bEn3p415Xc4r9vpxrDCWQ60FU="
		const PRIV_B = "ABmangI2LTOsUk8Dh93vjlMEfqCmQ2TUFAOXexemvEk="
		const PUB_B  = "HPBqprmBFlWl160jaW4rYYcEk25peXvyVpNwkj0/jx8="

		const portFile = `${dir}/port`

		// Server (tunnel B at 10.0.0.2): TLS server on tunnel using transport-agnostic API
		writeFileSync(`${dir}/server.js`, `
			import { writeFileSync } from 'node:fs'
			import { WireGuardTunnel } from 'qn:wireguard'
			import * as tls from 'node:tls'
			import * as os from 'os'

			let tunnel, udpPort
			for (udpPort = 52700; udpPort < 52800; udpPort++) {
				try {
					tunnel = new WireGuardTunnel({
						privateKey: ${JSON.stringify(PRIV_B)},
						address: "10.0.0.2",
						listenPort: udpPort,
					})
					break
				} catch { continue }
			}
			if (!tunnel) { console.error("no free port"); process.exit(1) }
			tunnel.peers[${JSON.stringify(PUB_A)}] = {}

			const cred = tls.loadServerCert(${JSON.stringify(tunnelCertFile)}, ${JSON.stringify(tunnelKeyFile)})
			const listener = tunnel.listen(443)
			writeFileSync(${JSON.stringify(portFile)}, String(udpPort))

			// Accept two HTTPS connections
			for (let i = 0; i < 2; i++) {
				const sock = await listener.accept({ timeout: 10000 })
				const conn = tls.acceptBuf(cred)
				try {
					await tls.handshake(conn, sock)

					// Read HTTP request
					const buf = new ArrayBuffer(65536)
					let total = new Uint8Array(0)
					for (;;) {
						const n = await tls.read(conn, sock, buf, 0, 65536)
						if (n <= 0) break
						const prev = total
						total = new Uint8Array(prev.length + n)
						total.set(prev, 0)
						total.set(new Uint8Array(buf, 0, n), prev.length)
						const text = new TextDecoder().decode(total)
						if (text.includes('\\r\\n\\r\\n')) {
							// Check for Content-Length to read body
							const clMatch = text.match(/content-length:\\s*(\\d+)/i)
							const cl = clMatch ? parseInt(clMatch[1], 10) : 0
							const headerEnd = text.indexOf('\\r\\n\\r\\n') + 4
							if (total.length >= headerEnd + cl) break
						}
					}

					const request = new TextDecoder().decode(total)
					const firstLine = request.split('\\r\\n')[0]
					const method = firstLine.split(' ')[0]
					const path = firstLine.split(' ')[1]

					// Extract body if POST
					const bodyStart = request.indexOf('\\r\\n\\r\\n') + 4
					const body = bodyStart > 4 ? request.slice(bodyStart) : ''

					const respBody = JSON.stringify({ method, path, body, requestNum: i + 1 })
					const response = 'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: '
						+ new TextEncoder().encode(respBody).length + '\\r\\nConnection: close\\r\\n\\r\\n' + respBody
					await tls.writeAll(conn, sock, new TextEncoder().encode(response))
					await tls.close(conn, sock)
				} catch (e) {
					try { await tls.close(conn, sock) } catch {}
				}
				sock.close()
			}

			listener.close()
			tunnel.close()
		`)

		// Client (tunnel A at 10.0.0.1): use tunnel.fetch() with HTTPS
		writeFileSync(`${dir}/client.js`, `
			import { readFileSync } from 'node:fs'
			import { WireGuardTunnel } from 'qn:wireguard'

			let serverPort
			for (let i = 0; i < 200; i++) {
				try { serverPort = parseInt(readFileSync(${JSON.stringify(portFile)}, 'utf8')); break }
				catch { const s = Date.now(); while (Date.now() - s < 25) {} }
			}
			if (!serverPort) { console.error("no port file"); process.exit(1) }

			const tunnel = new WireGuardTunnel({
				privateKey: ${JSON.stringify(PRIV_A)},
				address: "10.0.0.1",
			})
			tunnel.peers[${JSON.stringify(PUB_B)}] = {
				endpoint: "127.0.0.1",
				endpointPort: serverPort,
			}

			await tunnel.waitForPeer(${JSON.stringify(PUB_B)})

			// HTTPS GET
			const resp1 = await tunnel.fetch("https://10.0.0.2/hello")
			const json1 = await resp1.json()

			// HTTPS POST
			const resp2 = await tunnel.fetch("https://10.0.0.2/echo", {
				method: "POST",
				body: "secure payload",
			})
			const json2 = await resp2.json()

			tunnel.close()
			console.log(JSON.stringify({
				status1: resp1.status,
				method1: json1.method,
				path1: json1.path,
				status2: resp2.status,
				method2: json2.method,
				body2: json2.body,
			}))
		`)

		const serverP = execAsync(bin, [`${dir}/server.js`])
		const clientOutput = await execAsync(bin, [`${dir}/client.js`], {
			env: { NODE_EXTRA_CA_CERTS: tunnelCertFile }
		})
		const result = JSON.parse(clientOutput)
		assert.strictEqual(result.status1, 200)
		assert.strictEqual(result.method1, "GET")
		assert.strictEqual(result.path1, "/hello")
		assert.strictEqual(result.status2, 200)
		assert.strictEqual(result.method2, "POST")
		assert.strictEqual(result.body2, "secure payload")
		await serverP
	})

	testQnOnly('two tunnels: UDP echo through WireGuard', async ({ bin, dir }) => {
		const PRIV_A = "4N9+QQTiIy3jLeBh9esGoECGfUXU383qOOSiQ3/vlEY="
		const PUB_A  = "1n+AWoDIGkuKQDkYf5bEn3p415Xc4r9vpxrDCWQ60FU="
		const PRIV_B = "ABmangI2LTOsUk8Dh93vjlMEfqCmQ2TUFAOXexemvEk="
		const PUB_B  = "HPBqprmBFlWl160jaW4rYYcEk25peXvyVpNwkj0/jx8="

		const portFile = `${dir}/port`

		// Server: bind UDP 9999 on tunnel A, receive datagram, echo it back
		writeFileSync(`${dir}/server.js`, `
			import { writeFileSync } from 'node:fs'
			import {
				wgCreateTunnel, wgGetFd, wgAddPeer,
				wgUdpBind, wgUdpRecv, wgUdpSendTo, wgUdpClose,
				wgProcessInput, wgCheckTimeouts, wgClose,
			} from 'qn_wireguard'
			import * as os from 'os'

			let tunnel, fd, udpPort
			for (udpPort = 51820; udpPort < 51920; udpPort++) {
				try {
					tunnel = wgCreateTunnel(${JSON.stringify(PRIV_A)}, "10.0.0.1", "255.255.255.0", null, udpPort)
					fd = wgGetFd(tunnel)
					break
				} catch { continue }
			}
			if (!tunnel) { console.error("no free port"); process.exit(1) }

			wgAddPeer(tunnel, ${JSON.stringify(PUB_B)}, null, "127.0.0.1", 0, "0.0.0.0", "0.0.0.0", 0)
			const sock = wgUdpBind(tunnel, 9999)

			writeFileSync(${JSON.stringify(portFile)}, String(udpPort))

			const buf = new ArrayBuffer(1500)
			const pump = () => { wgProcessInput(tunnel); wgCheckTimeouts(tunnel) }
			os.setReadHandler(fd, pump)

			const tick = () => {
				pump()
				const r = wgUdpRecv(tunnel, sock, buf, 0, 1500)
				if (r !== undefined) {
					// Echo back
					wgUdpSendTo(tunnel, sock, buf, 0, r.n, r.address, r.port)
					os.setTimeout(() => {
						wgUdpClose(tunnel, sock)
						os.setReadHandler(fd, null)
						wgClose(tunnel)
						process.exit(0)
					}, 200)
					return
				}
				os.setTimeout(tick, 50)
			}
			tick()

			os.setTimeout(() => { os.setReadHandler(fd, null); wgClose(tunnel); process.exit(1) }, 10000)
		`)

		// Client: send UDP datagram to A, receive echo
		writeFileSync(`${dir}/client.js`, `
			import { readFileSync } from 'node:fs'
			import {
				wgCreateTunnel, wgGetFd, wgAddPeer, wgConnect, wgPeerIsUp,
				wgUdpBind, wgUdpSendTo, wgUdpRecv, wgUdpClose,
				wgProcessInput, wgCheckTimeouts, wgClose,
			} from 'qn_wireguard'
			import * as os from 'os'

			let serverPort
			for (let i = 0; i < 200; i++) {
				try { serverPort = parseInt(readFileSync(${JSON.stringify(portFile)}, 'utf8')); break }
				catch { const s = Date.now(); while (Date.now() - s < 25) {} }
			}
			if (!serverPort) { console.error("no port file"); process.exit(1) }

			const tunnel = wgCreateTunnel(${JSON.stringify(PRIV_B)}, "10.0.0.2", "255.255.255.0", null, 0)
			const fd = wgGetFd(tunnel)
			const pi = wgAddPeer(tunnel, ${JSON.stringify(PUB_A)}, null,
				"127.0.0.1", serverPort, "0.0.0.0", "0.0.0.0", 0)
			wgConnect(tunnel, pi)

			const sock = wgUdpBind(tunnel, 0)
			const buf = new ArrayBuffer(1500)
			const pump = () => { wgProcessInput(tunnel); wgCheckTimeouts(tunnel) }
			os.setReadHandler(fd, pump)

			const exit = (result) => {
				wgUdpClose(tunnel, sock)
				os.setReadHandler(fd, null)
				wgClose(tunnel)
				console.log(JSON.stringify(result))
				process.exit(result.error ? 1 : 0)
			}

			const step = () => {
				pump()
				if (!wgPeerIsUp(tunnel, pi)) { os.setTimeout(step, 50); return }

				const msg = new TextEncoder().encode("udp hello")
				wgUdpSendTo(tunnel, sock, msg.buffer, 0, msg.byteLength, "10.0.0.1", 9999)

				const waitEcho = () => {
					pump()
					const r = wgUdpRecv(tunnel, sock, buf, 0, 1500)
					if (r === undefined) { os.setTimeout(waitEcho, 50); return }
					const echo = new TextDecoder().decode(new Uint8Array(buf, 0, r.n))
					exit({ echo, from: r.address })
				}
				waitEcho()
			}
			step()

			os.setTimeout(() => exit({ error: "timeout" }), 10000)
		`)

		const serverP = execAsync(bin, [`${dir}/server.js`])
		const clientOutput = await execAsync(bin, [`${dir}/client.js`])
		const result = JSON.parse(clientOutput)
		assert.strictEqual(result.echo, "udp hello")
		assert.strictEqual(result.from, "10.0.0.1")
		await serverP
	})
})

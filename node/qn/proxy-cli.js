/**
 * Reverse proxy CLI — config-file-driven proxy server
 *
 * Usage:
 *   qn proxy-cli.js [--config] <path> [--port <port>] [--hostname <addr>]
 *
 * Config file format (one mapping per line):
 *   # comments start with #
 *   hostname backend_url
 *
 * Example config:
 *   app.local      http://localhost:3000
 *   api.local      http://localhost:4000
 *
 * The config file is polled for changes every 2 seconds.
 *
 * Environment variables:
 *   PROXY_USER  User to drop privileges to after binding (when running as root)
 */

import { createProxy } from 'qn:proxy'
import { readFileSync, statSync } from 'node:fs'

const args = process.argv.slice(2)
let configPath = null
let port = 80
let hostname = '0.0.0.0'

for (let i = 0; i < args.length; i++) {
	const arg = args[i]
	if (arg === '--config' || arg === '-c') configPath = args[++i]
	else if (arg === '--port' || arg === '-p') port = parseInt(args[++i])
	else if (arg === '--hostname' || arg === '-H') hostname = args[++i]
	else if (arg === '--help') { usage(); process.exit(0) }
	else if (!arg.startsWith('-') && !configPath) configPath = arg
}

if (!configPath) {
	usage()
	process.exit(1)
}

function usage() {
	console.error('Usage: qn proxy-cli.js [--config] <path> [--port <port>] [--hostname <addr>]')
}

let routes = new Map()

function loadConfig() {
	try {
		const content = readFileSync(configPath, 'utf8')
		const newRoutes = new Map()
		for (const line of content.split('\n')) {
			const trimmed = line.trim()
			if (!trimmed || trimmed.startsWith('#')) continue
			const parts = trimmed.split(/\s+/)
			if (parts.length >= 2) {
				newRoutes.set(parts[0], parts[1])
			}
		}
		routes = newRoutes
		const entries = [...routes.entries()].map(([h, b]) => `  ${h} -> ${b}`).join('\n')
		console.log(`[proxy] loaded ${routes.size} route(s) from ${configPath}${entries ? '\n' + entries : ''}`)
	} catch (err) {
		console.error(`[proxy] error reading config: ${err.message}`)
	}
}

loadConfig()

const proxy = await createProxy({
	port,
	hostname,
	route: (req) => {
		const host = (req.headers.host || '').split(':')[0]
		return routes.get(host) || null
	},
})

const addr = proxy.address()
console.log(`[proxy] listening on ${addr.address}:${addr.port}`)

// Drop privileges after binding
if (process.getuid() === 0) {
	const user = process.env.PROXY_USER
	if (user) {
		process.setgroups([])
		process.setgid(user)
		process.setuid(user)
		console.log(`[proxy] dropped privileges to ${user}`)
	} else {
		console.error('[proxy] WARNING: running as root without PROXY_USER set')
	}
}

// Poll config file for changes
let lastMtime = 0
try { lastMtime = statSync(configPath).mtimeMs } catch {}

setInterval(() => {
	try {
		const mtime = statSync(configPath).mtimeMs
		if (mtime !== lastMtime) {
			lastMtime = mtime
			loadConfig()
		}
	} catch (err) {
		console.error(`[proxy] error watching config: ${err.message}`)
	}
}, 2000)

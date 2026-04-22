/*
 * qn:watch — `qn --watch` implementation
 *
 * Walk the static import graph via qn:bundle's traceModuleGraph, spawn the
 * script, poll mtimes of every reachable file, restart on change. The graph
 * is re-traced after every restart so newly added imports join the watch set.
 *
 * Computed dynamic imports (`import(variable)`) can't be traced statically —
 * same limitation as Bun/tsx/nodemon. String-literal dynamic imports are fine.
 */

import * as std from "std"
import { statSync } from "node:fs"
import { spawn } from "node:child_process"
import { traceModuleGraph } from "qn:bundle"

const POLL_MS = 250
const SIGKILL_GRACE_MS = 2000

function mtimeOf(path) {
	try {
		return statSync(path).mtimeMs
	} catch {
		return null
	}
}

function formatPath(path, cwd) {
	return cwd && path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path
}

export async function runWatch(scriptPath, extraArgs) {
	const qnBin = scriptArgs[0]
	const cwd = std.getenviron().PWD || ""

	/* path → last-seen mtimeMs */
	const watched = new Map()

	function refreshGraph() {
		let files
		try {
			files = traceModuleGraph(scriptPath)
		} catch (e) {
			/* Parse error or missing entry — fall back to just the entry file so
			   the user can fix it and trigger a restart on save. */
			std.err.puts(`[watch] trace failed: ${e.message}\n`)
			files = new Set([scriptPath])
		}
		/* Rebuild the map: drop paths no longer in the graph, add new ones with
		   their current mtime as baseline. Keeping stale paths would trigger
		   spurious restarts when a removed dependency is later edited. */
		const next = new Map()
		for (const f of files) {
			next.set(f, watched.has(f) ? watched.get(f) : mtimeOf(f))
		}
		watched.clear()
		for (const [k, v] of next) watched.set(k, v)
	}

	function detectChange() {
		for (const [path, seen] of watched) {
			const now = mtimeOf(path)
			if (now === null) continue
			if (seen === null) {
				watched.set(path, now)
				continue
			}
			if (now !== seen) {
				watched.set(path, now)
				return path
			}
		}
		return null
	}

	let child = null
	let exitPromise = null

	function startChild() {
		child = spawn(qnBin, [scriptPath, ...extraArgs], { stdio: "inherit" })
		exitPromise = new Promise((resolve) => {
			child.on("exit", (code, signal) => {
				child = null
				resolve({ code, signal })
			})
		})
	}

	async function stopChild() {
		if (!child) return
		const handle = child
		handle.kill("SIGTERM")
		const graceTimer = setTimeout(() => {
			if (child === handle) handle.kill("SIGKILL")
		}, SIGKILL_GRACE_MS)
		try {
			await exitPromise
		} finally {
			clearTimeout(graceTimer)
		}
	}

	refreshGraph()
	std.err.puts(`[watch] ${scriptPath} (${watched.size} files)\n`)
	startChild()

	/* Main loop. Ctrl-C sends SIGINT to the whole process group; both parent
	   and child exit via the default signal handler. */
	while (true) {
		await new Promise((r) => setTimeout(r, POLL_MS))
		const changed = detectChange()
		if (!changed) continue
		std.err.puts(`[watch] ${formatPath(changed, cwd)} changed — restarting\n`)
		await stopChild()
		refreshGraph()
		startChild()
	}
}

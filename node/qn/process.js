/**
 * qn:process - Process tree utilities
 *
 * Provides killTree() and getDescendantPids() using kernel APIs
 * (Linux: /proc, macOS: proc_listchildpids) via the C layer.
 */

import { getChildPids, killPid } from 'qn:uv-process'
import { signals } from 'qn_uv_signals'

/**
 * Get all descendant PIDs of a process (recursive).
 * @param {number} pid
 * @returns {number[]} Descendant PIDs in breadth-first order
 */
export function getDescendantPids(pid) {
	const descendants = []
	const queue = [pid]
	while (queue.length > 0) {
		const parent = queue.shift()
		const children = getChildPids(parent)
		for (const child of children) {
			descendants.push(child)
			queue.push(child)
		}
	}
	return descendants
}

/**
 * Kill a process and all its descendants.
 * Signals the root first so it can handle cleanup, then descendants.
 * @param {number} pid - Root process to kill
 * @param {string|number} signal - Signal name or number
 */
export function killTree(pid, signal = 'SIGTERM') {
	const sig = typeof signal === 'string' ? (signals[signal] ?? signals[`SIG${signal}`] ?? 15) : signal
	const descendants = getDescendantPids(pid)
	// Signal root first (gives it a chance to clean up children),
	// then descendants in case the root doesn't handle it.
	try { killPid(pid, sig) } catch {}
	for (const child of descendants) {
		try { killPid(child, sig) } catch {}
	}
}

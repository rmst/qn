#!/usr/bin/env qx
/**
 * Startup time benchmark for qn binaries
 *
 * Measures the time it takes each binary to start up and exit.
 */

import { execFileSync } from 'node:child_process'
import process from 'node:process'

const ITERATIONS = parseInt(process.env.BENCH_ITERATIONS || '50', 10)
const BIN_DIR = process.env.BIN_DIR || `${import.meta.dirname}/../bin`
const binaries = [
	{ name: 'qjsx', path: `${BIN_DIR}/qjsx`, args: ['-e', ''] },
	{ name: 'qn', path: `${BIN_DIR}/qn`, args: ['-e', ''] },
	{ name: 'qx', path: `${BIN_DIR}/qx`, args: ['-e', ''] },
]

function nodeAvailable() {
	try {
		execFileSync('which', ['node'], { stdio: 'pipe' })
		return true
	} catch {
		return false
	}
}

function measureStartup(cmd, args, iterations) {
	const times = []

	for (let i = 0; i < iterations; i++) {
		const start = performance.now()
		try {
			execFileSync(cmd, args, { stdio: 'pipe' })
		} catch (e) {
			throw new Error(`Command failed: ${cmd} ${args.join(' ')}: ${e.message}`)
		}
		const end = performance.now()
		times.push(end - start)
	}

	return times
}

function stats(times) {
	const sorted = [...times].sort((a, b) => a - b)
	const sum = times.reduce((a, b) => a + b, 0)
	const mean = sum / times.length
	const median = sorted.length % 2 === 0
		? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
		: sorted[Math.floor(sorted.length / 2)]
	const min = sorted[0]
	const max = sorted[sorted.length - 1]
	const stddev = Math.sqrt(times.reduce((acc, t) => acc + (t - mean) ** 2, 0) / times.length)

	return { mean, median, min, max, stddev }
}

function formatMs(ms) {
	return ms.toFixed(2).padStart(7) + ' ms'
}

function main() {
	console.log(`Startup time benchmark (${ITERATIONS} iterations)\n`)
	console.log('Binary'.padEnd(10) + 'Mean'.padStart(12) + 'Median'.padStart(12) + 'Min'.padStart(12) + 'Max'.padStart(12) + 'StdDev'.padStart(12))
	console.log('-'.repeat(70))

	const results = []

	// Check if node is available
	if (nodeAvailable()) {
		binaries.push({ name: 'node', path: 'node', args: ['-e', ''] })
	}

	for (const bin of binaries) {
		process.stdout.write(`${bin.name.padEnd(10)}`)

		try {
			const times = measureStartup(bin.path, bin.args, ITERATIONS)
			const s = stats(times)
			results.push({ name: bin.name, ...s })

			console.log(
				formatMs(s.mean) +
				formatMs(s.median) +
				formatMs(s.min) +
				formatMs(s.max) +
				formatMs(s.stddev)
			)
		} catch (err) {
			console.log('  (not available)')
		}
	}

	// Print comparison
	if (results.length > 1) {
		console.log('\nComparison (relative to qjsx):')
		const baseline = results.find(r => r.name === 'qjsx')?.mean || results[0].mean
		for (const r of results) {
			const ratio = r.mean / baseline
			const bar = '█'.repeat(Math.round(ratio * 20))
			console.log(`  ${r.name.padEnd(8)} ${ratio.toFixed(2)}x ${bar}`)
		}
	}
}

try {
	main()
} catch (err) {
	console.error(err)
	process.exit(1)
}

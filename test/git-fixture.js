/**
 * Test helpers for spinning up local git fixtures: making repos via the
 * system git binary, and serving them over a local HTTP server that wraps
 * git-http-backend as CGI. Used by tests that exercise the smart-HTTP
 * fetching code in qn:git.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const GIT_ENV = {
	GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
	GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
	GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
}

export function gitCmd(cwd, ...args) {
	return execFileSync('git', args, {
		cwd,
		env: { ...process.env, ...GIT_ENV },
		stdio: ['ignore', 'pipe', 'pipe'],
	}).toString()
}

export function makeRepo() {
	const dir = mkdtempSync(join(tmpdir(), 'qn-git-fixture-'))
	gitCmd(dir, 'init', '-q', '-b', 'main')
	return dir
}

export function commitAll(dir, msg) {
	gitCmd(dir, 'add', '-A')
	gitCmd(dir, 'commit', '-q', '-m', msg)
	return gitCmd(dir, 'rev-parse', 'HEAD').trim()
}

/** Find git-http-backend on the system, or null if not available. */
export function findGitHttpBackend() {
	try {
		const execPath = execFileSync('git', ['--exec-path']).toString().trim()
		const candidate = join(execPath, 'git-http-backend')
		if (existsSync(candidate)) return candidate
	} catch {}
	return null
}

/**
 * Start an HTTP server that wraps git-http-backend (CGI). `repoParent` is
 * the directory containing one or more repos; the request URL path
 * determines which repo. Returns { server, url } where url is the base.
 *
 * Caller is responsible for calling server.close().
 */
export function startGitHttpServer(repoParent, gitHttpBackend) {
	return new Promise((resolveStart, reject) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url, 'http://localhost')
			const env = {
				...process.env,
				GIT_PROJECT_ROOT: repoParent,
				GIT_HTTP_EXPORT_ALL: '1',
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				REQUEST_METHOD: req.method,
				CONTENT_TYPE: req.headers['content-type'] || '',
				CONTENT_LENGTH: req.headers['content-length'] || '0',
				REMOTE_ADDR: '127.0.0.1',
			}
			const child = spawn(gitHttpBackend, [], { env, stdio: ['pipe', 'pipe', 'pipe'] })
			req.on('data', (c) => child.stdin.write(c))
			req.on('end', () => child.stdin.end())
			const chunks = []
			child.stdout.on('data', (c) => chunks.push(Buffer.from(c)))
			child.stderr.on('data', () => {})
			child.on('exit', (code) => {
				if (code !== 0) { res.writeHead(500); res.end('cgi exit ' + code); return }
				const buf = Buffer.concat(chunks)
				let split = buf.indexOf('\r\n\r\n')
				let sepLen = 4
				if (split < 0) { split = buf.indexOf('\n\n'); sepLen = 2 }
				if (split < 0) { res.writeHead(502); res.end('no cgi headers'); return }
				const headers = buf.subarray(0, split).toString('utf8')
				const body = buf.subarray(split + sepLen)
				let status = 200
				const outHeaders = {}
				for (const line of headers.split(/\r?\n/)) {
					if (!line) continue
					const i = line.indexOf(':')
					if (i < 0) continue
					const k = line.slice(0, i).trim()
					const v = line.slice(i + 1).trim()
					if (k.toLowerCase() === 'status') status = parseInt(v, 10) || 200
					else outHeaders[k] = v
				}
				res.writeHead(status, outHeaders)
				res.end(body)
			})
		})
		server.on('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address()
			resolveStart({ server, url: `http://127.0.0.1:${port}` })
		})
	})
}

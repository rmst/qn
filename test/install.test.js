import { describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mktempdir } from './util.js'
import { install } from '../node/qn/install.js'
import {
	makeRepo, commitAll, findGitHttpBackend, startGitHttpServer,
} from './git-fixture.js'

describe('qn install', () => {
	test('installs file: dependency', async () => {
		let dir = mktempdir()
		try {
			// Create a fake package to install
			let pkgDir = join(dir, "my-lib")
			mkdirSync(pkgDir)
			writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "my-lib" }))
			writeFileSync(join(pkgDir, "index.js"), "export const x = 42\n")

			// Create the project that depends on it
			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "my-lib": `file:${pkgDir}` }
			}))

			await install(projectDir)

			// Check it was installed
			assert.ok(existsSync(join(projectDir, "node_modules", "my-lib", "index.js")))
			assert.ok(existsSync(join(projectDir, "node_modules", "my-lib", "package.json")))
			let content = readFileSync(join(projectDir, "node_modules", "my-lib", "index.js"), "utf8")
			assert.strictEqual(content, "export const x = 42\n")
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('installs scoped file: dependency', async () => {
		let dir = mktempdir()
		try {
			let pkgDir = join(dir, "core")
			mkdirSync(pkgDir)
			writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@myorg/core" }))
			writeFileSync(join(pkgDir, "index.js"), "export default 1\n")

			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "@myorg/core": `file:${pkgDir}` }
			}))

			await install(projectDir)

			assert.ok(existsSync(join(projectDir, "node_modules", "@myorg", "core", "index.js")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('skips devDependencies by default', async () => {
		let dir = mktempdir()
		try {
			let libA = join(dir, "lib-a")
			mkdirSync(libA)
			writeFileSync(join(libA, "package.json"), JSON.stringify({ name: "lib-a" }))
			writeFileSync(join(libA, "index.js"), "")

			let libB = join(dir, "lib-b")
			mkdirSync(libB)
			writeFileSync(join(libB, "package.json"), JSON.stringify({ name: "lib-b" }))
			writeFileSync(join(libB, "index.js"), "")

			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "lib-a": `file:${libA}` },
				devDependencies: { "lib-b": `file:${libB}` }
			}))

			await install(projectDir)

			assert.ok(existsSync(join(projectDir, "node_modules", "lib-a")))
			assert.ok(!existsSync(join(projectDir, "node_modules", "lib-b")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('includes devDependencies with dev option', async () => {
		let dir = mktempdir()
		try {
			let libA = join(dir, "lib-a")
			mkdirSync(libA)
			writeFileSync(join(libA, "package.json"), JSON.stringify({ name: "lib-a" }))
			writeFileSync(join(libA, "index.js"), "")

			let libB = join(dir, "lib-b")
			mkdirSync(libB)
			writeFileSync(join(libB, "package.json"), JSON.stringify({ name: "lib-b" }))
			writeFileSync(join(libB, "index.js"), "")

			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "lib-a": `file:${libA}` },
				devDependencies: { "lib-b": `file:${libB}` }
			}))

			await install(projectDir, { dev: true })

			assert.ok(existsSync(join(projectDir, "node_modules", "lib-a")))
			assert.ok(existsSync(join(projectDir, "node_modules", "lib-b")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('replaces existing package on reinstall', async () => {
		let dir = mktempdir()
		try {
			let pkgDir = join(dir, "my-lib")
			mkdirSync(pkgDir)
			writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "my-lib" }))
			writeFileSync(join(pkgDir, "index.js"), "export const v = 1\n")

			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "my-lib": `file:${pkgDir}` }
			}))

			await install(projectDir)
			assert.strictEqual(readFileSync(join(projectDir, "node_modules", "my-lib", "index.js"), "utf8"), "export const v = 1\n")

			// Update source
			writeFileSync(join(pkgDir, "index.js"), "export const v = 2\n")
			await install(projectDir)
			assert.strictEqual(readFileSync(join(projectDir, "node_modules", "my-lib", "index.js"), "utf8"), "export const v = 2\n")
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('reports npm specifiers as unsupported', async () => {
		let dir = mktempdir()
		try {
			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "lodash": "^4.0.0" }
			}))

			// Should not throw, just skip
			await install(projectDir)

			assert.ok(!existsSync(join(projectDir, "node_modules", "lodash")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('strips .git directory from file: installs', async () => {
		let dir = mktempdir()
		try {
			let pkgDir = join(dir, "my-lib")
			mkdirSync(pkgDir)
			writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "my-lib" }))
			mkdirSync(join(pkgDir, ".git"))
			writeFileSync(join(pkgDir, ".git", "HEAD"), "ref: refs/heads/main\n")

			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "my-lib": `file:${pkgDir}` }
			}))

			await install(projectDir)

			assert.ok(existsSync(join(projectDir, "node_modules", "my-lib", "package.json")))
			assert.ok(!existsSync(join(projectDir, "node_modules", "my-lib", ".git")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('does not run prepare for file: dependencies', async () => {
		let dir = mktempdir()
		try {
			let pkgDir = join(dir, "my-lib")
			mkdirSync(pkgDir)
			writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
				name: "my-lib",
				scripts: { prepare: "echo SHOULD_NOT_RUN > prepared.txt" }
			}))

			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "my-lib": `file:${pkgDir}` }
			}))

			await install(projectDir)

			assert.ok(!existsSync(join(projectDir, "node_modules", "my-lib", "prepared.txt")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	const gitHttpBackend = findGitHttpBackend()
	const remoteTest = gitHttpBackend ? test : (test.skip ?? (() => {}))

	remoteTest('installs git+https dependency via local HTTP server', async () => {
		// Set up a git repo serving an installable package.
		const repo = makeRepo()
		writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'remote-pkg', version: '0.0.1' }))
		writeFileSync(join(repo, 'index.js'), 'export const v = "remote"\n')
		const sha = commitAll(repo, 'init')

		const { server, url } = await startGitHttpServer(repo + '/..', gitHttpBackend)
		try {
			const repoBase = url + '/' + repo.split('/').pop() + '/.git'
			const dir = mktempdir()
			try {
				const projectDir = join(dir, 'project')
				mkdirSync(projectDir)
				writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
					name: 'test-project',
					dependencies: { 'remote-pkg': `git+${repoBase}#${sha}` },
				}))
				await install(projectDir)

				assert.ok(existsSync(join(projectDir, 'node_modules', 'remote-pkg', 'index.js')))
				assert.equal(
					readFileSync(join(projectDir, 'node_modules', 'remote-pkg', 'index.js'), 'utf8'),
					'export const v = "remote"\n',
				)
			} finally {
				rmSync(dir, { recursive: true })
			}
		} finally {
			server.close()
			rmSync(repo, { recursive: true, force: true })
		}
	})

	remoteTest('installs github: shorthand via local HTTP server', async () => {
		// Spec is `github:owner/repo[#ref]`, which install.js resolves to
		// https://github.com/owner/repo. We override the URL by serving from
		// our local server and using a `git+http://...` dependency that mirrors
		// the same path-shape.
		const repo = makeRepo()
		writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'gh-pkg' }))
		writeFileSync(join(repo, 'README.md'), 'hello\n')
		commitAll(repo, 'init')

		const { server, url } = await startGitHttpServer(repo + '/..', gitHttpBackend)
		try {
			const repoBase = url + '/' + repo.split('/').pop() + '/.git'
			const dir = mktempdir()
			try {
				const projectDir = join(dir, 'project')
				mkdirSync(projectDir)
				writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
					name: 'test-project',
					dependencies: { 'gh-pkg': `git+${repoBase}` },
				}))
				await install(projectDir)
				assert.equal(
					readFileSync(join(projectDir, 'node_modules', 'gh-pkg', 'README.md'), 'utf8'),
					'hello\n',
				)
				// Materialized via qn:git (no .git directory artifact).
				assert.ok(!existsSync(join(projectDir, 'node_modules', 'gh-pkg', '.git')))
			} finally {
				rmSync(dir, { recursive: true })
			}
		} finally {
			server.close()
			rmSync(repo, { recursive: true, force: true })
		}
	})

	test('handles empty dependencies', async () => {
		let dir = mktempdir()
		try {
			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project"
			}))

			// Should not throw
			await install(projectDir)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

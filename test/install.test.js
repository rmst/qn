import { describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mktempdir } from './util.js'
import { install } from '../node/qn/install.js'

describe('qn install', () => {
	test('installs file: dependency', () => {
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

			install(projectDir)

			// Check it was installed
			assert.ok(existsSync(join(projectDir, "node_modules", "my-lib", "index.js")))
			assert.ok(existsSync(join(projectDir, "node_modules", "my-lib", "package.json")))
			let content = readFileSync(join(projectDir, "node_modules", "my-lib", "index.js"), "utf8")
			assert.strictEqual(content, "export const x = 42\n")
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('installs scoped file: dependency', () => {
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

			install(projectDir)

			assert.ok(existsSync(join(projectDir, "node_modules", "@myorg", "core", "index.js")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('skips devDependencies by default', () => {
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

			install(projectDir)

			assert.ok(existsSync(join(projectDir, "node_modules", "lib-a")))
			assert.ok(!existsSync(join(projectDir, "node_modules", "lib-b")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('includes devDependencies with dev option', () => {
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

			install(projectDir, { dev: true })

			assert.ok(existsSync(join(projectDir, "node_modules", "lib-a")))
			assert.ok(existsSync(join(projectDir, "node_modules", "lib-b")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('replaces existing package on reinstall', () => {
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

			install(projectDir)
			assert.strictEqual(readFileSync(join(projectDir, "node_modules", "my-lib", "index.js"), "utf8"), "export const v = 1\n")

			// Update source
			writeFileSync(join(pkgDir, "index.js"), "export const v = 2\n")
			install(projectDir)
			assert.strictEqual(readFileSync(join(projectDir, "node_modules", "my-lib", "index.js"), "utf8"), "export const v = 2\n")
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('reports npm specifiers as unsupported', () => {
		let dir = mktempdir()
		try {
			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project",
				dependencies: { "lodash": "^4.0.0" }
			}))

			// Should not throw, just skip
			install(projectDir)

			assert.ok(!existsSync(join(projectDir, "node_modules", "lodash")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('strips .git directory from file: installs', () => {
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

			install(projectDir)

			assert.ok(existsSync(join(projectDir, "node_modules", "my-lib", "package.json")))
			assert.ok(!existsSync(join(projectDir, "node_modules", "my-lib", ".git")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('does not run prepare for file: dependencies', () => {
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

			install(projectDir)

			assert.ok(!existsSync(join(projectDir, "node_modules", "my-lib", "prepared.txt")))
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test('handles empty dependencies', () => {
		let dir = mktempdir()
		try {
			let projectDir = join(dir, "project")
			mkdirSync(projectDir)
			writeFileSync(join(projectDir, "package.json"), JSON.stringify({
				name: "test-project"
			}))

			// Should not throw
			install(projectDir)
		} finally {
			rmSync(dir, { recursive: true })
		}
	})
})

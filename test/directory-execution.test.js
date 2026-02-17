import { test } from "node:test"
import { execSync } from "node:child_process"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, rmSync } from "node:fs"

const __dirname = import.meta.dirname
const qnBin = resolve(__dirname, '../bin/qn')
const qxBin = resolve(__dirname, '../bin/qx')

const mktempdir = () => realpathSync(mkdtempSync(join(tmpdir(), 'dir-exec-test-')))

test('execute directory with index.js fallback (qn)', () => {
	const tmpDir = mktempdir()
	try {
		mkdirSync(join(tmpDir, 'test-dir'))
		writeFileSync(join(tmpDir, 'test-dir', 'index.js'), 'console.log("index-only")')

		const output = execSync(`${qnBin} ${tmpDir}/test-dir`, { encoding: 'utf8' }).trim()
		if (output !== 'index-only') {
			throw new Error(`Expected 'index-only', got '${output}'`)
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true })
	}
})

test('execute directory with index.js fallback (qx)', () => {
	const tmpDir = mktempdir()
	try {
		mkdirSync(join(tmpDir, 'test-dir'))
		writeFileSync(join(tmpDir, 'test-dir', 'index.js'), 'console.log("index-only")')

		const output = execSync(`${qxBin} ${tmpDir}/test-dir`, { encoding: 'utf8' }).trim()
		if (output !== 'index-only') {
			throw new Error(`Expected 'index-only', got '${output}'`)
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true })
	}
})

if (!process.env.NO_NODEJS_TESTS) {
	test('execute directory with index.js fallback (node)', () => {
		const tmpDir = mktempdir()
		try {
			mkdirSync(join(tmpDir, 'test-dir'))
			writeFileSync(join(tmpDir, 'test-dir', 'index.js'), 'console.log("index-only")')

			const output = execSync(`node ${tmpDir}/test-dir`, { encoding: 'utf8' }).trim()
			if (output !== 'index-only') {
				throw new Error(`Expected 'index-only', got '${output}'`)
			}
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})
}

test('execute directory with package.json main field (qn)', () => {
	const tmpDir = mktempdir()
	try {
		mkdirSync(join(tmpDir, 'test-dir'))
		writeFileSync(join(tmpDir, 'test-dir', 'package.json'), JSON.stringify({ name: 'test', main: 'main.js' }))
		writeFileSync(join(tmpDir, 'test-dir', 'main.js'), 'console.log("with-package")')
		writeFileSync(join(tmpDir, 'test-dir', 'index.js'), 'console.log("WRONG"); process.exit(1)')

		const output = execSync(`${qnBin} ${tmpDir}/test-dir`, { encoding: 'utf8' }).trim()
		if (output !== 'with-package') {
			throw new Error(`Expected 'with-package', got '${output}'`)
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true })
	}
})

test('execute directory with package.json main field (qx)', () => {
	const tmpDir = mktempdir()
	try {
		mkdirSync(join(tmpDir, 'test-dir'))
		writeFileSync(join(tmpDir, 'test-dir', 'package.json'), JSON.stringify({ name: 'test', main: 'main.js' }))
		writeFileSync(join(tmpDir, 'test-dir', 'main.js'), 'console.log("with-package")')
		writeFileSync(join(tmpDir, 'test-dir', 'index.js'), 'console.log("WRONG"); process.exit(1)')

		const output = execSync(`${qxBin} ${tmpDir}/test-dir`, { encoding: 'utf8' }).trim()
		if (output !== 'with-package') {
			throw new Error(`Expected 'with-package', got '${output}'`)
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true })
	}
})

if (!process.env.NO_NODEJS_TESTS) {
	test('execute directory with package.json main field (node)', () => {
		const tmpDir = mktempdir()
		try {
			mkdirSync(join(tmpDir, 'test-dir'))
			writeFileSync(join(tmpDir, 'test-dir', 'package.json'), JSON.stringify({ name: 'test', main: 'main.js' }))
			writeFileSync(join(tmpDir, 'test-dir', 'main.js'), 'console.log("with-package")')
			writeFileSync(join(tmpDir, 'test-dir', 'index.js'), 'console.log("WRONG"); process.exit(1)')

			const output = execSync(`node ${tmpDir}/test-dir`, { encoding: 'utf8' }).trim()
			if (output !== 'with-package') {
				throw new Error(`Expected 'with-package', got '${output}'`)
			}
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})
}

test('execute directory with relative path (qn)', () => {
	const tmpDir = mktempdir()
	try {
		mkdirSync(join(tmpDir, 'test-dir'))
		writeFileSync(join(tmpDir, 'test-dir', 'index.js'), 'console.log("relative")')

		const output = execSync(`${qnBin} ./test-dir`, {
			encoding: 'utf8',
			cwd: tmpDir
		}).trim()

		if (output !== 'relative') {
			throw new Error(`Expected 'relative', got '${output}'`)
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true })
	}
})

test('execute directory with relative path (qx)', () => {
	const tmpDir = mktempdir()
	try {
		mkdirSync(join(tmpDir, 'test-dir'))
		writeFileSync(join(tmpDir, 'test-dir', 'index.js'), 'console.log("relative")')

		const output = execSync(`${qxBin} ./test-dir`, {
			encoding: 'utf8',
			cwd: tmpDir
		}).trim()

		if (output !== 'relative') {
			throw new Error(`Expected 'relative', got '${output}'`)
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true })
	}
})

if (!process.env.NO_NODEJS_TESTS) {
	test('execute directory with relative path (node)', () => {
		const tmpDir = mktempdir()
		try {
			mkdirSync(join(tmpDir, 'test-dir'))
			writeFileSync(join(tmpDir, 'test-dir', 'index.js'), 'console.log("relative")')

			const output = execSync(`node ./test-dir`, {
				encoding: 'utf8',
				cwd: tmpDir
			}).trim()

			if (output !== 'relative') {
				throw new Error(`Expected 'relative', got '${output}'`)
			}
		} finally {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	})
}

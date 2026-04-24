// Test that node:* module imports work in workers
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

self.onmessage = (event) => {
	try {
		// Read this worker's own source file
		const src = readFileSync(import.meta.filename, 'utf8')
		self.postMessage({
			ok: true,
			hasImport: src.includes('import { readFileSync }'),
			dirname: dirname(import.meta.filename),
		})
	} catch (e) {
		self.postMessage({ ok: false, error: e.message })
	}
}

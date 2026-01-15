#!/usr/bin/env qx
// Search and replace in files using sed

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const [file, search, replace] = argv

if (!file || !search || !replace) {
	echo('Usage: qx search-replace.js <file> <search> <replace>')
	process.exit(1)
}

if (!existsSync(file)) {
	echo(`Error: File not found: ${file}`)
	process.exit(1)
}

const content = readFileSync(file, 'utf8')
const updated = content.replaceAll(search, replace)
writeFileSync(file, updated)

const count = (content.match(new RegExp(search, 'g')) || []).length
echo(`Replaced ${count} occurrence(s) of "${search}" with "${replace}"`)

#!/usr/bin/env qx
// List files with their sizes

const dir = argv[0] || '.'

const files = await $`ls -1 ${dir}`.quiet().lines()

for (const file of files) {
	const size = await $`stat -c %s ${dir}/${file}`.quiet().text()
	echo(`${file}: ${size} bytes`)
}

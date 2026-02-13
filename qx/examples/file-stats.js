#!/usr/bin/env qx
// List files with their sizes

const dir = argv[0] || '.'

const files = await $`ls -1 ${dir}`.quiet().lines()

for (const file of files) {
	const size = (await $`wc -c < ${dir}/${file}`.quiet().text()).trim()
	echo(`${file}: ${size} bytes`)
}

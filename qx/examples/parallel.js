#!/usr/bin/env qx
// Run commands in parallel

const urls = [
	'example.com',
	'google.com',
	'github.com',
]

echo('Pinging hosts in parallel...')

const results = await Promise.all(
	urls.map(async (url) => {
		const result = await $`ping -c 1 -W 1 ${url}`.nothrow()
		return { url, ok: result.exitCode === 0 }
	})
)

for (const { url, ok } of results) {
	echo(`${url}: ${ok ? 'reachable' : 'unreachable'}`)
}

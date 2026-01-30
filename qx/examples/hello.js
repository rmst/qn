#!/usr/bin/env qx
// Simple hello world example

const name = argv[0] || 'World'
const result = await $`echo Hello, ${name}!`.quiet()
echo(result.text())

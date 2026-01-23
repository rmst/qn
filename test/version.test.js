import { test as nodetest } from 'node:test'
import assert from 'node:assert'
import { $, QN, QX } from './util.js'

nodetest('qn --version outputs version string', () => {
	const output = $`${QN()} --version`
	assert.match(output, /^qn [a-f0-9]+/, 'should start with "qn <commit>"')
})

nodetest('qn -V outputs version string', () => {
	const output = $`${QN()} -V`
	assert.match(output, /^qn [a-f0-9]+/, 'should start with "qn <commit>"')
})

nodetest('qx --version outputs version string', () => {
	const output = $`${QX()} --version`
	assert.match(output, /^qx [a-f0-9]+/, 'should start with "qx <commit>"')
})

nodetest('qx -V outputs version string', () => {
	const output = $`${QX()} -V`
	assert.match(output, /^qx [a-f0-9]+/, 'should start with "qx <commit>"')
})

nodetest('dirty build includes build time', () => {
	const output = $`${QN()} --version`
	// If dirty, format is: qn <commit> (dirty, built <timestamp>)
	// If clean, format is: qn <commit>
	if (output.includes('dirty')) {
		assert.match(output, /\(dirty, built \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)$/)
	}
})

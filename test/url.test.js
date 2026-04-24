import { describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { test, testQnOnly, $ } from './util.js'

describe('URL constructor', () => {
	test('parses full URL with all components', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('https://user:pass@example.com:8080/path/to/page?foo=bar&baz=qux#section')
			console.log(JSON.stringify({
				href: url.href,
				origin: url.origin,
				protocol: url.protocol,
				username: url.username,
				password: url.password,
				host: url.host,
				hostname: url.hostname,
				port: url.port,
				pathname: url.pathname,
				search: url.search,
				hash: url.hash
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			href: 'https://user:pass@example.com:8080/path/to/page?foo=bar&baz=qux#section',
			origin: 'https://example.com:8080',
			protocol: 'https:',
			username: 'user',
			password: 'pass',
			host: 'example.com:8080',
			hostname: 'example.com',
			port: '8080',
			pathname: '/path/to/page',
			search: '?foo=bar&baz=qux',
			hash: '#section'
		})
	})

	test('parses simple URL without optional components', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('https://example.com')
			console.log(JSON.stringify({
				href: url.href,
				origin: url.origin,
				protocol: url.protocol,
				username: url.username,
				password: url.password,
				host: url.host,
				hostname: url.hostname,
				port: url.port,
				pathname: url.pathname,
				search: url.search,
				hash: url.hash
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			href: 'https://example.com/',
			origin: 'https://example.com',
			protocol: 'https:',
			username: '',
			password: '',
			host: 'example.com',
			hostname: 'example.com',
			port: '',
			pathname: '/',
			search: '',
			hash: ''
		})
	})

	test('resolves relative URL with base', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('/new/path', 'https://example.com/old/path')
			console.log(JSON.stringify({
				href: url.href,
				pathname: url.pathname
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			href: 'https://example.com/new/path',
			pathname: '/new/path'
		})
	})

	test('resolves relative path with base', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('subdir/file.html', 'https://example.com/path/to/')
			console.log(url.href)
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'https://example.com/path/to/subdir/file.html')
	})

	test('throws on invalid URL', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				new URL('not a valid url')
				console.log('no error')
			} catch (e) {
				console.log(e.name)
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'TypeError')
	})

	test('throws on invalid base URL', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				new URL('/path', 'not valid')
				console.log('no error')
			} catch (e) {
				console.log(e.name)
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'TypeError')
	})

	test('omits default port for http', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('http://example.com:80/path')
			console.log(JSON.stringify({ port: url.port, host: url.host }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { port: '', host: 'example.com' })
	})

	test('omits default port for https', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('https://example.com:443/path')
			console.log(JSON.stringify({ port: url.port, host: url.host }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { port: '', host: 'example.com' })
	})
})

describe('URL static methods', () => {
	test('URL.canParse returns true for valid URL', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.log(URL.canParse('https://example.com'))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'true')
	})

	test('URL.canParse returns false for invalid URL', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			console.log(URL.canParse('not valid'))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'false')
	})

	test('URL.parse returns URL for valid input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = URL.parse('https://example.com/path')
			console.log(url ? url.pathname : 'null')
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), '/path')
	})

	test('URL.parse returns null for invalid input', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = URL.parse('not valid')
			console.log(url)
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'null')
	})
})

describe('URL property setters', () => {
	test('setting pathname updates href', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('https://example.com/old')
			url.pathname = '/new/path'
			console.log(url.href)
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'https://example.com/new/path')
	})

	test('setting search updates href and searchParams', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('https://example.com/path')
			url.search = '?a=1&b=2'
			console.log(JSON.stringify({
				href: url.href,
				a: url.searchParams.get('a'),
				b: url.searchParams.get('b')
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			href: 'https://example.com/path?a=1&b=2',
			a: '1',
			b: '2'
		})
	})

	test('setting hash updates href', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('https://example.com/path')
			url.hash = '#section'
			console.log(url.href)
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'https://example.com/path#section')
	})

	test('setting hostname updates href', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('https://old.example.com/path')
			url.hostname = 'new.example.com'
			console.log(url.href)
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'https://new.example.com/path')
	})
})

describe('URL.searchParams integration', () => {
	test('searchParams reflects query string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('https://example.com?foo=1&bar=2')
			console.log(JSON.stringify({
				foo: url.searchParams.get('foo'),
				bar: url.searchParams.get('bar'),
				missing: url.searchParams.get('missing')
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			foo: '1',
			bar: '2',
			missing: null
		})
	})

	test('modifying searchParams updates URL', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('https://example.com?a=1')
			url.searchParams.set('a', '2')
			url.searchParams.append('b', '3')
			console.log(url.search)
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), '?a=2&b=3')
	})

	test('deleting from searchParams updates URL', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('https://example.com?a=1&b=2&c=3')
			url.searchParams.delete('b')
			console.log(url.search)
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), '?a=1&c=3')
	})
})

describe('URLSearchParams', () => {
	test('constructor with string', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams('a=1&b=2&c=3')
			console.log(params.toString())
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'a=1&b=2&c=3')
	})

	test('constructor with string starting with ?', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams('?a=1&b=2')
			console.log(params.toString())
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'a=1&b=2')
	})

	test('constructor with object', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams({ foo: 'bar', baz: 'qux' })
			console.log(JSON.stringify({
				foo: params.get('foo'),
				baz: params.get('baz')
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { foo: 'bar', baz: 'qux' })
	})

	test('constructor with array of pairs', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams([['a', '1'], ['b', '2']])
			console.log(params.toString())
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'a=1&b=2')
	})

	test('get returns first value', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams('a=1&a=2&a=3')
			console.log(params.get('a'))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), '1')
	})

	test('getAll returns all values', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams('a=1&a=2&a=3')
			console.log(JSON.stringify(params.getAll('a')))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), ['1', '2', '3'])
	})

	test('has checks existence', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams('a=1&b=2')
			console.log(JSON.stringify({
				hasA: params.has('a'),
				hasC: params.has('c')
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { hasA: true, hasC: false })
	})

	test('set replaces all values', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams('a=1&a=2&b=3')
			params.set('a', 'new')
			console.log(params.toString())
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'a=new&b=3')
	})

	test('append adds new value', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams('a=1')
			params.append('a', '2')
			params.append('b', '3')
			console.log(params.toString())
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'a=1&a=2&b=3')
	})

	test('delete removes all values for key', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams('a=1&a=2&b=3')
			params.delete('a')
			console.log(params.toString())
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'b=3')
	})

	test('sort orders alphabetically', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams('c=3&a=1&b=2')
			params.sort()
			console.log(params.toString())
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'a=1&b=2&c=3')
	})

	test('size returns count', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams('a=1&b=2&c=3')
			console.log(params.size)
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), '3')
	})

	test('iteration with for...of', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams('a=1&b=2')
			const result = []
			for (const [key, value] of params) {
				result.push([key, value])
			}
			console.log(JSON.stringify(result))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), [['a', '1'], ['b', '2']])
	})

	test('keys iterator', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams('a=1&b=2')
			console.log(JSON.stringify([...params.keys()]))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), ['a', 'b'])
	})

	test('values iterator', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams('a=1&b=2')
			console.log(JSON.stringify([...params.values()]))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), ['1', '2'])
	})

	test('forEach callback', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams('a=1&b=2')
			const result = []
			params.forEach((value, key) => result.push([key, value]))
			console.log(JSON.stringify(result))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), [['a', '1'], ['b', '2']])
	})

	test('encodes special characters', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const params = new URLSearchParams()
			params.set('q', 'hello world')
			params.set('special', 'a=b&c=d')
			console.log(params.toString())
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'q=hello+world&special=a%3Db%26c%3Dd')
	})
})

describe('URL IDN limitation', () => {
	testQnOnly('throws on non-ASCII hostname', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			try {
				new URL('https://münchen.de/')
				console.log('no error')
			} catch (e) {
				console.log(e.name + ': ' + (e.message.includes('IDN') || e.message.includes('Internationalized') ? 'IDN error' : 'other'))
			}
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'TypeError: IDN error')
	})
})

describe('URL toString and toJSON', () => {
	test('toString returns href', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('https://example.com/path')
			console.log(url.toString())
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.strictEqual(output.trim(), 'https://example.com/path')
	})

	test('toJSON returns href', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('https://example.com/path')
			console.log(JSON.stringify({ url }))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), { url: 'https://example.com/path' })
	})
})

describe('URL edge cases', () => {
	test('file URL', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('file:///path/to/file.txt')
			console.log(JSON.stringify({
				protocol: url.protocol,
				pathname: url.pathname,
				origin: url.origin
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			protocol: 'file:',
			pathname: '/path/to/file.txt',
			origin: 'null'
		})
	})

	test('IPv4 address', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('http://192.168.1.1:8080/path')
			console.log(JSON.stringify({
				hostname: url.hostname,
				port: url.port
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hostname: '192.168.1.1',
			port: '8080'
		})
	})

	test('IPv6 address', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('http://[::1]:8080/path')
			console.log(JSON.stringify({
				hostname: url.hostname,
				host: url.host
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			hostname: '[::1]',
			host: '[::1]:8080'
		})
	})

	test('URL with encoded characters', ({ bin, dir }) => {
		writeFileSync(`${dir}/test.js`, `
			const url = new URL('https://example.com/path%20with%20spaces?q=hello%20world')
			console.log(JSON.stringify({
				pathname: url.pathname,
				search: url.search
			}))
		`)
		const output = $`${bin} ${dir}/test.js`
		assert.deepStrictEqual(JSON.parse(output), {
			pathname: '/path%20with%20spaces',
			search: '?q=hello%20world'
		})
	})
})

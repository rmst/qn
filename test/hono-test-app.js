const { Hono } = await import(process.env.HONO_PATH + '/dist/hono.js')
import { createServer } from 'node:http'

const app = new Hono()

app.get('/', (c) => c.text('Hello from Hono on qn!'))

app.get('/json', (c) => c.json({ message: 'Hello', runtime: 'qn' }))

app.get('/params/:name', (c) => c.text(`Hello ${c.req.param('name')}!`))

app.post('/echo', async (c) => {
	const body = await c.req.text()
	return c.text(`Echo: ${body}`)
})

app.get('/headers', (c) => {
	c.header('X-Custom', 'hello')
	return c.json({ custom: c.req.header('x-test') || 'none' })
})

app.get('/redirect', (c) => c.redirect('/'))

app.get('/status', (c) => c.text('Not Found', 404))

// Bridge: convert node:http request/response to Hono's fetch interface
const server = createServer(async (req, res) => {
	const url = `http://${req.headers.host || 'localhost'}${req.url}`

	// Collect body for non-GET requests
	let body = null
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		const chunks = []
		req.on('data', (chunk) => chunks.push(chunk))
		await new Promise((resolve) => req.on('end', resolve))
		if (chunks.length > 0) {
			body = new TextDecoder().decode(
				chunks.length === 1 ? chunks[0]
					: chunks.reduce((acc, c) => {
						const result = new Uint8Array(acc.length + c.length)
						result.set(acc, 0)
						result.set(c, acc.length)
						return result
					}, new Uint8Array(0))
			)
		}
	}

	const request = new Request(url, {
		method: req.method,
		headers: req.headers,
		body,
	})

	const response = await app.fetch(request)

	res.writeHead(response.status, Object.fromEntries(response.headers))
	const responseBody = await response.text()
	res.end(responseBody)
})

server.listen(0, '127.0.0.1', () => {
	console.log(server.address().port)
})

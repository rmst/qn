const { Hono } = await import(process.env.HONO_PATH + '/dist/hono.js')
import { serve } from 'qn:http'

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

const server = await serve({ port: 0 }, (req) => app.fetch(req))
console.log(server.address().port)

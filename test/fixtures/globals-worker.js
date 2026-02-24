// Test that node-globals are available in workers
self.onmessage = (event) => {
	const results = {}

	// setTimeout
	results.hasSetTimeout = typeof setTimeout === 'function'
	results.hasClearTimeout = typeof clearTimeout === 'function'
	results.hasSetInterval = typeof setInterval === 'function'

	// Buffer
	results.hasBuffer = typeof Buffer === 'function'
	results.bufferWorks = Buffer.from('hello').toString('hex') === '68656c6c6f'

	// URL
	results.hasURL = typeof URL === 'function'
	results.urlWorks = new URL('https://example.com/path').pathname === '/path'

	// TextEncoder/TextDecoder
	results.hasTextEncoder = typeof TextEncoder === 'function'
	results.hasTextDecoder = typeof TextDecoder === 'function'
	results.textEncoderWorks = new TextEncoder().encode('hi').length === 2

	// performance.now
	results.hasPerformanceNow = typeof performance?.now === 'function'
	results.performanceWorks = performance.now() > 0

	// process
	results.hasProcess = typeof process === 'object'
	results.hasPid = typeof process?.pid === 'number'

	// console
	results.hasConsoleError = typeof console?.error === 'function'

	self.postMessage(results)
}

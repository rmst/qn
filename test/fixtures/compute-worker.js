// Worker that does computation and sends result back
self.onmessage = (event) => {
	const { op, values } = event.data
	let result
	if (op === 'sum') {
		result = values.reduce((a, b) => a + b, 0)
	} else if (op === 'multiply') {
		result = values.reduce((a, b) => a * b, 1)
	}
	self.postMessage({ op, result })
}

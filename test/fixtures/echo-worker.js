// Simple echo worker - sends back whatever it receives
self.onmessage = (event) => {
	self.postMessage(event.data)
}

// TypeScript worker - tests that TS source transform works in workers
interface Message {
	value: number
}

self.onmessage = (event: { data: Message }) => {
	const doubled: number = event.data.value * 2
	self.postMessage({ doubled })
}

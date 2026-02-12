/*
 * node:stream/promises - Promise-based stream utilities
 */

/**
 * Pipeline streams together, returning a promise that resolves when done.
 * Supports readable -> writable piping with error handling.
 *
 * @param {...(Readable|Writable)} streams - Streams to pipeline
 * @returns {Promise<void>}
 */
export function pipeline(...streams) {
	// Handle the case where last arg is options
	let options
	if (streams.length > 0 && typeof streams[streams.length - 1] === 'object' && !streams[streams.length - 1].on) {
		options = streams.pop()
	}

	if (streams.length < 2) {
		return Promise.reject(new Error('pipeline requires at least 2 streams'))
	}

	return new Promise((resolve, reject) => {
		let error = null

		const cleanup = (err) => {
			if (error) return
			error = err || null
			// Destroy all streams on error
			if (err) {
				for (const stream of streams) {
					if (stream.destroy && !stream.destroyed) {
						stream.destroy()
					}
				}
				reject(err)
			} else {
				resolve()
			}
		}

		// Connect each pair of streams
		for (let i = 0; i < streams.length - 1; i++) {
			const src = streams[i]
			const dst = streams[i + 1]

			src.on('error', cleanup)

			src.on('data', (chunk) => {
				if (!dst.destroyed) {
					dst.write(chunk)
				}
			})

			if (i === streams.length - 2) {
				// Last destination
				dst.on('error', cleanup)
				src.on('end', () => {
					if (!dst.destroyed) {
						dst.end()
					}
				})
				dst.on('finish', () => cleanup())
			} else {
				src.on('end', () => {
					// For intermediate transforms, signal end
				})
			}
		}
	})
}

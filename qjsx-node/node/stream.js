import * as os from 'os'
import { EventEmitter } from 'node:events'

/**
 * Readable stream that wraps a file descriptor.
 * Emits 'data' events as data becomes available.
 * @extends EventEmitter
 *
 * Events:
 * - 'data' (chunk: string) - Emitted when data is available
 * - 'end' - Emitted when EOF is reached
 * - 'error' (err: Error) - Emitted on read error
 * - 'close' - Emitted when stream is closed
 */
export class Readable extends EventEmitter {
	/** @type {number|null} */
	#fd = null

	/** @type {boolean} */
	#flowing = true

	/** @type {boolean} */
	#ended = false

	/** @type {boolean} */
	#destroyed = false

	/** @type {string[]} */
	#buffer = []

	/**
	 * @param {number} fd - File descriptor to read from
	 */
	constructor(fd) {
		super()
		this.#fd = fd
		this.#setupReadHandler()
	}

	#setupReadHandler() {
		if (this.#fd === null) return

		os.setReadHandler(this.#fd, () => {
			if (this.#destroyed) return

			const buf = new Uint8Array(4096)
			let n
			try {
				n = os.read(this.#fd, buf.buffer, 0, buf.length)
			} catch (e) {
				this.#handleError(e)
				return
			}

			if (n > 0) {
				const chunk = decodeUtf8(buf.subarray(0, n))
				if (this.#flowing) {
					this.emit('data', chunk)
				} else {
					this.#buffer.push(chunk)
				}
			} else {
				// EOF
				this.#ended = true
				os.setReadHandler(this.#fd, null)
				this.emit('end')
				this.#close()
			}
		})
	}

	#handleError(err) {
		this.#ended = true
		if (this.#fd !== null) {
			os.setReadHandler(this.#fd, null)
		}
		this.emit('error', err instanceof Error ? err : new Error(String(err)))
		this.#close()
	}

	#close() {
		if (this.#fd !== null) {
			try {
				os.close(this.#fd)
			} catch (e) {
				// Ignore close errors
			}
			this.#fd = null
		}
		if (!this.#destroyed) {
			this.#destroyed = true
			this.emit('close')
		}
	}

	/**
	 * Pause the stream - stop emitting 'data' events
	 * @returns {this}
	 */
	pause() {
		this.#flowing = false
		return this
	}

	/**
	 * Resume the stream - start emitting 'data' events again
	 * @returns {this}
	 */
	resume() {
		if (!this.#flowing) {
			this.#flowing = true
			// Flush buffered data
			while (this.#buffer.length > 0 && this.#flowing) {
				const chunk = this.#buffer.shift()
				this.emit('data', chunk)
			}
		}
		return this
	}

	/**
	 * Destroy the stream
	 * @param {Error} [error] - Optional error to emit
	 */
	destroy(error) {
		if (this.#destroyed) return

		if (this.#fd !== null) {
			os.setReadHandler(this.#fd, null)
		}

		if (error) {
			this.emit('error', error)
		}

		this.#close()
	}

	/**
	 * Whether the stream has ended
	 * @returns {boolean}
	 */
	get readableEnded() {
		return this.#ended
	}

	/**
	 * Whether the stream is destroyed
	 * @returns {boolean}
	 */
	get destroyed() {
		return this.#destroyed
	}
}

/**
 * Writable stream that wraps a file descriptor.
 * Supports backpressure via 'drain' events.
 * @extends EventEmitter
 *
 * Events:
 * - 'drain' - Emitted when buffer has been flushed and more data can be written
 * - 'finish' - Emitted when end() is called and all data has been flushed
 * - 'error' (err: Error) - Emitted on write error
 * - 'close' - Emitted when stream is closed
 */
export class Writable extends EventEmitter {
	/** @type {number|null} */
	#fd = null

	/** @type {boolean} */
	#finished = false

	/** @type {boolean} */
	#destroyed = false

	/** @type {boolean} */
	#ending = false

	/** @type {string[]} */
	#writeQueue = []

	/** @type {Function[]} */
	#callbackQueue = []

	/** @type {boolean} */
	#corked = false

	/** @type {boolean} */
	#needDrain = false

	/**
	 * @param {number} fd - File descriptor to write to
	 */
	constructor(fd) {
		super()
		this.#fd = fd
	}

	/**
	 * Write data to the stream
	 * @param {string} chunk - Data to write
	 * @param {Function} [callback] - Called when chunk has been written
	 * @returns {boolean} - false if buffer is full (wait for 'drain')
	 */
	write(chunk, callback) {
		if (this.#destroyed || this.#ending) {
			const err = new Error('write after end')
			if (callback) {
				os.setTimeout(() => callback(err), 0)
			}
			this.emit('error', err)
			return false
		}

		if (typeof chunk !== 'string') {
			chunk = String(chunk)
		}

		this.#writeQueue.push(chunk)
		if (callback) {
			this.#callbackQueue.push(callback)
		} else {
			this.#callbackQueue.push(null)
		}

		if (!this.#corked) {
			this.#flush()
		}

		// Return false if we have pending writes (backpressure)
		if (this.#writeQueue.length > 0) {
			this.#needDrain = true
			return false
		}

		return true
	}

	#flush() {
		if (this.#fd === null || this.#destroyed) return

		while (this.#writeQueue.length > 0) {
			const chunk = this.#writeQueue[0]
			const callback = this.#callbackQueue[0]
			const bytes = encodeUtf8(chunk)

			let written
			try {
				written = os.write(this.#fd, bytes.buffer, 0, bytes.length)
			} catch (e) {
				// EAGAIN/EWOULDBLOCK - set up write handler for when fd is writable
				if (e.errno === os.EAGAIN || e.errno === os.EWOULDBLOCK) {
					this.#setupWriteHandler()
					return
				}
				this.#handleError(e)
				return
			}

			if (written < bytes.length) {
				// Partial write - update queue with remaining data
				const remaining = decodeUtf8(bytes.subarray(written))
				this.#writeQueue[0] = remaining
				this.#setupWriteHandler()
				return
			}

			// Full write - remove from queue and call callback
			this.#writeQueue.shift()
			this.#callbackQueue.shift()
			if (callback) {
				callback(null)
			}
		}

		// All data written
		if (this.#needDrain) {
			this.#needDrain = false
			this.emit('drain')
		}

		if (this.#ending) {
			this.#finishEnd()
		}
	}

	#setupWriteHandler() {
		if (this.#fd === null) return

		os.setWriteHandler(this.#fd, () => {
			os.setWriteHandler(this.#fd, null)
			this.#flush()
		})
	}

	#handleError(err) {
		this.#destroyed = true
		if (this.#fd !== null) {
			os.setWriteHandler(this.#fd, null)
		}
		this.emit('error', err instanceof Error ? err : new Error(String(err)))
		this.#close()
	}

	#close() {
		if (this.#fd !== null) {
			try {
				os.close(this.#fd)
			} catch (e) {
				// Ignore close errors
			}
			this.#fd = null
		}
		if (!this.#destroyed) {
			this.#destroyed = true
		}
		this.emit('close')
	}

	#finishEnd() {
		if (this.#finished) return
		this.#finished = true
		this.emit('finish')
		this.#close()
	}

	/**
	 * Signal that no more data will be written
	 * @param {string} [chunk] - Optional final chunk to write
	 * @param {Function} [callback] - Called when stream is finished
	 */
	end(chunk, callback) {
		if (typeof chunk === 'function') {
			callback = chunk
			chunk = undefined
		}

		if (chunk !== undefined) {
			this.write(chunk)
		}

		this.#ending = true

		if (callback) {
			this.once('finish', callback)
		}

		if (this.#writeQueue.length === 0) {
			this.#finishEnd()
		}
	}

	/**
	 * Destroy the stream
	 * @param {Error} [error] - Optional error to emit
	 */
	destroy(error) {
		if (this.#destroyed) return

		// Cancel pending callbacks
		for (const cb of this.#callbackQueue) {
			if (cb) cb(error || new Error('stream destroyed'))
		}
		this.#writeQueue = []
		this.#callbackQueue = []

		if (this.#fd !== null) {
			os.setWriteHandler(this.#fd, null)
		}

		if (error) {
			this.emit('error', error)
		}

		this.#close()
	}

	/**
	 * Cork the stream - buffer writes until uncork() is called
	 */
	cork() {
		this.#corked = true
	}

	/**
	 * Uncork the stream - flush buffered writes
	 */
	uncork() {
		this.#corked = false
		this.#flush()
	}

	/**
	 * Whether the stream is finished
	 * @returns {boolean}
	 */
	get writableFinished() {
		return this.#finished
	}

	/**
	 * Whether the stream is destroyed
	 * @returns {boolean}
	 */
	get destroyed() {
		return this.#destroyed
	}
}

/**
 * Decode a Uint8Array as UTF-8 string
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeUtf8(bytes) {
	let result = ''
	for (let i = 0; i < bytes.length; i++) {
		result += String.fromCharCode(bytes[i])
	}
	return result
}

/**
 * Encode a string as UTF-8 Uint8Array
 * @param {string} str
 * @returns {Uint8Array}
 */
function encodeUtf8(str) {
	const bytes = new Uint8Array(str.length)
	for (let i = 0; i < str.length; i++) {
		bytes[i] = str.charCodeAt(i) & 0xFF
	}
	return bytes
}

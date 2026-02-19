import * as std from 'std'
import {
	openSync, closeSync, readSync, writeSync,
	O_RDONLY, O_WRONLY, O_CREAT, O_APPEND, O_TRUNC,
} from 'qn:uv-fs'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { setTimeout as _setTimeout } from 'qn_vm'

/**
 * Readable stream for reading from a file path.
 * Supports start/end byte offsets for range reads.
 */
export class ReadStream extends EventEmitter {
	#fd = null
	#path
	#start
	#end
	#pos
	#flowing = false
	#ended = false
	#destroyed = false
	#readSize = 65536
	#paused = true

	constructor(path, options = {}) {
		super()
		this.#path = path
		this.#start = options.start ?? 0
		this.#end = options.end ?? Infinity
		this.#pos = this.#start
		this.path = path

		// Open the file
		try {
			this.#fd = openSync(path, 'r')
		} catch (e) {
			// Defer error to next tick
			_setTimeout(() => {
				this.emit('error', e instanceof Error ? e : new Error(String(e)))
			}, 0)
			return
		}

		// Defer 'open' and start reading on next tick
		_setTimeout(() => {
			this.emit('open', this.#fd)
			if (!this.#destroyed) {
				this.#startReading()
			}
		}, 0)
	}

	#startReading() {
		this.#paused = false
		this.#readChunk()
	}

	#readChunk() {
		if (this.#destroyed || this.#ended || this.#paused) return

		const remaining = this.#end === Infinity ? this.#readSize : Math.min(this.#readSize, this.#end - this.#pos + 1)
		if (remaining <= 0) {
			this.#finish()
			return
		}

		const buf = new Uint8Array(remaining)
		let n
		try {
			// Use position parameter directly — no seek needed
			n = readSync(this.#fd, buf, this.#pos)
		} catch (e) {
			this.emit('error', e instanceof Error ? e : new Error(String(e)))
			this.destroy()
			return
		}

		if (n > 0) {
			this.#pos += n
			const chunk = Buffer.from(buf.buffer, 0, n)
			this.emit('data', chunk)
			// Schedule next read
			if (!this.#paused && !this.#destroyed) {
				_setTimeout(() => this.#readChunk(), 0)
			}
		} else {
			this.#finish()
		}
	}

	#finish() {
		if (this.#ended) return
		this.#ended = true
		this.emit('end')
		this.destroy()
	}

	pause() {
		this.#paused = true
		return this
	}

	resume() {
		if (this.#paused) {
			this.#paused = false
			if (!this.#ended && !this.#destroyed) {
				this.#readChunk()
			}
		}
		return this
	}

	destroy(error) {
		if (this.#destroyed) return this
		this.#destroyed = true
		if (this.#fd !== null) {
			try { closeSync(this.#fd) } catch {}
			this.#fd = null
		}
		if (error) {
			this.emit('error', error)
		}
		this.emit('close')
		return this
	}

	get destroyed() { return this.#destroyed }
	get readableEnded() { return this.#ended }
}

/**
 * Writable stream for writing to a file path.
 */
export class WriteStream extends EventEmitter {
	#fd = null
	#path
	#destroyed = false
	#finished = false
	#ending = false
	bytesWritten = 0

	constructor(path, options = {}) {
		super()
		this.#path = path
		this.path = path

		const flags = options.flags === 'a' ? (O_WRONLY | O_CREAT | O_APPEND)
			: (O_WRONLY | O_CREAT | O_TRUNC)

		try {
			this.#fd = openSync(path, flags, options.mode ?? 0o666)
		} catch (e) {
			_setTimeout(() => {
				this.emit('error', e instanceof Error ? e : new Error(String(e)))
			}, 0)
			return
		}

		_setTimeout(() => {
			this.emit('open', this.#fd)
		}, 0)
	}

	write(chunk, encoding, callback) {
		if (typeof encoding === 'function') {
			callback = encoding
			encoding = undefined
		}
		if (this.#destroyed || this.#ending) {
			const err = new Error('write after end')
			if (callback) callback(err)
			return false
		}

		let bytes
		if (typeof chunk === 'string') {
			bytes = new Uint8Array(std._encodeUtf8(chunk))
		} else if (chunk instanceof Uint8Array) {
			bytes = chunk
		} else if (chunk instanceof ArrayBuffer) {
			bytes = new Uint8Array(chunk)
		} else if (ArrayBuffer.isView(chunk)) {
			bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
		} else {
			bytes = new Uint8Array(std._encodeUtf8(String(chunk)))
		}

		try {
			const written = writeSync(this.#fd, bytes)
			this.bytesWritten += written
			if (callback) callback(null)
			return true
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e))
			if (callback) callback(err)
			this.emit('error', err)
			return false
		}
	}

	end(chunk, encoding, callback) {
		if (typeof chunk === 'function') {
			callback = chunk
			chunk = undefined
		} else if (typeof encoding === 'function') {
			callback = encoding
			encoding = undefined
		}

		if (chunk !== undefined && chunk !== null) {
			this.write(chunk)
		}

		this.#ending = true
		if (callback) this.once('finish', callback)

		_setTimeout(() => {
			if (!this.#finished) {
				this.#finished = true
				this.emit('finish')
				this.destroy()
			}
		}, 0)
	}

	destroy(error) {
		if (this.#destroyed) return this
		this.#destroyed = true
		if (this.#fd !== null) {
			try { closeSync(this.#fd) } catch {}
			this.#fd = null
		}
		if (error) this.emit('error', error)
		this.emit('close')
		return this
	}

	get destroyed() { return this.#destroyed }
	get writableFinished() { return this.#finished }
}

export function createReadStream(path, options) {
	return new ReadStream(path, options)
}

export function createWriteStream(path, options) {
	return new WriteStream(path, options)
}

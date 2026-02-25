import * as std from 'std'

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = new Uint8Array(128)
for (let i = 0; i < BASE64_CHARS.length; i++) {
	BASE64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i
}

function base64Encode(bytes) {
	let result = ''
	for (let i = 0; i < bytes.length; i += 3) {
		const b1 = bytes[i], b2 = bytes[i + 1] ?? 0, b3 = bytes[i + 2] ?? 0
		result += BASE64_CHARS[b1 >> 2]
		result += BASE64_CHARS[((b1 & 3) << 4) | (b2 >> 4)]
		result += i + 1 < bytes.length ? BASE64_CHARS[((b2 & 15) << 2) | (b3 >> 6)] : '='
		result += i + 2 < bytes.length ? BASE64_CHARS[b3 & 63] : '='
	}
	return result
}

function base64Decode(str) {
	let end = str.length
	while (end > 0 && str[end - 1] === '=') end--
	const bytes = new Uint8Array(Math.floor(end * 3 / 4))
	let j = 0
	for (let i = 0; i < end; i += 4) {
		const b1 = BASE64_LOOKUP[str.charCodeAt(i)]
		const b2 = BASE64_LOOKUP[str.charCodeAt(i + 1)]
		const b3 = BASE64_LOOKUP[str.charCodeAt(i + 2)]
		const b4 = BASE64_LOOKUP[str.charCodeAt(i + 3)]
		bytes[j++] = (b1 << 2) | (b2 >> 4)
		if (i + 2 < end) bytes[j++] = ((b2 & 15) << 4) | (b3 >> 2)
		if (i + 3 < end) bytes[j++] = ((b3 & 3) << 6) | b4
	}
	return bytes
}

function hexEncode(bytes) {
	return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexDecode(str) {
	const bytes = []
	for (let i = 0; i < str.length; i += 2) {
		bytes.push(parseInt(str.slice(i, i + 2), 16))
	}
	return new Uint8Array(bytes)
}

function normalizeEncoding(encoding) {
	if (!encoding) return 'utf8'
	const lower = encoding.toLowerCase()
	switch (lower) {
		case 'utf8':
		case 'utf-8':
			return 'utf8'
		case 'base64':
			return 'base64'
		case 'hex':
			return 'hex'
		case 'latin1':
		case 'binary':
			return 'latin1'
		case 'ascii':
			return 'ascii'
		default:
			throw new TypeError(`Unknown encoding: ${encoding}`)
	}
}

class Buffer extends Uint8Array {
	static from(value, encodingOrOffset, length) {
		if (typeof value === 'string') {
			const encoding = normalizeEncoding(encodingOrOffset)
			switch (encoding) {
				case 'utf8':
					return new Buffer(std._encodeUtf8(value))
				case 'base64':
					return new Buffer(base64Decode(value))
				case 'hex':
					return new Buffer(hexDecode(value))
				case 'latin1':
				case 'ascii':
					return new Buffer(Uint8Array.from(value, c => c.charCodeAt(0)))
				default:
					throw new TypeError(`Unknown encoding: ${encoding}`)
			}
		}

		if (value instanceof ArrayBuffer) {
			// Uint8Array(buffer, offset, length) creates a view (no copy)
			const offset = encodingOrOffset || 0
			const len = length !== undefined ? length : value.byteLength - offset
			return new Buffer(value, offset, len)
		}

		if (ArrayBuffer.isView(value)) {
			return new Buffer(value)
		}

		if (Array.isArray(value)) {
			return new Buffer(value)
		}

		throw new TypeError('First argument must be a string, Buffer, ArrayBuffer, Array, or array-like object')
	}

	static alloc(size, fill, encoding) {
		const buf = new Buffer(size)
		if (fill !== undefined) {
			buf.fill(fill, 0, size, encoding)
		}
		return buf
	}

	static allocUnsafe(size) {
		return new Buffer(size)
	}

	static isBuffer(obj) {
		return obj instanceof Buffer
	}

	static isEncoding(encoding) {
		try {
			normalizeEncoding(encoding)
			return true
		} catch {
			return false
		}
	}

	static concat(list, totalLength) {
		if (!Array.isArray(list)) {
			throw new TypeError('list argument must be an Array')
		}

		if (list.length === 0) {
			return Buffer.alloc(0)
		}

		if (totalLength === undefined) {
			totalLength = list.reduce((sum, buf) => sum + buf.length, 0)
		}

		const result = Buffer.alloc(totalLength)
		let offset = 0
		for (const buf of list) {
			const copyLength = Math.min(buf.length, totalLength - offset)
			result.set(buf.subarray(0, copyLength), offset)
			offset += copyLength
			if (offset >= totalLength) break
		}
		return result
	}

	static byteLength(string, encoding) {
		if (typeof string !== 'string') {
			if (ArrayBuffer.isView(string) || string instanceof ArrayBuffer) {
				return string.byteLength
			}
			throw new TypeError('First argument must be a string, Buffer, or ArrayBuffer')
		}

		const enc = normalizeEncoding(encoding)
		switch (enc) {
			case 'utf8':
				return std._encodeUtf8(string).byteLength
			case 'base64':
				// Calculate base64 decoded length
				const stripped = string.replace(/=+$/, '')
				return Math.floor(stripped.length * 3 / 4)
			case 'hex':
				return string.length / 2
			case 'latin1':
			case 'ascii':
				return string.length
			default:
				return std._encodeUtf8(string).byteLength
		}
	}

	toString(encoding, start, end) {
		const enc = normalizeEncoding(encoding)
		const slice = this.subarray(start || 0, end || this.length)

		switch (enc) {
			case 'utf8':
				return std._decodeUtf8(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength))
			case 'base64':
				return base64Encode(slice)
			case 'hex':
				return hexEncode(slice)
			case 'latin1':
			case 'ascii':
				return String.fromCharCode(...slice)
			default:
				return std._decodeUtf8(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength))
		}
	}

	write(string, offset, length, encoding) {
		// Handle overloaded signatures
		if (typeof offset === 'string') {
			encoding = offset
			offset = 0
			length = this.length
		} else if (typeof length === 'string') {
			encoding = length
			length = this.length - (offset || 0)
		}

		offset = offset || 0
		length = length !== undefined ? length : this.length - offset
		encoding = normalizeEncoding(encoding)

		let bytes
		switch (encoding) {
			case 'utf8':
				bytes = new Uint8Array(std._encodeUtf8(string))
				break
			case 'base64':
				bytes = base64Decode(string)
				break
			case 'hex':
				bytes = hexDecode(string)
				break
			case 'latin1':
			case 'ascii':
				bytes = Uint8Array.from(string, c => c.charCodeAt(0))
				break
			default:
				bytes = new Uint8Array(std._encodeUtf8(string))
		}

		const writeLength = Math.min(bytes.length, length, this.length - offset)
		this.set(bytes.subarray(0, writeLength), offset)
		return writeLength
	}

	copy(target, targetStart, sourceStart, sourceEnd) {
		targetStart = targetStart || 0
		sourceStart = sourceStart || 0
		sourceEnd = sourceEnd !== undefined ? sourceEnd : this.length

		const copyLength = Math.min(sourceEnd - sourceStart, target.length - targetStart)
		target.set(this.subarray(sourceStart, sourceStart + copyLength), targetStart)
		return copyLength
	}

	equals(other) {
		if (!(other instanceof Uint8Array)) {
			throw new TypeError('Argument must be a Buffer or Uint8Array')
		}
		if (this.length !== other.length) return false
		for (let i = 0; i < this.length; i++) {
			if (this[i] !== other[i]) return false
		}
		return true
	}

	compare(target, targetStart, targetEnd, sourceStart, sourceEnd) {
		if (!(target instanceof Uint8Array)) {
			throw new TypeError('Argument must be a Buffer or Uint8Array')
		}

		targetStart = targetStart || 0
		targetEnd = targetEnd !== undefined ? targetEnd : target.length
		sourceStart = sourceStart || 0
		sourceEnd = sourceEnd !== undefined ? sourceEnd : this.length

		const sourceSlice = this.subarray(sourceStart, sourceEnd)
		const targetSlice = target.subarray(targetStart, targetEnd)

		const len = Math.min(sourceSlice.length, targetSlice.length)
		for (let i = 0; i < len; i++) {
			if (sourceSlice[i] < targetSlice[i]) return -1
			if (sourceSlice[i] > targetSlice[i]) return 1
		}

		if (sourceSlice.length < targetSlice.length) return -1
		if (sourceSlice.length > targetSlice.length) return 1
		return 0
	}

	indexOf(value, byteOffset, encoding) {
		if (typeof value === 'number') {
			return super.indexOf(value, byteOffset)
		}
		if (typeof value === 'string') {
			const needle = Buffer.from(value, encoding)
			const start = byteOffset || 0
			outer: for (let i = start; i <= this.length - needle.length; i++) {
				for (let j = 0; j < needle.length; j++) {
					if (this[i + j] !== needle[j]) continue outer
				}
				return i
			}
			return -1
		}
		if (value instanceof Uint8Array) {
			const start = byteOffset || 0
			outer2: for (let i = start; i <= this.length - value.length; i++) {
				for (let j = 0; j < value.length; j++) {
					if (this[i + j] !== value[j]) continue outer2
				}
				return i
			}
			return -1
		}
		return super.indexOf(value, byteOffset)
	}

	includes(value, byteOffset, encoding) {
		return this.indexOf(value, byteOffset, encoding) !== -1
	}

	slice(start, end) {
		return new Buffer(this.subarray(start, end))
	}

	// Big-endian integer read methods
	readUInt8(offset = 0) { return this[offset] }
	readUInt16BE(offset = 0) { return (this[offset] << 8) | this[offset + 1] }
	readUInt16LE(offset = 0) { return this[offset] | (this[offset + 1] << 8) }
	readUInt32BE(offset = 0) {
		return (this[offset] * 0x1000000) + ((this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3])
	}
	readUInt32LE(offset = 0) {
		return (this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16)) + (this[offset + 3] * 0x1000000)
	}
	readInt8(offset = 0) { const v = this[offset]; return v > 127 ? v - 256 : v }
	readInt16BE(offset = 0) { const v = this.readUInt16BE(offset); return v > 0x7fff ? v - 0x10000 : v }
	readInt32BE(offset = 0) { return (this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3] }

	readUIntBE(offset, byteLength) {
		let val = 0
		for (let i = 0; i < byteLength; i++) val = val * 256 + this[offset + i]
		return val
	}

	// Big-endian integer write methods
	writeUInt8(value, offset = 0) { this[offset] = value & 0xff; return offset + 1 }
	writeUInt16BE(value, offset = 0) {
		this[offset] = (value >>> 8) & 0xff
		this[offset + 1] = value & 0xff
		return offset + 2
	}
	writeUInt16LE(value, offset = 0) {
		this[offset] = value & 0xff
		this[offset + 1] = (value >>> 8) & 0xff
		return offset + 2
	}
	writeUInt32BE(value, offset = 0) {
		this[offset] = (value >>> 24) & 0xff
		this[offset + 1] = (value >>> 16) & 0xff
		this[offset + 2] = (value >>> 8) & 0xff
		this[offset + 3] = value & 0xff
		return offset + 4
	}

	writeUIntBE(value, offset, byteLength) {
		for (let i = byteLength - 1; i >= 0; i--) {
			this[offset + i] = value & 0xff
			value = Math.floor(value / 256)
		}
		return offset + byteLength
	}

	toJSON() {
		return {
			type: 'Buffer',
			data: Array.from(this)
		}
	}
}

export { Buffer }
export default { Buffer }

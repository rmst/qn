import { EMPTY_BUFFER } from './constants.js'

/**
 * Masks a buffer using the given mask.
 *
 * @param {Buffer} source The buffer to mask
 * @param {Buffer} mask The mask to use (4 bytes)
 * @param {Buffer} output The buffer to write to
 * @param {Number} offset The offset to start writing at
 * @param {Number} length The number of bytes to mask
 */
function mask(source, mask, output, offset, length) {
	for (let i = 0; i < length; i++) {
		output[offset + i] = source[i] ^ mask[i & 3]
	}
}

/**
 * Unmasks a buffer using the given mask.
 *
 * @param {Buffer} buffer The buffer to unmask
 * @param {Buffer} mask The mask to use (4 bytes)
 */
function unmask(buffer, mask) {
	for (let i = 0; i < buffer.length; i++) {
		buffer[i] ^= mask[i & 3]
	}
}

/**
 * Converts a buffer-like value to a Buffer.
 *
 * @param {*} data The data to convert
 * @return {Buffer} A Buffer
 */
function toBuffer(data) {
	toBuffer.readOnly = true

	if (Buffer.isBuffer(data)) return data

	if (data instanceof ArrayBuffer) {
		toBuffer.readOnly = false
		return Buffer.from(data)
	}

	if (ArrayBuffer.isView(data)) {
		toBuffer.readOnly = false
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
	}

	toBuffer.readOnly = false

	if (data) {
		return Buffer.from(data)
	}

	return EMPTY_BUFFER
}

/**
 * Concatenates a list of buffers into a single buffer.
 *
 * @param {Buffer[]} list The list of buffers to concat
 * @param {Number} totalLength The total length of buffers in the list
 * @return {Buffer} The resulting buffer
 */
function concat(list, totalLength) {
	if (list.length === 0) return EMPTY_BUFFER
	if (list.length === 1) return list[0]

	const target = Buffer.allocUnsafe(totalLength)
	let offset = 0

	for (let i = 0; i < list.length; i++) {
		const buf = list[i]
		target.set(buf, offset)
		offset += buf.length
	}

	if (offset < totalLength) return target.slice(0, offset)
	return target
}

/**
 * Converts a Buffer to an ArrayBuffer.
 *
 * @param {Buffer} buf The buffer to convert
 * @return {ArrayBuffer} Converted ArrayBuffer
 */
function toArrayBuffer(buf) {
	if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
		return buf.buffer
	}

	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

export { mask, unmask, toBuffer, concat, toArrayBuffer }

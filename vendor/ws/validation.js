import { hasBlob } from './constants.js'

//
// Checks if a status code is allowed in a close frame.
//
const closeCodesRange = [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014]

/**
 * Checks if a given buffer contains a valid UTF-8 string.
 * Uses Buffer.isUtf8 if available, otherwise a manual check.
 *
 * @param {Buffer} buf The buffer to check
 * @return {Boolean}
 */
const isUtf8 = typeof Buffer.isUtf8 === 'function'
	? Buffer.isUtf8
	: function isUtf8(buf) {
		const len = buf.length
		let i = 0

		while (i < len) {
			if ((buf[i] & 0x80) === 0) {
				i++
			} else if ((buf[i] & 0xe0) === 0xc0) {
				if (
					i + 1 === len ||
					(buf[i + 1] & 0xc0) !== 0x80 ||
					(buf[i] & 0xfe) === 0xc0
				) {
					return false
				}
				i += 2
			} else if ((buf[i] & 0xf0) === 0xe0) {
				if (
					i + 2 >= len ||
					(buf[i + 1] & 0xc0) !== 0x80 ||
					(buf[i + 2] & 0xc0) !== 0x80 ||
					(buf[i] === 0xe0 && (buf[i + 1] & 0xe0) === 0x80) ||
					(buf[i] === 0xed && (buf[i + 1] & 0xe0) === 0xa0)
				) {
					return false
				}
				i += 3
			} else if ((buf[i] & 0xf8) === 0xf0) {
				if (
					i + 3 >= len ||
					(buf[i + 1] & 0xc0) !== 0x80 ||
					(buf[i + 2] & 0xc0) !== 0x80 ||
					(buf[i + 3] & 0xc0) !== 0x80 ||
					(buf[i] === 0xf0 && (buf[i + 1] & 0xf0) === 0x80) ||
					(buf[i] === 0xf4 && buf[i + 1] > 0x8f) ||
					buf[i] > 0xf4
				) {
					return false
				}
				i += 4
			} else {
				return false
			}
		}
		return true
	}

/**
 * Determines whether a value is a Blob.
 *
 * @param {*} value The value to check
 * @return {Boolean}
 */
function isBlob(value) {
	return hasBlob && value instanceof Blob
}

/**
 * Checks if a status code is valid for a close frame.
 *
 * @param {Number} code The status code
 * @return {Boolean}
 */
function isValidStatusCode(code) {
	return (
		(code >= 3000 && code <= 4999) ||
		closeCodesRange.includes(code)
	)
}

const isValidUTF8 = isUtf8

export { isUtf8, isBlob, isValidStatusCode, isValidUTF8 }

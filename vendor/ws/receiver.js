import { EventEmitter } from 'node:events'

import {
	BINARY_TYPES,
	EMPTY_BUFFER,
	kStatusCode,
	kWebSocket
} from './constants.js'
import { concat, toArrayBuffer, unmask } from './buffer-util.js'
import { isValidStatusCode, isValidUTF8 } from './validation.js'

const FastBuffer = Buffer[Symbol.species]

const GET_INFO = 0
const GET_PAYLOAD_LENGTH_16 = 1
const GET_PAYLOAD_LENGTH_64 = 2
const GET_MASK = 3
const GET_DATA = 4
const DEFER_EVENT = 6

/**
 * HyBi Receiver implementation.
 *
 * @extends EventEmitter
 */
class Receiver extends EventEmitter {
	/**
	 * Creates a Receiver instance.
	 *
	 * @param {Object} [options] Options object
	 * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
	 *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
	 *     multiple times in the same tick
	 * @param {String} [options.binaryType=nodebuffer] The type for binary data
	 * @param {Object} [options.extensions] An object containing the negotiated
	 *     extensions
	 * @param {Boolean} [options.isServer=false] Specifies whether to operate in
	 *     client or server mode
	 * @param {Number} [options.maxPayload=0] The maximum allowed message length
	 * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
	 *     not to skip UTF-8 validation for text and close messages
	 */
	constructor(options = {}) {
		super()

		this._writableState = { finished: false, errorEmitted: false, needDrain: false }

		this._allowSynchronousEvents =
			options.allowSynchronousEvents !== undefined
				? options.allowSynchronousEvents
				: true
		this._binaryType = options.binaryType || BINARY_TYPES[0]
		this._extensions = options.extensions || {}
		this._isServer = !!options.isServer
		this._maxPayload = options.maxPayload | 0
		this._skipUTF8Validation = !!options.skipUTF8Validation
		this[kWebSocket] = undefined

		this._bufferedBytes = 0
		this._buffers = []

		this._compressed = false
		this._payloadLength = 0
		this._mask = undefined
		this._fragmented = 0
		this._masked = false
		this._fin = false
		this._opcode = 0

		this._totalPayloadLength = 0
		this._messageLength = 0
		this._fragments = []

		this._errored = false
		this._loop = false
		this._state = GET_INFO
	}

	/**
	 * Write a chunk of data to the receiver.
	 *
	 * @param {Buffer} chunk The chunk of data to write
	 * @return {Boolean} false if backpressure, true otherwise
	 * @public
	 */
	write(chunk) {
		if (this._opcode === 0x08 && this._state == GET_INFO) return true

		this._bufferedBytes += chunk.length
		this._buffers.push(chunk)
		this.startLoop()
		return !this._writableState.needDrain
	}

	/**
	 * Signal that no more data will be written.
	 *
	 * @public
	 */
	end() {
		this._writableState.finished = true
		this.emit('finish')
	}

	/**
	 * Consumes `n` bytes from the buffered data.
	 *
	 * @param {Number} n The number of bytes to consume
	 * @return {Buffer} The consumed bytes
	 * @private
	 */
	consume(n) {
		this._bufferedBytes -= n

		if (n === this._buffers[0].length) return this._buffers.shift()

		if (n < this._buffers[0].length) {
			const buf = this._buffers[0]
			this._buffers[0] = new FastBuffer(
				buf.buffer,
				buf.byteOffset + n,
				buf.length - n
			)

			return new FastBuffer(buf.buffer, buf.byteOffset, n)
		}

		const dst = Buffer.allocUnsafe(n)

		do {
			const buf = this._buffers[0]
			const offset = dst.length - n

			if (n >= buf.length) {
				dst.set(this._buffers.shift(), offset)
			} else {
				dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset)
				this._buffers[0] = new FastBuffer(
					buf.buffer,
					buf.byteOffset + n,
					buf.length - n
				)
			}

			n -= buf.length
		} while (n > 0)

		return dst
	}

	/**
	 * Starts the parsing loop.
	 *
	 * @private
	 */
	startLoop() {
		this._loop = true

		do {
			switch (this._state) {
				case GET_INFO:
					this.getInfo()
					break
				case GET_PAYLOAD_LENGTH_16:
					this.getPayloadLength16()
					break
				case GET_PAYLOAD_LENGTH_64:
					this.getPayloadLength64()
					break
				case GET_MASK:
					this.getMask()
					break
				case GET_DATA:
					this.getData()
					break
				case DEFER_EVENT:
					this._loop = false
					return
			}
		} while (this._loop)
	}

	/**
	 * Reads the first two bytes of a frame.
	 *
	 * @private
	 */
	getInfo() {
		if (this._bufferedBytes < 2) {
			this._loop = false
			return
		}

		const buf = this.consume(2)

		if ((buf[0] & 0x30) !== 0x00) {
			const error = this.createError(
				RangeError,
				'RSV2 and RSV3 must be clear',
				true,
				1002,
				'WS_ERR_UNEXPECTED_RSV_2_3'
			)

			this._emitError(error)
			return
		}

		const compressed = (buf[0] & 0x40) === 0x40

		if (compressed && !this._extensions['permessage-deflate']) {
			const error = this.createError(
				RangeError,
				'RSV1 must be clear',
				true,
				1002,
				'WS_ERR_UNEXPECTED_RSV_1'
			)

			this._emitError(error)
			return
		}

		this._fin = (buf[0] & 0x80) === 0x80
		this._opcode = buf[0] & 0x0f
		this._payloadLength = buf[1] & 0x7f

		if (this._opcode === 0x00) {
			if (compressed) {
				const error = this.createError(
					RangeError,
					'RSV1 must be clear',
					true,
					1002,
					'WS_ERR_UNEXPECTED_RSV_1'
				)

				this._emitError(error)
				return
			}

			if (!this._fragmented) {
				const error = this.createError(
					RangeError,
					'invalid opcode 0',
					true,
					1002,
					'WS_ERR_INVALID_OPCODE'
				)

				this._emitError(error)
				return
			}

			this._opcode = this._fragmented
		} else if (this._opcode === 0x01 || this._opcode === 0x02) {
			if (this._fragmented) {
				const error = this.createError(
					RangeError,
					`invalid opcode ${this._opcode}`,
					true,
					1002,
					'WS_ERR_INVALID_OPCODE'
				)

				this._emitError(error)
				return
			}

			this._compressed = compressed
		} else if (this._opcode > 0x07 && this._opcode < 0x0b) {
			if (!this._fin) {
				const error = this.createError(
					RangeError,
					'FIN must be set',
					true,
					1002,
					'WS_ERR_EXPECTED_FIN'
				)

				this._emitError(error)
				return
			}

			if (compressed) {
				const error = this.createError(
					RangeError,
					'RSV1 must be clear',
					true,
					1002,
					'WS_ERR_UNEXPECTED_RSV_1'
				)

				this._emitError(error)
				return
			}

			if (
				this._payloadLength > 0x7d ||
				(this._opcode === 0x08 && this._payloadLength === 1)
			) {
				const error = this.createError(
					RangeError,
					`invalid payload length ${this._payloadLength}`,
					true,
					1002,
					'WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH'
				)

				this._emitError(error)
				return
			}
		} else {
			const error = this.createError(
				RangeError,
				`invalid opcode ${this._opcode}`,
				true,
				1002,
				'WS_ERR_INVALID_OPCODE'
			)

			this._emitError(error)
			return
		}

		if (!this._fin && !this._fragmented) this._fragmented = this._opcode
		this._masked = (buf[1] & 0x80) === 0x80

		if (this._isServer) {
			if (!this._masked) {
				const error = this.createError(
					RangeError,
					'MASK must be set',
					true,
					1002,
					'WS_ERR_EXPECTED_MASK'
				)

				this._emitError(error)
				return
			}
		} else if (this._masked) {
			const error = this.createError(
				RangeError,
				'MASK must be clear',
				true,
				1002,
				'WS_ERR_UNEXPECTED_MASK'
			)

			this._emitError(error)
			return
		}

		if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16
		else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64
		else this.haveLength()
	}

	/**
	 * Gets extended payload length (7+16).
	 *
	 * @private
	 */
	getPayloadLength16() {
		if (this._bufferedBytes < 2) {
			this._loop = false
			return
		}

		this._payloadLength = this.consume(2).readUInt16BE(0)
		this.haveLength()
	}

	/**
	 * Gets extended payload length (7+64).
	 *
	 * @private
	 */
	getPayloadLength64() {
		if (this._bufferedBytes < 8) {
			this._loop = false
			return
		}

		const buf = this.consume(8)
		const num = buf.readUInt32BE(0)

		//
		// The maximum safe integer in JavaScript is 2^53 - 1. An error is returned
		// if payload length is greater than this number.
		//
		if (num > Math.pow(2, 53 - 32) - 1) {
			const error = this.createError(
				RangeError,
				'Unsupported WebSocket frame: payload length > 2^53 - 1',
				false,
				1009,
				'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH'
			)

			this._emitError(error)
			return
		}

		this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4)
		this.haveLength()
	}

	/**
	 * Payload length has been read.
	 *
	 * @private
	 */
	haveLength() {
		if (this._payloadLength && this._opcode < 0x08) {
			this._totalPayloadLength += this._payloadLength
			if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
				const error = this.createError(
					RangeError,
					'Max payload size exceeded',
					false,
					1009,
					'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
				)

				this._emitError(error)
				return
			}
		}

		if (this._masked) this._state = GET_MASK
		else this._state = GET_DATA
	}

	/**
	 * Reads mask bytes.
	 *
	 * @private
	 */
	getMask() {
		if (this._bufferedBytes < 4) {
			this._loop = false
			return
		}

		this._mask = this.consume(4)
		this._state = GET_DATA
	}

	/**
	 * Reads data bytes.
	 *
	 * @private
	 */
	getData() {
		let data = EMPTY_BUFFER

		if (this._payloadLength) {
			if (this._bufferedBytes < this._payloadLength) {
				this._loop = false
				return
			}

			data = this.consume(this._payloadLength)

			if (
				this._masked &&
				(this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0
			) {
				unmask(data, this._mask)
			}
		}

		if (this._opcode > 0x07) {
			this.controlMessage(data)
			return
		}

		if (this._compressed) {
			// No compression support in this build
			const error = this.createError(
				Error,
				'Compressed frames not supported',
				false,
				1002,
				'WS_ERR_UNEXPECTED_RSV_1'
			)

			this._emitError(error)
			return
		}

		if (data.length) {
			//
			// This message is not compressed so its length is the sum of the payload
			// length of all fragments.
			//
			this._messageLength = this._totalPayloadLength
			this._fragments.push(data)
		}

		this.dataMessage()
	}

	/**
	 * Handles a data message.
	 *
	 * @private
	 */
	dataMessage() {
		if (!this._fin) {
			this._state = GET_INFO
			return
		}

		const messageLength = this._messageLength
		const fragments = this._fragments

		this._totalPayloadLength = 0
		this._messageLength = 0
		this._fragmented = 0
		this._fragments = []

		if (this._opcode === 2) {
			let data

			if (this._binaryType === 'nodebuffer') {
				data = concat(fragments, messageLength)
			} else if (this._binaryType === 'arraybuffer') {
				data = toArrayBuffer(concat(fragments, messageLength))
			} else if (this._binaryType === 'blob') {
				data = new Blob(fragments)
			} else {
				data = fragments
			}

			if (this._allowSynchronousEvents) {
				this.emit('message', data, true)
				this._state = GET_INFO
			} else {
				this._state = DEFER_EVENT
				setImmediate(() => {
					this.emit('message', data, true)
					this._state = GET_INFO
					this.startLoop()
				})
			}
		} else {
			const buf = concat(fragments, messageLength)

			if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
				const error = this.createError(
					Error,
					'invalid UTF-8 sequence',
					true,
					1007,
					'WS_ERR_INVALID_UTF8'
				)

				this._emitError(error)
				return
			}

			if (this._allowSynchronousEvents) {
				this.emit('message', buf, false)
				this._state = GET_INFO
			} else {
				this._state = DEFER_EVENT
				setImmediate(() => {
					this.emit('message', buf, false)
					this._state = GET_INFO
					this.startLoop()
				})
			}
		}
	}

	/**
	 * Handles a control message.
	 *
	 * @param {Buffer} data Data to handle
	 * @private
	 */
	controlMessage(data) {
		if (this._opcode === 0x08) {
			if (data.length === 0) {
				this._loop = false
				this.emit('conclude', 1005, EMPTY_BUFFER)
				this.end()
			} else {
				const code = data.readUInt16BE(0)

				if (!isValidStatusCode(code)) {
					const error = this.createError(
						RangeError,
						`invalid status code ${code}`,
						true,
						1002,
						'WS_ERR_INVALID_CLOSE_CODE'
					)

					this._emitError(error)
					return
				}

				const buf = new FastBuffer(
					data.buffer,
					data.byteOffset + 2,
					data.length - 2
				)

				if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
					const error = this.createError(
						Error,
						'invalid UTF-8 sequence',
						true,
						1007,
						'WS_ERR_INVALID_UTF8'
					)

					this._emitError(error)
					return
				}

				this._loop = false
				this.emit('conclude', code, buf)
				this.end()
			}

			this._state = GET_INFO
			return
		}

		if (this._allowSynchronousEvents) {
			this.emit(this._opcode === 0x09 ? 'ping' : 'pong', data)
			this._state = GET_INFO
		} else {
			this._state = DEFER_EVENT
			setImmediate(() => {
				this.emit(this._opcode === 0x09 ? 'ping' : 'pong', data)
				this._state = GET_INFO
				this.startLoop()
			})
		}
	}

	/**
	 * Emit an error and set error state.
	 *
	 * @param {Error} err The error to emit
	 * @private
	 */
	_emitError(err) {
		this._writableState.errorEmitted = true
		this.emit('error', err)
	}

	/**
	 * Builds an error object.
	 *
	 * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
	 * @param {String} message The error message
	 * @param {Boolean} prefix Specifies whether or not to add a default prefix to
	 *     `message`
	 * @param {Number} statusCode The status code
	 * @param {String} errorCode The exposed error code
	 * @return {(Error|RangeError)} The error
	 * @private
	 */
	createError(ErrorCtor, message, prefix, statusCode, errorCode) {
		this._loop = false
		this._errored = true

		const err = new ErrorCtor(
			prefix ? `Invalid WebSocket frame: ${message}` : message
		)

		Error.captureStackTrace(err, this.createError)
		err.code = errorCode
		err[kStatusCode] = statusCode
		return err
	}
}

export default Receiver

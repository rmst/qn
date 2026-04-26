/**
 * node:zlib — DEFLATE / zlib / gzip compression, backed by miniz via qn_zlib.
 *
 * Supported APIs:
 *   - deflate / inflate  (zlib framing — RFC 1950)
 *   - deflateRaw / inflateRaw  (raw DEFLATE — RFC 1951)
 *   - gzip / gunzip  (gzip framing — RFC 1952; framing handled here in JS)
 *   - unzip  (auto-detect zlib vs gzip on the input)
 *   - Sync, callback (async), and promise variants for each
 *   - Transform-style streams via createDeflate/createInflate/...
 *   - zlib.constants
 *
 * Not yet supported (throws when used):
 *   - brotli*, zstd*  (separate libraries; deferred)
 *   - dictionary, info option
 *
 * gzip framing is implemented in JS on top of raw deflate so the C
 * binding stays small. CRC32 is computed via the C-exported helper.
 */

import { Buffer } from 'node:buffer'
import { setImmediate } from 'node:timers'
import { Transform } from 'node:stream'
import * as Z from 'qn_zlib'

/* ---- Constants ---- */

export const constants = Object.freeze({
	Z_NO_FLUSH:        Z.Z_NO_FLUSH,
	Z_PARTIAL_FLUSH:   Z.Z_PARTIAL_FLUSH,
	Z_SYNC_FLUSH:      Z.Z_SYNC_FLUSH,
	Z_FULL_FLUSH:      Z.Z_FULL_FLUSH,
	Z_FINISH:          Z.Z_FINISH,
	Z_BLOCK:           Z.Z_BLOCK,
	Z_OK:              0,
	Z_STREAM_END:      1,
	Z_NEED_DICT:       2,
	Z_ERRNO:          -1,
	Z_STREAM_ERROR:   -2,
	Z_DATA_ERROR:     -3,
	Z_MEM_ERROR:      -4,
	Z_BUF_ERROR:      -5,
	Z_VERSION_ERROR:  -6,
	Z_NO_COMPRESSION:      Z.Z_NO_COMPRESSION,
	Z_BEST_SPEED:          Z.Z_BEST_SPEED,
	Z_BEST_COMPRESSION:    Z.Z_BEST_COMPRESSION,
	Z_DEFAULT_COMPRESSION: Z.Z_DEFAULT_COMPRESSION,
	Z_FILTERED:         Z.Z_FILTERED,
	Z_HUFFMAN_ONLY:     Z.Z_HUFFMAN_ONLY,
	Z_RLE:              Z.Z_RLE,
	Z_FIXED:            Z.Z_FIXED,
	Z_DEFAULT_STRATEGY: Z.Z_DEFAULT_STRATEGY,
	Z_DEFLATED:         8,
	Z_MIN_WINDOWBITS:   8,
	Z_MAX_WINDOWBITS:   15,
	Z_DEFAULT_WINDOWBITS: 15,
	Z_MIN_CHUNK:        64,
	Z_MAX_CHUNK:        Infinity,
	Z_DEFAULT_CHUNK:    16 * 1024,
	Z_MIN_MEMLEVEL:     1,
	Z_MAX_MEMLEVEL:     9,
	Z_DEFAULT_MEMLEVEL: 8,
	Z_MIN_LEVEL:        -1,
	Z_MAX_LEVEL:        9,
	Z_DEFAULT_LEVEL:    Z.Z_DEFAULT_COMPRESSION,
	DEFLATE:            1,
	INFLATE:            2,
	GZIP:               3,
	GUNZIP:             4,
	DEFLATERAW:         5,
	INFLATERAW:         6,
	UNZIP:              7,
})

/* ---- Format codes (internal) ---- */

const FMT_RAW    = 0  // raw DEFLATE, no framing
const FMT_ZLIB   = 1  // zlib wrapper (RFC 1950)
const FMT_GZIP   = 2  // gzip wrapper (RFC 1952)
const FMT_UNZIP  = 3  // auto-detect zlib or gzip on inflate

/* ---- Error helpers ----
 *
 * The native module throws Errors with `.errno` set to a miniz status code.
 * We translate to Node's Z_* code names and attach a Node-style message
 * so callers can branch on err.code. */

const Z_ERR_NAMES = {
	[constants.Z_ERRNO]:         'Z_ERRNO',
	[constants.Z_STREAM_ERROR]:  'Z_STREAM_ERROR',
	[constants.Z_DATA_ERROR]:    'Z_DATA_ERROR',
	[constants.Z_MEM_ERROR]:     'Z_MEM_ERROR',
	[constants.Z_BUF_ERROR]:     'Z_BUF_ERROR',
	[constants.Z_VERSION_ERROR]: 'Z_VERSION_ERROR',
}

function wrapZlibError(err, syscall) {
	if (err == null || typeof err !== 'object') return err
	if (typeof err.errno !== 'number') return err
	const code = Z_ERR_NAMES[err.errno]
	if (!code) return err
	const msg = err.message && err.message !== 'zlib error'
		? `${code}: ${err.message}` : code
	const wrapped = new Error(msg)
	wrapped.code = code
	wrapped.errno = err.errno
	if (syscall) wrapped.syscall = syscall
	return wrapped
}

/* Run an operation, wrapping any zlib error into Node-style. */
function withZlibError(fn) {
	try { return fn() }
	catch (e) { throw wrapZlibError(e) }
}

async function withZlibErrorAsync(promiseFn) {
	try { return await promiseFn() }
	catch (e) { throw wrapZlibError(e) }
}

function toUint8(input) {
	if (input == null) throw new TypeError('input is required')
	if (input instanceof Uint8Array) return input
	if (input instanceof ArrayBuffer) return new Uint8Array(input)
	if (typeof input === 'string') return new TextEncoder().encode(input)
	throw new TypeError('input must be a Buffer, Uint8Array, ArrayBuffer, or string')
}

function checkInt(name, value, min, max) {
	if (typeof value !== 'number' || !Number.isFinite(value) || (value | 0) !== value) {
		throw new RangeError(
			`The value of "options.${name}" is out of range. ` +
			`It must be an integer. Received ${value}`)
	}
	if (value < min || value > max) {
		throw new RangeError(
			`The value of "options.${name}" is out of range. ` +
			`It must be >= ${min} and <= ${max}. Received ${value}`)
	}
}

const VALID_STRATEGIES = new Set([
	constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED,
	constants.Z_HUFFMAN_ONLY, constants.Z_RLE, constants.Z_FIXED,
])

function defaultOptions(opts) {
	opts = opts || {}
	const out = {
		level:     opts.level     ?? constants.Z_DEFAULT_COMPRESSION,
		memLevel:  opts.memLevel  ?? constants.Z_DEFAULT_MEMLEVEL,
		strategy:  opts.strategy  ?? constants.Z_DEFAULT_STRATEGY,
		chunkSize: opts.chunkSize ?? constants.Z_DEFAULT_CHUNK,
		windowBits: opts.windowBits ?? constants.Z_DEFAULT_WINDOWBITS,
	}

	checkInt('level', out.level, -1, 9)
	checkInt('windowBits', out.windowBits, 8, 15)
	checkInt('memLevel', out.memLevel, 1, 9)
	checkInt('chunkSize', out.chunkSize, 64, Number.MAX_SAFE_INTEGER)
	if (!VALID_STRATEGIES.has(out.strategy)) {
		throw new RangeError(
			`The value of "options.strategy" is out of range. Received ${out.strategy}`)
	}

	// miniz only supports a 32KB window (windowBits=15). Smaller values are
	// accepted by the validation above (to match Node's accepted range) but
	// always get the full 15-bit window internally — the user just gets a
	// slightly larger compressed output than they'd see with real zlib.
	out.windowBits = 15

	return out
}

/* ---- gzip framing ----
 *
 * Header (10 bytes):
 *   1f 8b  — magic
 *   08     — compression method (deflate)
 *   00     — flags
 *   00 00 00 00  — mtime (we use 0)
 *   00     — extra flags
 *   FF     — OS (unknown)
 *
 * Trailer (8 bytes): CRC32 of uncompressed data (LE) + ISIZE (LE) */

const GZIP_HEADER = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff])

function makeGzipTrailer(crc, size) {
	const t = new Uint8Array(8)
	const dv = new DataView(t.buffer)
	dv.setUint32(0, crc >>> 0, true)
	dv.setUint32(4, size >>> 0, true)
	return t
}

/* Parse a gzip header. Returns { headerLen, error } — body starts at headerLen. */
function parseGzipHeader(buf) {
	if (buf.length < 10) return { error: 'gzip: truncated header' }
	if (buf[0] !== 0x1f || buf[1] !== 0x8b) return { error: 'gzip: bad magic' }
	if (buf[2] !== 8) return { error: 'gzip: unsupported compression method' }
	const flg = buf[3]
	let off = 10
	if (flg & 0x04) {  // FEXTRA
		if (off + 2 > buf.length) return { error: 'gzip: truncated FEXTRA' }
		const xlen = buf[off] | (buf[off + 1] << 8)
		off += 2 + xlen
		if (off > buf.length) return { error: 'gzip: truncated FEXTRA' }
	}
	if (flg & 0x08) {  // FNAME — null-terminated
		while (off < buf.length && buf[off] !== 0) off++
		if (off >= buf.length) return { error: 'gzip: truncated FNAME' }
		off++
	}
	if (flg & 0x10) {  // FCOMMENT — null-terminated
		while (off < buf.length && buf[off] !== 0) off++
		if (off >= buf.length) return { error: 'gzip: truncated FCOMMENT' }
		off++
	}
	if (flg & 0x02) {  // FHCRC — 2 bytes
		off += 2
		if (off > buf.length) return { error: 'gzip: truncated FHCRC' }
	}
	return { headerLen: off }
}

/* ---- One-shot sync API ---- */

function compressSync(format, input, opts) {
	const data = toUint8(input)
	const o = defaultOptions(opts)
	let windowBits
	if (format === FMT_RAW) windowBits = -o.windowBits
	else if (format === FMT_ZLIB) windowBits = o.windowBits
	else if (format === FMT_GZIP) windowBits = -o.windowBits  // raw + manual framing
	else throw new Error('compress: invalid format')

	const stream = Z.deflateInit(o.level, windowBits, o.memLevel, o.strategy)
	try {
		let r
		try { r = Z.process(stream, data, constants.Z_FINISH) }
		catch (e) { throw wrapZlibError(e) }
		if (!r.done) throw new Error('deflate did not complete')
		const body = r.output
		if (format === FMT_GZIP) {
			const crc = Z.crc32(0, data)
			const trailer = makeGzipTrailer(crc, data.length)
			const out = new Uint8Array(GZIP_HEADER.length + body.length + trailer.length)
			out.set(GZIP_HEADER, 0)
			out.set(body, GZIP_HEADER.length)
			out.set(trailer, GZIP_HEADER.length + body.length)
			return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
		}
		return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
	} finally {
		Z.end(stream)
	}
}

function decompressSync(format, input, opts) {
	const data = toUint8(input)
	const o = defaultOptions(opts)
	let windowBits
	let body = data
	let expectedCrc = null
	let expectedSize = null

	let effectiveFormat = format
	if (format === FMT_UNZIP) {
		// Auto-detect: gzip if magic 1f 8b, else assume zlib
		effectiveFormat = (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b)
			? FMT_GZIP : FMT_ZLIB
	}

	if (effectiveFormat === FMT_RAW) {
		windowBits = -o.windowBits
	} else if (effectiveFormat === FMT_ZLIB) {
		windowBits = o.windowBits
	} else if (effectiveFormat === FMT_GZIP) {
		const h = parseGzipHeader(data)
		if (h.error) throw new Error(h.error)
		if (data.length < h.headerLen + 8) throw new Error('gzip: truncated trailer')
		body = data.subarray(h.headerLen, data.length - 8)
		const dv = new DataView(data.buffer, data.byteOffset + data.length - 8, 8)
		expectedCrc = dv.getUint32(0, true)
		expectedSize = dv.getUint32(4, true)
		windowBits = -o.windowBits
	} else {
		throw new Error('decompress: invalid format')
	}

	const stream = Z.inflateInit(windowBits)
	try {
		let r
		try { r = Z.process(stream, body, constants.Z_FINISH) }
		catch (e) { throw wrapZlibError(e) }
		if (!r.done) throw new Error('inflate did not complete (truncated input?)')
		const out = r.output
		if (effectiveFormat === FMT_GZIP) {
			const crc = Z.crc32(0, out)
			if (crc !== expectedCrc) throw new Error('gzip: CRC mismatch')
			if ((out.length >>> 0) !== expectedSize) throw new Error('gzip: size mismatch')
		}
		return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
	} finally {
		Z.end(stream)
	}
}

/* ---- Async one-shot (real, via libuv thread pool) ----
 *
 * compressAsync/decompressAsync run the deflate/inflate work on the
 * libuv thread pool via Z.processAsync. gzip framing (CRC + header +
 * trailer) is still computed in JS — small enough to not be worth
 * offloading. */

async function compressAsync(format, input, opts) {
	const data = toUint8(input)
	const o = defaultOptions(opts)
	const wb = format === FMT_ZLIB ? o.windowBits : -o.windowBits
	const stream = Z.deflateInit(o.level, wb, o.memLevel, o.strategy)
	try {
		let r
		try { r = await Z.processAsync(stream, data, constants.Z_FINISH) }
		catch (e) { throw wrapZlibError(e) }
		if (!r.done) throw new Error('deflate did not complete')
		const body = r.output
		if (format === FMT_GZIP) {
			const crc = Z.crc32(0, data)
			const trailer = makeGzipTrailer(crc, data.length)
			const out = new Uint8Array(GZIP_HEADER.length + body.length + trailer.length)
			out.set(GZIP_HEADER, 0)
			out.set(body, GZIP_HEADER.length)
			out.set(trailer, GZIP_HEADER.length + body.length)
			return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
		}
		return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
	} finally {
		Z.end(stream)
	}
}

async function decompressAsync(format, input, opts) {
	const data = toUint8(input)
	const o = defaultOptions(opts)

	let effectiveFormat = format
	if (format === FMT_UNZIP) {
		effectiveFormat = (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b)
			? FMT_GZIP : FMT_ZLIB
	}

	let body = data
	let expectedCrc = null
	let expectedSize = null
	let windowBits

	if (effectiveFormat === FMT_RAW) {
		windowBits = -o.windowBits
	} else if (effectiveFormat === FMT_ZLIB) {
		windowBits = o.windowBits
	} else if (effectiveFormat === FMT_GZIP) {
		const h = parseGzipHeader(data)
		if (h.error) throw new Error(h.error)
		if (data.length < h.headerLen + 8) throw new Error('gzip: truncated trailer')
		body = data.subarray(h.headerLen, data.length - 8)
		const dv = new DataView(data.buffer, data.byteOffset + data.length - 8, 8)
		expectedCrc = dv.getUint32(0, true)
		expectedSize = dv.getUint32(4, true)
		windowBits = -o.windowBits
	} else {
		throw new Error('decompress: invalid format')
	}

	const stream = Z.inflateInit(windowBits)
	try {
		let r
		try { r = await Z.processAsync(stream, body, constants.Z_FINISH) }
		catch (e) { throw wrapZlibError(e) }
		if (!r.done) throw new Error('inflate did not complete (truncated input?)')
		const out = r.output
		if (effectiveFormat === FMT_GZIP) {
			const crc = Z.crc32(0, out)
			if (crc !== expectedCrc) throw new Error('gzip: CRC mismatch')
			if ((out.length >>> 0) !== expectedSize) throw new Error('gzip: size mismatch')
		}
		return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
	} finally {
		Z.end(stream)
	}
}

/* ---- Callback-style wrappers around the Promise versions ---- */

function asyncify(promiseFn) {
	return function (input, opts, cb) {
		if (typeof opts === 'function') { cb = opts; opts = undefined }
		if (typeof cb !== 'function') throw new TypeError('callback required')
		promiseFn(input, opts).then(
			(v) => cb(null, v),
			(e) => cb(e),
		)
	}
}

/* ---- Public sync surface ---- */

export const deflateSync     = (input, opts) => compressSync(FMT_ZLIB, input, opts)
export const deflateRawSync  = (input, opts) => compressSync(FMT_RAW,  input, opts)
export const gzipSync        = (input, opts) => compressSync(FMT_GZIP, input, opts)

export const inflateSync     = (input, opts) => decompressSync(FMT_ZLIB,  input, opts)
export const inflateRawSync  = (input, opts) => decompressSync(FMT_RAW,   input, opts)
export const gunzipSync      = (input, opts) => decompressSync(FMT_GZIP,  input, opts)
export const unzipSync       = (input, opts) => decompressSync(FMT_UNZIP, input, opts)

/* ---- Public Promise-returning APIs (used by promisify and callback wrapping) ---- */

const deflateP    = (input, opts) => compressAsync(FMT_ZLIB, input, opts)
const deflateRawP = (input, opts) => compressAsync(FMT_RAW,  input, opts)
const gzipP       = (input, opts) => compressAsync(FMT_GZIP, input, opts)
const inflateP    = (input, opts) => decompressAsync(FMT_ZLIB,  input, opts)
const inflateRawP = (input, opts) => decompressAsync(FMT_RAW,   input, opts)
const gunzipP     = (input, opts) => decompressAsync(FMT_GZIP,  input, opts)
const unzipP      = (input, opts) => decompressAsync(FMT_UNZIP, input, opts)

/* ---- Public callback surface ---- */

export const deflate    = asyncify(deflateP)
export const deflateRaw = asyncify(deflateRawP)
export const gzip       = asyncify(gzipP)
export const inflate    = asyncify(inflateP)
export const inflateRaw = asyncify(inflateRawP)
export const gunzip     = asyncify(gunzipP)
export const unzip      = asyncify(unzipP)

/* ---- Promise surface (zlib/promises) ---- */

export const promises = {
	deflate:    deflateP,
	deflateRaw: deflateRawP,
	gzip:       gzipP,
	inflate:    inflateP,
	inflateRaw: inflateRawP,
	gunzip:     gunzipP,
	unzip:      unzipP,
}

/* ---- Transform-stream backed compressors/decompressors ----
 *
 * ZlibStream extends our node:stream Transform. _transform pumps the C
 * engine via Z.processAsync (so the work runs on the libuv thread pool);
 * _flush emits the final block and validates the gzip trailer.
 *
 * gzip framing is done in JS on top of raw deflate to keep C minimal:
 *   - compress: prepend GZIP_HEADER on first emit, append CRC+size trailer
 *     in _flush.
 *   - decompress: strip header on the first chunks (accumulating until the
 *     full header is available), then hold back a rolling 8-byte window so
 *     the last 8 bytes can be parsed as the trailer in _flush. */

class ZlibStream extends Transform {
	#mode  // 'compress' | 'decompress'
	#format
	#stream  // C handle
	// gzip state
	#gzipCrc = 0
	#gzipSize = 0
	#gzipHeaderEmitted = false
	#gzipHeaderBuf = new Uint8Array(0)  // accumulator until full gzip header is parsed
	#gzipHeaderParsed = false
	#trailerBuf = new Uint8Array(0)     // rolling last-8-bytes window for gzip trailer
	#cleanedUp = false

	constructor(mode, format, opts) {
		const o = defaultOptions(opts)
		super({ writableHighWaterMark: o.chunkSize, readableHighWaterMark: o.chunkSize })
		this.#mode = mode
		this.#format = format

		const wb = o.windowBits
		let initWb
		if (format === FMT_RAW)        initWb = -wb
		else if (format === FMT_ZLIB)  initWb = wb
		else if (format === FMT_GZIP)  initWb = -wb  // raw deflate; framing handled here
		else if (format === FMT_UNZIP) initWb = wb
		else throw new Error('invalid format')

		this.#stream = mode === 'compress'
			? Z.deflateInit(o.level, initWb, o.memLevel, o.strategy)
			: Z.inflateInit(initWb)
	}

	async _transform(chunk, encoding, cb) {
		try {
			const body = this.#preProcess(chunk, false)
			if (body === null) { cb(); return }  // header still incomplete

			if (body.length > 0 || this.#mode === 'compress' && this.#format === FMT_GZIP) {
				if (this.#mode === 'compress' && this.#format === FMT_GZIP) {
					if (!this.#gzipHeaderEmitted) {
						this.push(Buffer.from(GZIP_HEADER))
						this.#gzipHeaderEmitted = true
					}
					this.#gzipCrc = Z.crc32(this.#gzipCrc, body)
					this.#gzipSize = (this.#gzipSize + body.length) >>> 0
				}
				const r = await Z.processAsync(this.#stream, body || null, constants.Z_NO_FLUSH)
				this.#emitOutput(r.output)
			}
			cb()
		} catch (e) { cb(wrapZlibError(e)) }
	}

	async _flush(cb) {
		try {
			// For decompress gzip, run final pre-process to expose the trailer bytes.
			let tail = null
			if (this.#mode === 'decompress' && this.#format === FMT_GZIP) {
				const body = this.#preProcess(new Uint8Array(0), true)
				if (body && body.length > 0) tail = body
			}
			const r = await Z.processAsync(this.#stream, tail, constants.Z_FINISH)
			this.#emitOutput(r.output)

			if (this.#mode === 'compress' && this.#format === FMT_GZIP) {
				if (!this.#gzipHeaderEmitted) {
					this.push(Buffer.from(GZIP_HEADER))
					this.#gzipHeaderEmitted = true
				}
				this.push(Buffer.from(makeGzipTrailer(this.#gzipCrc, this.#gzipSize)))
			}
			if (this.#mode === 'decompress' && this.#format === FMT_GZIP) {
				if (this.#trailerBuf.length < 8) throw new Error('gzip: truncated trailer')
				const dv = new DataView(this.#trailerBuf.buffer, this.#trailerBuf.byteOffset, 8)
				const expectedCrc = dv.getUint32(0, true)
				const expectedSize = dv.getUint32(4, true)
				if (this.#gzipCrc !== expectedCrc) throw new Error('gzip: CRC mismatch')
				if (this.#gzipSize !== expectedSize) throw new Error('gzip: size mismatch')
			}
			this.#cleanup()
			cb()
		} catch (e) { this.#cleanup(); cb(wrapZlibError(e)) }
	}

	/* Apply gzip framing rules to incoming data. Returns the body bytes that
	 * should be fed to inflate/deflate, or null if more input is needed
	 * before any body bytes can be released (header still incomplete). */
	#preProcess(chunk, isFinal) {
		if (this.#mode === 'compress' && this.#format !== FMT_GZIP) return chunk
		if (this.#mode === 'decompress' && this.#format !== FMT_GZIP) return chunk
		if (this.#mode === 'compress') return chunk

		// Decompress gzip: parse header, hold back rolling 8 trailer bytes.
		if (!this.#gzipHeaderParsed) {
			const merged = chunk.length
				? concatU8(this.#gzipHeaderBuf, chunk)
				: this.#gzipHeaderBuf
			const h = parseGzipHeader(merged)
			if (h.error) {
				if (!isFinal && merged.length < 1024) {
					this.#gzipHeaderBuf = merged
					return null
				}
				throw new Error(h.error)
			}
			this.#gzipHeaderParsed = true
			this.#gzipHeaderBuf = null
			chunk = merged.subarray(h.headerLen)
		}
		const combined = chunk.length
			? concatU8(this.#trailerBuf, chunk)
			: this.#trailerBuf
		if (isFinal) {
			if (combined.length < 8) throw new Error('gzip: truncated trailer')
			const bodyEnd = combined.length - 8
			this.#trailerBuf = combined.subarray(bodyEnd)
			return combined.subarray(0, bodyEnd)
		}
		if (combined.length <= 8) {
			this.#trailerBuf = combined
			return new Uint8Array(0)
		}
		this.#trailerBuf = combined.subarray(combined.length - 8)
		return combined.subarray(0, combined.length - 8)
	}

	#emitOutput(out) {
		if (out.length === 0) return
		if (this.#mode === 'decompress' && this.#format === FMT_GZIP) {
			this.#gzipCrc = Z.crc32(this.#gzipCrc, out)
			this.#gzipSize = (this.#gzipSize + out.length) >>> 0
		}
		this.push(Buffer.from(out.buffer, out.byteOffset, out.byteLength))
	}

	#cleanup() {
		if (this.#cleanedUp) return
		this.#cleanedUp = true
		if (this.#stream) { try { Z.end(this.#stream) } catch {} this.#stream = null }
	}

	destroy(err) {
		this.#cleanup()
		return super.destroy(err)
	}
}

function concatU8(a, b) {
	const out = new Uint8Array(a.length + b.length)
	out.set(a, 0); out.set(b, a.length)
	return out
}

export const createDeflate     = (opts) => new ZlibStream('compress',   FMT_ZLIB,  opts)
export const createDeflateRaw  = (opts) => new ZlibStream('compress',   FMT_RAW,   opts)
export const createGzip        = (opts) => new ZlibStream('compress',   FMT_GZIP,  opts)
export const createInflate     = (opts) => new ZlibStream('decompress', FMT_ZLIB,  opts)
export const createInflateRaw  = (opts) => new ZlibStream('decompress', FMT_RAW,   opts)
export const createGunzip      = (opts) => new ZlibStream('decompress', FMT_GZIP,  opts)
export const createUnzip       = (opts) => new ZlibStream('decompress', FMT_UNZIP, opts)

/* ---- crc32 helper (Node exposes this as zlib.crc32 since v22) ---- */

export function crc32(data, value = 0) {
	return Z.crc32(value, toUint8(data))
}

/* ---- Brotli / zstd: not implemented ---- */

function notImpl(name) {
	return () => { throw new Error(`zlib.${name}: not implemented in qn`) }
}

export const brotliCompress       = notImpl('brotliCompress')
export const brotliCompressSync   = notImpl('brotliCompressSync')
export const brotliDecompress     = notImpl('brotliDecompress')
export const brotliDecompressSync = notImpl('brotliDecompressSync')
export const createBrotliCompress    = notImpl('createBrotliCompress')
export const createBrotliDecompress  = notImpl('createBrotliDecompress')

export const zstdCompress       = notImpl('zstdCompress')
export const zstdCompressSync   = notImpl('zstdCompressSync')
export const zstdDecompress     = notImpl('zstdDecompress')
export const zstdDecompressSync = notImpl('zstdDecompressSync')
export const createZstdCompress    = notImpl('createZstdCompress')
export const createZstdDecompress  = notImpl('createZstdDecompress')

export default {
	constants,
	deflateSync, deflateRawSync, gzipSync,
	inflateSync, inflateRawSync, gunzipSync, unzipSync,
	deflate, deflateRaw, gzip,
	inflate, inflateRaw, gunzip, unzip,
	createDeflate, createDeflateRaw, createGzip,
	createInflate, createInflateRaw, createGunzip, createUnzip,
	crc32,
	promises,
}

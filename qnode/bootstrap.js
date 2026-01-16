#!/usr/bin/env qnode
/**
 * QJSX-Node Bootstrap
 *
 * This is a minimal bootstrap file that acts as an interpreter for user scripts.
 * When compiled with qjsxc using the -D flag for all node modules, it creates
 * a standalone executable that can run any JavaScript file with embedded Node.js
 * compatibility modules.
 *
 * All node modules are embedded at compile time using qjsxc's -D flag, so they
 * are available to dynamically loaded scripts without needing external files.
 */

import * as std from "std"
import * as os from "os"

// Node.js compatibility error for unsupported features
class NodeCompatibilityError extends Error {
	constructor(message) {
		super(message)
		this.name = 'NodeCompatibilityError'
	}
}

// Timer globals
globalThis.setTimeout = (fn, delay, ...args) => {
	if (args.length > 0) {
		throw new NodeCompatibilityError('setTimeout does not support passing arguments to callback. Use an arrow function instead.')
	}
	return os.setTimeout(fn, delay)
}

globalThis.clearTimeout = os.clearTimeout

globalThis.setInterval = () => {
	throw new NodeCompatibilityError('setInterval is not supported')
}

globalThis.clearInterval = () => {
	throw new NodeCompatibilityError('clearInterval is not supported')
}

// Performance API
globalThis.performance = {
	now: os.now
}

// Base64 encoding/decoding
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = new Uint8Array(128)
for (let i = 0; i < BASE64_CHARS.length; i++) {
	BASE64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i
}

globalThis.btoa = (str) => {
	let result = ''
	for (let i = 0; i < str.length; i += 3) {
		const b1 = str.charCodeAt(i), b2 = str.charCodeAt(i + 1) || 0, b3 = str.charCodeAt(i + 2) || 0
		result += BASE64_CHARS[b1 >> 2]
		result += BASE64_CHARS[((b1 & 3) << 4) | (b2 >> 4)]
		result += i + 1 < str.length ? BASE64_CHARS[((b2 & 15) << 2) | (b3 >> 6)] : '='
		result += i + 2 < str.length ? BASE64_CHARS[b3 & 63] : '='
	}
	return result
}

globalThis.atob = (str) => {
	let end = str.length
	while (end > 0 && str[end - 1] === '=') end--
	let result = ''
	for (let i = 0; i < end; i += 4) {
		const b1 = BASE64_LOOKUP[str.charCodeAt(i)]
		const b2 = BASE64_LOOKUP[str.charCodeAt(i + 1)]
		const b3 = BASE64_LOOKUP[str.charCodeAt(i + 2)]
		const b4 = BASE64_LOOKUP[str.charCodeAt(i + 3)]
		result += String.fromCharCode((b1 << 2) | (b2 >> 4))
		if (i + 2 < end) result += String.fromCharCode(((b2 & 15) << 4) | (b3 >> 2))
		if (i + 3 < end) result += String.fromCharCode(((b3 & 3) << 6) | b4)
	}
	return result
}

// TextEncoder/TextDecoder (Web standard, also in Node.js)
globalThis.TextEncoder = class TextEncoder {
	encoding = 'utf-8'

	encode(string) {
		if (typeof string !== 'string') {
			string = String(string)
		}
		return new Uint8Array(std._encodeUtf8(string))
	}

	encodeInto(string, uint8Array) {
		if (typeof string !== 'string') {
			string = String(string)
		}
		const encoded = new Uint8Array(std._encodeUtf8(string))
		const len = Math.min(encoded.length, uint8Array.length)
		uint8Array.set(encoded.subarray(0, len))
		return {
			read: string.length,
			written: len
		}
	}
}

globalThis.TextDecoder = class TextDecoder {
	constructor(encoding = 'utf-8', options = {}) {
		const normalizedEncoding = encoding.toLowerCase().replace('-', '')
		if (normalizedEncoding !== 'utf8') {
			throw new TypeError(`TextDecoder: '${encoding}' encoding not supported. Only UTF-8 is supported.`)
		}
		if (options.fatal) {
			throw new NodeCompatibilityError('TextDecoder: fatal option is not supported')
		}
		this.encoding = 'utf-8'
		this.fatal = false
		this.ignoreBOM = !!options.ignoreBOM
	}

	decode(input, options = {}) {
		if (options.stream) {
			throw new NodeCompatibilityError('TextDecoder: stream option is not supported')
		}
		if (input === undefined) {
			return ''
		}
		let buffer
		if (input instanceof ArrayBuffer) {
			buffer = input
		} else if (ArrayBuffer.isView(input)) {
			buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
		} else {
			throw new TypeError('TextDecoder.decode: input must be ArrayBuffer or ArrayBufferView')
		}
		let result = std._decodeUtf8(buffer)
		// Strip BOM if present (default behavior per WHATWG spec)
		if (!this.ignoreBOM && result.length > 0 && result.charCodeAt(0) === 0xFEFF) {
			result = result.slice(1)
		}
		return result
	}
}

// Add missing console methods for Node.js compatibility
console.error = (...args) => { std.err.puts(args.join(' ') + '\n'); std.err.flush() }
console.warn = console.error
console.info = console.log
console.debug = console.log

// If no script provided, start the REPL
if (scriptArgs.length < 2) {
	await import("repl")
} else {
	const scriptPath = scriptArgs[1]

	// Keep scriptArgs as-is to match Node.js argv behavior:
	// argv[0] = interpreter, argv[1] = script, argv[2+] = args

	// Load and execute the user's script
	try {
		await import(scriptPath)
	} catch (e) {
		std.err.puts("Error loading script: " + e.message + "\n")
		if (e.stack) {
			std.err.puts(e.stack + "\n")
		}
		std.exit(1)
	}
}

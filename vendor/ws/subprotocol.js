// prettier-ignore
const tokenChars = [
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0 - 15
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
	0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, // 32 - 47
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48 - 63
	0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 64 - 79
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, // 80 - 95
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 96 - 111
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0  // 112 - 127
]

/**
 * Parses the `Sec-WebSocket-Protocol` header into a set of subprotocol names.
 *
 * @param {String} header The field value of the header
 * @return {Set} The subprotocol names
 * @public
 */
function parse(header) {
	const protocols = new Set()
	let start = -1
	let end = -1
	let i = 0

	for (i; i < header.length; i++) {
		const code = header.charCodeAt(i)

		if (end === -1 && tokenChars[code] === 1) {
			if (start === -1) start = i
		} else if (
			i !== 0 &&
			(code === 0x20 /* ' ' */ || code === 0x09) /* '\t' */
		) {
			if (end === -1 && start !== -1) end = i
		} else if (code === 0x2c /* ',' */) {
			if (start === -1) {
				throw new SyntaxError(`Unexpected character at index ${i}`)
			}

			if (end === -1) end = i

			const protocol = header.slice(start, end)

			if (protocols.has(protocol)) {
				throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`)
			}

			protocols.add(protocol)
			start = end = -1
		} else {
			throw new SyntaxError(`Unexpected character at index ${i}`)
		}
	}

	if (start === -1 || end !== -1) {
		throw new SyntaxError('Unexpected end of input')
	}

	const protocol = header.slice(start, i)

	if (protocols.has(protocol)) {
		throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`)
	}

	protocols.add(protocol)
	return protocols
}

export { parse }

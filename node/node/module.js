/**
 * Node.js module compatibility for Qn.
 * Implements the subset used by qn.
 * @see https://nodejs.org/api/module.html
 */

import { transform, parse } from "qn:sucrase"

// Token type and contextual keyword constants from Sucrase's parser
const TT_IMPORT = 90640
const TT_EXPORT = 89104
const TT_STRING = 4608
const TT_ENUM = 113168
const CK_TYPE = 38
const CK_NAMESPACE = 23

/**
 * Strips TypeScript type annotations from source code, returning plain JavaScript.
 *
 * In 'strip' mode (default), type-only syntax is replaced with whitespace to preserve
 * source positions (inspired by ts-blank-space). Throws on constructs that require
 * runtime code generation (enums, namespaces with values).
 *
 * In 'transform' mode, Sucrase's full transform is used. Handles all TypeScript
 * constructs including enums, but does not preserve source positions.
 *
 * @param {string} code - TypeScript source code
 * @param {object} [options] - Options
 * @param {string} [options.mode] - 'strip' (default) or 'transform'
 * @returns {string} JavaScript source code
 */
export function stripTypeScriptTypes(code, options) {
	const mode = options?.mode ?? "strip"
	if (mode === "transform") {
		return transform(code, { transforms: ["typescript"], disableESTransforms: true }).code
	}
	return blankTypeScriptTypes(code)
}

/**
 * Replace TypeScript type-only syntax with whitespace, preserving source positions.
 * Uses Sucrase's parser to identify type regions via the isType token flag, then blanks
 * them in the original source (similar to Bloomberg's ts-blank-space approach).
 */
function blankTypeScriptTypes(code) {
	const file = parse(code, false, true, false)
	const tokens = file.tokens

	// Collect ranges to blank: [start, end, start, end, ...]
	const ranges = []

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]
		if (t.start === t.end) continue

		// Reject constructs that require runtime code generation
		if (t.type === TT_ENUM) {
			throw new SyntaxError("TypeScript enum is not supported in strip-only mode")
		}
		if (t.contextualKeyword === CK_NAMESPACE && !t.isType) {
			throw new SyntaxError("TypeScript namespace is not supported in strip-only mode")
		}

		// Handle `import type ...` and `export type ...` statements.
		// These have isType=false on all tokens, but the `type` keyword after
		// import/export has contextualKeyword === CK_TYPE.
		// Mirrors ts-blank-space: blank the entire statement.
		if ((t.type === TT_IMPORT || t.type === TT_EXPORT) && i + 1 < tokens.length) {
			const next = tokens[i + 1]
			if (next.contextualKeyword === CK_TYPE && !next.isType) {
				// Scan to the last token of this statement (before next import/export/eof)
				let lastIdx = i + 1
				for (let j = i + 2; j < tokens.length; j++) {
					if (tokens[j].start === tokens[j].end) continue
					if (tokens[j].type === TT_IMPORT || tokens[j].type === TT_EXPORT) break
					lastIdx = j
				}
				const end = tokens[lastIdx].end
				ranges.push(t.start, end)
				i = lastIdx
				continue
			}
		}

		if (t.isType) {
			// Extend back to cover whitespace between previous non-type token and this one
			let regionStart = t.start
			if (i > 0) {
				const prev = tokens[i - 1]
				if (!prev.isType) {
					regionStart = prev.end
				}
			}

			// Extend forward through consecutive isType tokens
			let regionEnd = t.end
			while (i + 1 < tokens.length && tokens[i + 1].isType) {
				i++
				regionEnd = tokens[i].end
			}

			ranges.push(regionStart, regionEnd)
		}
	}

	if (ranges.length === 0) return code

	// Build output: copy non-blanked regions verbatim, blank regions become whitespace
	let out = ""
	let pos = 0
	for (let i = 0; i < ranges.length; i += 2) {
		const start = ranges[i]
		const end = ranges[i + 1]
		out += code.slice(pos, start)
		// Replace with spaces, preserving newlines
		for (let j = start; j < end; j++) {
			const ch = code.charCodeAt(j)
			out += (ch === 10 || ch === 13) ? code[j] : " "
		}
		pos = end
	}
	out += code.slice(pos)
	return out
}

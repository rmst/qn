/**
 * Node.js module compatibility for Qn.
 * Implements the subset used by qn.
 * @see https://nodejs.org/api/module.html
 */

import { transform, parse } from "qn:sucrase"

/**
 * createRequire — delegates to qn:cjs which registers itself via a global.
 * This avoids eagerly importing qn:cjs (which depends on node:path) when
 * node:module is loaded.  qnc's lightweight TS context imports node:module
 * only for stripTypeScriptTypes and must not pull in the full CJS runtime.
 */
export function createRequire(filenameOrUrl) {
	const impl = globalThis.__qn_createRequire
	if (!impl) {
		throw new Error("createRequire is not available — qn:cjs was not loaded")
	}
	return impl(filenameOrUrl)
}

// Token type and contextual keyword constants from Sucrase's parser
const TT_IMPORT = 90640
const TT_EXPORT = 89104
const TT_STRING = 4608
const TT_ENUM = 113168
const TT_BRACE_R = 11264
const TT_PAREN_L = 13824
const TT_COMMA = 15360
const TT_NON_NULL_ASSERTION = 61440
const TT_DECLARE = 103952
const TT_READONLY = 104976
const TT_ABSTRACT = 106000
const TT_PUBLIC = 107536
const TT_PRIVATE = 108560
const TT_PROTECTED = 109584
const TT_OVERRIDE = 110608
const CK_TYPE = 38
const CK_NAMESPACE = 23
const CK_FROM = 13

function isClassModifierType(type) {
	return type === TT_PUBLIC || type === TT_PRIVATE || type === TT_PROTECTED
		|| type === TT_READONLY || type === TT_ABSTRACT || type === TT_OVERRIDE
		|| type === TT_DECLARE
}

/**
 * Strips TypeScript type annotations from source code, returning plain JavaScript.
 *
 * In 'strip' mode (default), type-only syntax is replaced with whitespace to preserve
 * source positions (inspired by ts-blank-space). Throws on constructs that require
 * runtime code generation that strip can't handle (enums, constructor parameter
 * properties).
 *
 * Value namespaces are rewritten to the canonical `var N;(function(N){...})(N||(N={}))`
 * IIFE form via a text-level pre-pass that runs before either mode, so both modes
 * handle them.
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
	// Sucrase has no namespace support: strip blanks the whole body (all tokens
	// get isType=true via pushTypeContext) and transform drops it wholesale.
	// Worse, `pushTypeContext` changes tokenization of `<<`/`>>`/`>=` inside
	// the body (they split into single `<`/`>` tokens for generic nesting),
	// which breaks the initial parse on any namespace body that uses bitshift
	// or comparison operators.  So: do a text-level desugar BEFORE handing the
	// source to Sucrase, rewriting top-level value namespaces to the canonical
	// `var N;(function(N){...})(N||(N={}))` form that tsc itself emits.
	code = desugarTypeScriptNamespaces(code)
	const { tokens } = parse(code, false, true, false)
	if (mode === "transform") {
		return transform(code, { transforms: ["typescript"], disableESTransforms: true }).code
	}
	const blanked = blankTypeScriptTypes(code, tokens)
	// Blanking can silently produce invalid JS when newlines inside a type region
	// violate a no-LineTerminator restriction in the surrounding JS — most notably
	// a multi-line return type on an arrow function, where the LineTerminator
	// between `)` and `=>` is a parse error. Re-parse the blanked output to catch
	// this and throw so callers can fall back to transform mode.
	try {
		parse(blanked, false, false, false)
	} catch {
		throw new SyntaxError(
			"TypeScript type spans lines in a position where the surrounding JavaScript " +
			"forbids line terminators (e.g. multi-line arrow return type). " +
			"Use { mode: 'transform' } instead.",
		)
	}
	return blanked
}

/**
 * Rewrite top-level TypeScript value namespaces to the IIFE form emitted by
 * tsc:
 *
 *     [export] namespace X { body }
 *   →
 *     var X;(function(X){ body' })(X||(X={}));[export { X };]
 *
 * Where body' has every top-level `export` keyword blanked, and a tail of
 * `X.name=name;` assignments appended before the IIFE's closing brace for
 * each exported binding (functions/classes/consts/lets/vars).  Function and
 * class decls are hoisted; const/let bindings are in scope at the IIFE tail;
 * so emitting all assignments at the end sidesteps having to find the end of
 * each individual declaration.
 *
 * Runs as a pure text transformation before Sucrase sees the source — Sucrase
 * wraps namespace bodies in pushTypeContext(), which (among other things)
 * mistokenizes `<<` / `>>` / `>=` inside the body, breaking any parse whose
 * body uses bitshift or comparison operators.  Going text-level sidesteps
 * this entirely.
 *
 * Only the shapes present in the wild (xterm.js / VS Code vendored) are
 * accepted: top-level, non-nested, no qualified names, no `export default`,
 * no `export { ... }`, no `export =`, no destructured bindings, no enums.
 * Any other form throws with a specific message.
 */
function desugarTypeScriptNamespaces(code) {
	// Fast path: if the word `namespace` doesn't appear anywhere in the
	// source we can skip the tokenizer entirely.  `module` is also a
	// namespace keyword but only in specific contexts, so pay for the full
	// scan only when `namespace` is present.
	if (code.indexOf("namespace") < 0) return code
	const namespaces = scanTopLevelValueNamespaces(code)
	if (namespaces.length === 0) return code
	const splices = []
	for (const ns of namespaces) emitNamespaceSplices(code, ns, splices)
	splices.sort((a, b) => b.start - a.start)
	let out = code
	for (const s of splices) out = out.slice(0, s.start) + s.replacement + out.slice(s.end)
	return out
}

/**
 * Advance past one "skippable" at position i — whitespace, line comment, block
 * comment, string literal, template literal (including nested `${...}`), or
 * regex literal.  Returns i unchanged if `code[i]` doesn't start a skippable.
 *
 * Regex detection uses a "preceding significant char" heuristic: `/` is a
 * regex if prev is empty/punct/operator/keyword-starter, else division.  Pass
 * `prevKind` as 'value' (identifier/number/close-bracket) or 'other'.
 */
function skipOne(code, i, prevKind) {
	const n = code.length
	const c = code.charCodeAt(i)
	// whitespace
	if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11) return i + 1
	// line comment
	if (c === 47 /* / */ && code.charCodeAt(i + 1) === 47) {
		const nl = code.indexOf("\n", i + 2)
		return nl < 0 ? n : nl + 1
	}
	// block comment
	if (c === 47 && code.charCodeAt(i + 1) === 42 /* * */) {
		const end = code.indexOf("*/", i + 2)
		return end < 0 ? n : end + 2
	}
	// string literal
	if (c === 34 /* " */ || c === 39 /* ' */) {
		let j = i + 1
		while (j < n) {
			const ch = code.charCodeAt(j)
			if (ch === 92 /* \ */) { j += 2; continue }
			if (ch === c) return j + 1
			if (ch === 10 && c !== 96) return j + 1 // unterminated — bail
			j++
		}
		return n
	}
	// template literal (handle ${...} recursion)
	if (c === 96 /* ` */) return skipTemplate(code, i + 1)
	// regex literal (heuristic)
	if (c === 47 && prevKind !== "value") {
		let j = i + 1
		let inClass = false
		while (j < n) {
			const ch = code.charCodeAt(j)
			if (ch === 92) { j += 2; continue }
			if (ch === 91 /* [ */) inClass = true
			else if (ch === 93 /* ] */) inClass = false
			else if (ch === 47 && !inClass) {
				j++
				// flags
				while (j < n) {
					const f = code.charCodeAt(j)
					if ((f >= 97 && f <= 122) || (f >= 65 && f <= 90)) j++
					else break
				}
				return j
			}
			else if (ch === 10) return j + 1 // unterminated
			j++
		}
		return n
	}
	return i
}

function skipTemplate(code, start) {
	const n = code.length
	let j = start
	while (j < n) {
		const ch = code.charCodeAt(j)
		if (ch === 92) { j += 2; continue }
		if (ch === 96 /* ` */) return j + 1
		if (ch === 36 /* $ */ && code.charCodeAt(j + 1) === 123 /* { */) {
			j = skipExprInTemplate(code, j + 2)
			continue
		}
		j++
	}
	return n
}

// Skip an expression inside `${...}`, respecting nested braces and further
// skippables.  Returns position after the closing `}`.
function skipExprInTemplate(code, start) {
	const n = code.length
	let j = start
	let depth = 1
	let prevKind = "other"
	while (j < n && depth > 0) {
		const next = skipOne(code, j, prevKind)
		if (next !== j) { j = next; prevKind = "other"; continue }
		const c = code.charCodeAt(j)
		if (c === 123 /* { */) { depth++; j++; prevKind = "other"; continue }
		if (c === 125 /* } */) { depth--; j++; if (depth === 0) return j; prevKind = "other"; continue }
		// identifier or number
		if (isIdStart(c)) {
			const end = readIdent(code, j)
			j = end
			prevKind = "value"
			continue
		}
		if (c >= 48 && c <= 57) { // digit
			while (j < n && /[0-9a-fA-FxXbBoOnN_.eE+-]/.test(code[j])) j++
			prevKind = "value"
			continue
		}
		// punctuation: treat closing brackets as value context for regex
		if (c === 41 /* ) */ || c === 93 /* ] */) { prevKind = "value"; j++; continue }
		prevKind = "other"
		j++
	}
	return j
}

function isIdStart(c) {
	return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36
}
function isIdCont(c) {
	return isIdStart(c) || (c >= 48 && c <= 57)
}
function readIdent(code, i) {
	let j = i
	const n = code.length
	while (j < n && isIdCont(code.charCodeAt(j))) j++
	return j
}

/**
 * Walk `code` from `start` (default 0) up to `end` (default length).  Yields
 * objects describing the structural shape of the code: identifiers (kw or
 * name), braces, parens, brackets, commas, semis, equals, star, and bumps
 * brace-depth for `${`.  Non-code (strings / comments / templates / regex) is
 * skipped entirely.  Other punctuation collapses to `{kind: 'punct'}` so the
 * caller can treat arithmetic/operator runs as opaque.
 */
function *scan(code, start, end) {
	const n = end
	let i = start
	let prevKind = "other"
	while (i < n) {
		const next = skipOne(code, i, prevKind)
		if (next !== i) { i = next; prevKind = "other"; continue }
		const c = code.charCodeAt(i)
		if (c === 123) { yield { kind: "{", pos: i, end: i + 1 }; i++; prevKind = "other"; continue }
		if (c === 125) { yield { kind: "}", pos: i, end: i + 1 }; i++; prevKind = "other"; continue }
		if (c === 40) { yield { kind: "(", pos: i, end: i + 1 }; i++; prevKind = "other"; continue }
		if (c === 41) { yield { kind: ")", pos: i, end: i + 1 }; i++; prevKind = "value"; continue }
		if (c === 91) { yield { kind: "[", pos: i, end: i + 1 }; i++; prevKind = "other"; continue }
		if (c === 93) { yield { kind: "]", pos: i, end: i + 1 }; i++; prevKind = "value"; continue }
		if (c === 44) { yield { kind: ",", pos: i, end: i + 1 }; i++; prevKind = "other"; continue }
		if (c === 59) { yield { kind: ";", pos: i, end: i + 1 }; i++; prevKind = "other"; continue }
		if (c === 61 && code.charCodeAt(i + 1) !== 61 && code.charCodeAt(i + 1) !== 62) {
			// `=` but not `==`/`=>`
			yield { kind: "=", pos: i, end: i + 1 }
			i++
			prevKind = "other"
			continue
		}
		if (c === 42 && code.charCodeAt(i + 1) !== 42 && code.charCodeAt(i + 1) !== 61) {
			// `*` but not `**`/`*=`
			yield { kind: "*", pos: i, end: i + 1 }
			i++
			prevKind = "other"
			continue
		}
		if (isIdStart(c)) {
			const e = readIdent(code, i)
			yield { kind: "ident", pos: i, end: e, text: code.slice(i, e) }
			i = e
			prevKind = "value"
			continue
		}
		if (c >= 48 && c <= 57) {
			let j = i + 1
			while (j < n && /[0-9a-fA-FxXbBoOnN_.eE+-]/.test(code[j])) j++
			i = j
			prevKind = "value"
			continue
		}
		// other punctuation
		i++
		prevKind = "other"
	}
}

/**
 * Scan `code` for top-level value namespace declarations.  Returns an array of
 * {exportStart, nsStart, nameStart, nameEnd, name, openBrace, closeBrace}.
 * `declare namespace` is skipped; Sucrase's isType blanking handles it later.
 */
function scanTopLevelValueNamespaces(code) {
	const results = []
	let braceDepth = 0
	let pending = null // {exportStart | -1, declareSeen}
	for (const tok of scan(code, 0, code.length)) {
		if (tok.kind === "{") { braceDepth++; pending = null; continue }
		if (tok.kind === "}") { braceDepth--; pending = null; continue }
		if (braceDepth !== 0) { pending = null; continue }
		if (tok.kind !== "ident") { pending = null; continue }
		if (tok.text === "export" && !pending) { pending = { exportStart: tok.pos, declareSeen: false }; continue }
		if (tok.text === "declare") { pending = { exportStart: pending ? pending.exportStart : -1, declareSeen: true }; continue }
		if (tok.text === "namespace" || tok.text === "module") {
			// Only accept actual namespaces (the word `module` here mirrors
			// TS's legacy alias, but `declare module "foo" { ... }` with a
			// string name is handled the same way — isType-erasable either
			// way if declare precedes it).
			const declareSeen = pending && pending.declareSeen
			const exportStart = pending ? pending.exportStart : -1
			pending = null
			if (declareSeen) continue // type-only; leave for strip
			const nsStart = tok.pos
			// Expect identifier, then `{`.
			const nameInfo = readNextIdent(code, tok.end)
			if (!nameInfo) continue // not a namespace decl (e.g. `const namespace = ...`)
			// After the identifier, skip to `{`.  Reject qualified names /
			// non-block forms.
			const afterName = skipTriviaAndSkippables(code, nameInfo.end)
			if (code.charCodeAt(afterName) !== 123 /* { */) {
				if (code.charCodeAt(afterName) === 46 /* . */) {
					throw new SyntaxError(
						"TypeScript namespace: qualified names (`namespace X.Y`) are not supported",
					)
				}
				// Not a block-form namespace — could be a string-named module.
				// Bail out leaving it to Sucrase (which will error out with a
				// more specific message).
				continue
			}
			const openBrace = afterName
			const closeBrace = findMatchingBrace(code, openBrace)
			if (closeBrace < 0) {
				throw new SyntaxError("TypeScript namespace: unbalanced braces")
			}
			results.push({
				exportStart,
				nsStart,
				nameStart: nameInfo.start,
				nameEnd: nameInfo.end,
				name: code.slice(nameInfo.start, nameInfo.end),
				openBrace,
				closeBrace,
			})
			continue
		}
		// any other ident at top level clears pending
		pending = null
	}
	return results
}

function skipTriviaAndSkippables(code, from) {
	let i = from
	while (i < code.length) {
		const next = skipOne(code, i, "other")
		if (next === i) return i
		i = next
	}
	return i
}

function readNextIdent(code, from) {
	const i = skipTriviaAndSkippables(code, from)
	if (i >= code.length) return null
	if (!isIdStart(code.charCodeAt(i))) return null
	const end = readIdent(code, i)
	return { start: i, end }
}

function findMatchingBrace(code, openPos) {
	let depth = 1
	for (const tok of scan(code, openPos + 1, code.length)) {
		if (tok.kind === "{") depth++
		else if (tok.kind === "}") { depth--; if (depth === 0) return tok.pos }
	}
	return -1
}

function emitNamespaceSplices(code, ns, splices) {
	const bindings = []
	let depth = 0
	let pending = null // 'export' seen at body depth 0 — awaiting next token
	for (const tok of scan(code, ns.openBrace + 1, ns.closeBrace)) {
		if (pending && depth === 0) {
			// The token after `export`.  For `export {`, `export *`, `export =`
			// we still need classifyBodyExportText to throw the specific error.
			const headText = tok.kind === "ident" ? tok.text : tok.kind
			const head = { text: headText, pos: tok.pos, end: tok.end }
			const binding = classifyBodyExportText(code, pending, head, ns.closeBrace)
			splices.push({
				start: pending.pos,
				end: pending.end,
				replacement: " ".repeat(pending.end - pending.pos),
			})
			if (binding) bindings.push(binding)
			pending = null
			// Fall through so depth tracking still applies to this tok.
		}
		if (tok.kind === "{") { depth++; continue }
		if (tok.kind === "}") { depth--; continue }
		if (depth !== 0) continue
		if (tok.kind === "ident") {
			if (tok.text === "namespace" || tok.text === "module") {
				// bare nested namespace (no `export` prefix)
				throw new SyntaxError("TypeScript nested namespaces are not supported")
			}
			if (tok.text === "export") pending = { pos: tok.pos, end: tok.end }
		}
	}

	// Head: replace `[export] namespace Name {` → `var Name;(function(Name){`
	const headStart = ns.exportStart >= 0 ? ns.exportStart : ns.nsStart
	splices.push({
		start: headStart,
		end: ns.openBrace + 1,
		replacement: `var ${ns.name};(function(${ns.name}){`,
	})

	// Tail: insert `Ns.x=x;` assignments right before the closing brace and
	// replace the brace with the IIFE call (and re-export if the namespace was
	// exported).  Leading `;` guards against ASI failures when the last body
	// statement omits its terminator (e.g. `export const x = 42` followed by
	// `}`, where our appended `Ns.x=x;` would otherwise glom onto the RHS).
	let tail = ";"
	for (const b of bindings) tail += `${ns.name}.${b}=${b};`
	tail += `})(${ns.name}||(${ns.name}={}));`
	if (ns.exportStart >= 0) tail += `export{${ns.name}};`
	splices.push({
		start: ns.closeBrace,
		end: ns.closeBrace + 1,
		replacement: tail,
	})
}

/**
 * Given an `export` token and the identifier that immediately follows (already
 * consumed by the caller), determine the binding name for the assignment tail.
 * Returns the binding name, or null for type-only exports.  Throws for shapes
 * we don't support.
 */
function classifyBodyExportText(code, exportTok, headTok, bodyEnd) {
	const head = headTok.text
	if (head === "interface" || head === "type") return null
	if (head === "namespace" || head === "module") {
		throw new SyntaxError("TypeScript nested namespaces are not supported")
	}
	if (head === "default") {
		throw new SyntaxError("TypeScript namespace: `export default` is not supported")
	}
	if (head === "enum") {
		throw new SyntaxError("TypeScript namespace: `export enum` is not supported")
	}
	if (head === "async") {
		// `async function NAME`
		const next = readNextIdent(code, headTok.end)
		if (!next || code.slice(next.start, next.end) !== "function") {
			throw new SyntaxError("TypeScript namespace: expected `function` after `async`")
		}
		return readBindingName(code, next.end)
	}
	if (head === "function") {
		// Allow optional `*` before the name for generators.
		let i = skipTriviaAndSkippables(code, headTok.end)
		if (code.charCodeAt(i) === 42 /* * */) i = skipTriviaAndSkippables(code, i + 1)
		return extractIdent(code, i, "function name")
	}
	if (head === "class") return readBindingName(code, headTok.end)
	if (head === "const" || head === "let" || head === "var") {
		const i = skipTriviaAndSkippables(code, headTok.end)
		const c = code.charCodeAt(i)
		if (c === 123 /* { */ || c === 91 /* [ */) {
			throw new SyntaxError(
				"TypeScript namespace: destructured bindings in `export const/let/var` are not supported",
			)
		}
		// Check for multi-binding by scanning for a comma at depth 0 before ;.
		const name = extractIdent(code, i, "binding name")
		const nameEndPos = i + name.length
		rejectMultiBinding(code, nameEndPos, bodyEnd)
		return name
	}
	if (head === "{") {
		throw new SyntaxError("TypeScript namespace: `export { ... }` is not supported")
	}
	if (head === "*") {
		throw new SyntaxError("TypeScript namespace: `export *` is not supported")
	}
	if (head === "=") {
		throw new SyntaxError("TypeScript namespace: `export =` is not supported")
	}
	throw new SyntaxError(`TypeScript namespace: unsupported \`export\` form (saw \`${head}\`)`)
}

function readBindingName(code, from) {
	const i = skipTriviaAndSkippables(code, from)
	return extractIdent(code, i, "binding name")
}

function extractIdent(code, i, what) {
	if (!isIdStart(code.charCodeAt(i))) {
		throw new SyntaxError(`TypeScript namespace: expected ${what}`)
	}
	const end = readIdent(code, i)
	return code.slice(i, end)
}

function rejectMultiBinding(code, from, bodyEnd) {
	let depth = 0
	for (const tok of scan(code, from, bodyEnd)) {
		if (tok.kind === "{" || tok.kind === "(" || tok.kind === "[") depth++
		else if (tok.kind === "}" || tok.kind === ")" || tok.kind === "]") {
			if (depth === 0) return
			depth--
		}
		else if (depth === 0 && tok.kind === ";") return
		else if (depth === 0 && tok.kind === ",") {
			throw new SyntaxError(
				"TypeScript namespace: multi-binding `export const a = 1, b = 2` is not supported",
			)
		}
	}
}

/**
 * Replace TypeScript type-only syntax with whitespace, preserving source positions.
 * Uses Sucrase's parser to identify type regions via the isType token flag, then blanks
 * them in the original source (similar to Bloomberg's ts-blank-space approach).
 */
function blankTypeScriptTypes(code, tokens) {
	// Collect ranges to blank: [start, end, start, end, ...]
	const ranges = []

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]
		if (t.start === t.end) continue

		// Reject constructs that require runtime code generation
		if (t.type === TT_ENUM) {
			throw new SyntaxError("TypeScript enum is not supported in strip-only mode")
		}

		// Non-null assertion `x!`: Sucrase retypes the `!` token to
		// nonNullAssertion but does not mark isType — blank it.
		if (t.type === TT_NON_NULL_ASSERTION) {
			ranges.push(t.start, t.end)
			continue
		}

		// TS-only class modifiers (public/private/protected/readonly/abstract/
		// override/declare) keep isType=false even though they are pure type
		// syntax on class members. Blank them so the emitted JS parses. For
		// constructor parameter properties the same keywords imply a runtime
		// assignment — detect that by looking back past preceding modifier
		// tokens for a `(` or `,` and fall back to transform mode.
		if (!t.isType && isClassModifierType(t.type)) {
			let j = i - 1
			while (j >= 0) {
				const p = tokens[j]
				if (p.start === p.end || isClassModifierType(p.type)) {
					j--
					continue
				}
				break
			}
			if (j >= 0 && (tokens[j].type === TT_PAREN_L || tokens[j].type === TT_COMMA)) {
				throw new SyntaxError("TypeScript parameter property is not supported in strip-only mode")
			}
			ranges.push(t.start, t.end)
			continue
		}

		// Handle `import type ...` and `export type ...` statements.
		// These have isType=false on all tokens, but the `type` keyword after
		// import/export has contextualKeyword === CK_TYPE.
		// Mirrors ts-blank-space: blank the entire statement.
		if ((t.type === TT_IMPORT || t.type === TT_EXPORT) && i + 1 < tokens.length) {
			const next = tokens[i + 1]
			if (next.contextualKeyword === CK_TYPE && !next.isType) {
				// Find the end of this import/export type statement.
				// Ends at the from-clause string literal (TT_STRING) if present,
				// otherwise at the closing brace (e.g. `export type { Foo }`).
				let lastIdx = i + 1
				for (let j = i + 2; j < tokens.length; j++) {
					if (tokens[j].start === tokens[j].end) continue
					lastIdx = j
					if (tokens[j].type === TT_STRING) break
					if (tokens[j].type === TT_BRACE_R) {
						// Check if next non-empty token is `from` — if so, continue
						let hasFrom = false
						for (let k = j + 1; k < tokens.length; k++) {
							if (tokens[k].start === tokens[k].end) continue
							if (tokens[k].contextualKeyword === CK_FROM) hasFrom = true
							break
						}
						if (!hasFrom) break
					}
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

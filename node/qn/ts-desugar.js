/**
 * qn:ts-desugar — text-level TypeScript value-namespace desugarer.
 *
 * Shared pre-pass used by the TS strip path (node:module), the bundler
 * (qn:bundle), and the qnc compile path.  Rewrites
 *
 *     [export] namespace X { body }
 *   →
 *     var X;(function(X){ body' })(X||(X={}));[export { X };]
 *
 * — the canonical IIFE form tsc itself emits.  Runs as a pure text
 * transformation BEFORE any call into Sucrase: Sucrase wraps namespace
 * bodies in pushTypeContext(), which both drops the body wholesale and
 * mistokenizes `<<` / `>>` / `>=` inside it (they split into single
 * `<`/`>` tokens for generic nesting), breaking any parse whose body
 * uses bitshift or comparison operators.  Going text-level sidesteps
 * the tokenizer issue entirely.
 *
 * Only the shapes present in the wild (xterm.js / VS Code vendored) are
 * accepted: top-level, non-nested, no qualified names, no `export
 * default`, no `export { ... }`, no `export =`, no destructured
 * bindings, no enums.  Any other form throws with a specific message.
 *
 * Pure function, zero deps — importable from the node runtime, the
 * bundler, and qnc's vanilla-qjs compile driver alike.
 */

export function desugarTypeScriptNamespaces(code) {
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

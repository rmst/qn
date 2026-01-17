# WHATWG URL Implementation

This is a port of the WHATWG URL Standard implementation for QuickJS-x.

## Source

This code is ported from:

- **Repository:** https://github.com/jsdom/whatwg-url
- **Commit:** `6c6fb1771f9d12d7174d586ebbfc8f2db401557a` (tag v14.0.0)
- **License:** MIT (Copyright Sebastian Mayr)

## Modifications

The following changes were made for QuickJS-x compatibility:

1. **ES Modules:** Converted from CommonJS (`require`/`module.exports`) to ES modules (`import`/`export`)
2. **No webidl2js:** Removed the webidl2js wrapper layer, implementing URL and URLSearchParams as plain classes
3. **No IDN support:** Removed the `tr46` dependency for Internationalized Domain Names (Punycode). URLs with non-ASCII hostnames will throw a `TypeError` with a helpful message suggesting the ASCII/Punycode form.

## Limitations

- **Internationalized Domain Names (IDN) are NOT supported.** URLs like `https://münchen.de/` will throw an error. Use the Punycode form instead: `https://xn--mnchen-3ya.de/`

/**
 * WHATWG URL Standard - Infrastructure utilities
 *
 * Ported from jsdom/whatwg-url (MIT License)
 * https://github.com/jsdom/whatwg-url
 * Copyright (c) Sebastian Mayr
 *
 * Converted to ES modules for QuickJS-x
 */

// Note: These functions operate on code points as JS numbers, not JS strings.

export function isASCIIDigit(c) {
  return c >= 0x30 && c <= 0x39;
}

export function isASCIIAlpha(c) {
  return (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A);
}

export function isASCIIAlphanumeric(c) {
  return isASCIIAlpha(c) || isASCIIDigit(c);
}

export function isASCIIHex(c) {
  return isASCIIDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

/**
 * WHATWG URL Standard - Encoding utilities
 *
 * Ported from jsdom/whatwg-url (MIT License)
 * https://github.com/jsdom/whatwg-url
 * Copyright (c) Sebastian Mayr
 *
 * Converted to ES modules for QuickJS-x
 * Uses native std._encodeUtf8/_decodeUtf8 directly to avoid bootstrap ordering issues
 */

import * as std from "std";

export function utf8Encode(string) {
  return new Uint8Array(std._encodeUtf8(string));
}

export function utf8DecodeWithoutBOM(bytes) {
  let buffer;
  if (bytes instanceof ArrayBuffer) {
    buffer = bytes;
  } else if (ArrayBuffer.isView(bytes)) {
    buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } else {
    buffer = bytes;
  }
  let result = std._decodeUtf8(buffer);
  // Strip BOM if present
  if (result.length > 0 && result.charCodeAt(0) === 0xFEFF) {
    result = result.slice(1);
  }
  return result;
}

/**
 * WHATWG URL Standard - URL-encoded form data parsing/serialization
 *
 * Ported from jsdom/whatwg-url (MIT License)
 * https://github.com/jsdom/whatwg-url
 * Copyright (c) Sebastian Mayr
 *
 * Converted to ES modules for QuickJS-x
 */

import { utf8Encode, utf8DecodeWithoutBOM } from "./encoding.js";
import { percentDecodeBytes, utf8PercentEncodeString, isURLEncodedPercentEncode } from "./percent-encoding.js";

function strictlySplitByteSequence(buf, cp) {
  const list = [];
  let last = 0;
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === cp) {
      list.push(buf.slice(last, i));
      last = i + 1;
    }
    ++i;
  }
  if (last <= buf.length) {
    list.push(buf.slice(last));
  }
  return list;
}

function replaceByteInByteSequence(buf, from, to) {
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === from) {
      buf[i] = to;
    }
    ++i;
  }
  return buf;
}

export function parseUrlencoded(input) {
  const sequences = strictlySplitByteSequence(input, 0x26); // &
  const output = [];
  for (const bytes of sequences) {
    if (bytes.length === 0) {
      continue;
    }
    let name;
    let value;
    const indexOfEqual = bytes.indexOf(0x3D); // =
    if (indexOfEqual >= 0) {
      name = bytes.slice(0, indexOfEqual);
      value = bytes.slice(indexOfEqual + 1);
    } else {
      name = bytes;
      value = new Uint8Array(0);
    }

    // Replace + with space (0x2B -> 0x20)
    replaceByteInByteSequence(name, 0x2B, 0x20);
    replaceByteInByteSequence(value, 0x2B, 0x20);

    const nameString = utf8DecodeWithoutBOM(percentDecodeBytes(name));
    const valueString = utf8DecodeWithoutBOM(percentDecodeBytes(value));
    output.push([nameString, valueString]);
  }
  return output;
}

export function parseUrlencodedString(input) {
  return parseUrlencoded(utf8Encode(input));
}

export function serializeUrlencoded(tuples, encodingOverride = undefined) {
  let output = "";
  for (let i = 0; i < tuples.length; i++) {
    const tuple = tuples[i];
    const name = utf8PercentEncodeString(tuple[0], isURLEncodedPercentEncode, true);
    const value = utf8PercentEncodeString(tuple[1], isURLEncodedPercentEncode, true);
    if (i > 0) {
      output += "&";
    }
    output += `${name}=${value}`;
  }
  return output;
}

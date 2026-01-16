/**
 * WHATWG URL Standard implementation for QuickJS-x
 *
 * Ported from jsdom/whatwg-url (MIT License)
 * https://github.com/jsdom/whatwg-url
 * Copyright (c) Sebastian Mayr
 *
 * This is a simplified port for QuickJS-x with the following changes:
 * - Converted from CommonJS to ES modules
 * - Removed webidl2js wrapper layer
 * - Removed tr46 dependency (IDN/Punycode not supported)
 *
 * LIMITATION: Internationalized Domain Names (IDN) are NOT supported.
 * URLs with non-ASCII hostnames (e.g., https://münchen.de/) will throw an error.
 * Use the ASCII/Punycode form instead (e.g., https://xn--mnchen-3ya.de/).
 */

export { URL } from "./URL.js";
export { URLSearchParams } from "./URLSearchParams.js";

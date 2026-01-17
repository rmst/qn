/**
 * WHATWG URL Standard - URLSearchParams class
 *
 * Ported from jsdom/whatwg-url (MIT License)
 * https://github.com/jsdom/whatwg-url
 * Copyright (c) Sebastian Mayr
 *
 * Converted to ES modules for QuickJS-x
 * Simplified to remove webidl2js wrapper layer
 */

import { parseUrlencodedString, serializeUrlencoded } from "./urlencoded.js";

export class URLSearchParams {
  constructor(init = "") {
    this._list = [];
    this._url = null;

    if (typeof init === "string") {
      if (init[0] === "?") {
        init = init.slice(1);
      }
      this._list = parseUrlencodedString(init);
    } else if (Array.isArray(init)) {
      for (const pair of init) {
        if (pair.length !== 2) {
          throw new TypeError("Each pair must have exactly two elements");
        }
        this._list.push([String(pair[0]), String(pair[1])]);
      }
    } else if (typeof init === "object" && init !== null) {
      for (const key of Object.keys(init)) {
        this._list.push([key, String(init[key])]);
      }
    }
  }

  _updateSteps() {
    if (this._url !== null) {
      let query = serializeUrlencoded(this._list);
      if (query === "") {
        query = null;
      }
      this._url._url.query = query;
    }
  }

  append(name, value) {
    this._list.push([String(name), String(value)]);
    this._updateSteps();
  }

  delete(name, value) {
    name = String(name);
    const hasValue = value !== undefined;
    if (hasValue) {
      value = String(value);
    }

    this._list = this._list.filter(pair => {
      if (pair[0] !== name) {
        return true;
      }
      if (hasValue && pair[1] !== value) {
        return true;
      }
      return false;
    });

    this._updateSteps();
  }

  get(name) {
    name = String(name);
    for (const pair of this._list) {
      if (pair[0] === name) {
        return pair[1];
      }
    }
    return null;
  }

  getAll(name) {
    name = String(name);
    const result = [];
    for (const pair of this._list) {
      if (pair[0] === name) {
        result.push(pair[1]);
      }
    }
    return result;
  }

  has(name, value) {
    name = String(name);
    const hasValue = value !== undefined;
    if (hasValue) {
      value = String(value);
    }

    for (const pair of this._list) {
      if (pair[0] === name) {
        if (!hasValue || pair[1] === value) {
          return true;
        }
      }
    }
    return false;
  }

  set(name, value) {
    name = String(name);
    value = String(value);

    let found = false;
    this._list = this._list.filter(pair => {
      if (pair[0] !== name) {
        return true;
      }
      if (!found) {
        found = true;
        pair[1] = value;
        return true;
      }
      return false;
    });

    if (!found) {
      this._list.push([name, value]);
    }

    this._updateSteps();
  }

  sort() {
    this._list.sort((a, b) => {
      if (a[0] < b[0]) return -1;
      if (a[0] > b[0]) return 1;
      return 0;
    });
    this._updateSteps();
  }

  get size() {
    return this._list.length;
  }

  toString() {
    return serializeUrlencoded(this._list);
  }

  *keys() {
    for (const pair of this._list) {
      yield pair[0];
    }
  }

  *values() {
    for (const pair of this._list) {
      yield pair[1];
    }
  }

  *entries() {
    for (const pair of this._list) {
      yield [pair[0], pair[1]];
    }
  }

  forEach(callback, thisArg) {
    for (const pair of this._list) {
      callback.call(thisArg, pair[1], pair[0], this);
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

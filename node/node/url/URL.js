/**
 * WHATWG URL Standard - URL class
 *
 * Ported from jsdom/whatwg-url (MIT License)
 * https://github.com/jsdom/whatwg-url
 * Copyright (c) Sebastian Mayr
 *
 * Converted to ES modules for QuickJS-x
 * Simplified to remove webidl2js wrapper layer
 */

import {
  basicURLParse,
  serializeURL,
  serializePath,
  serializeURLOrigin,
  serializeHost,
  serializeInteger,
  setTheUsername,
  setThePassword,
  cannotHaveAUsernamePasswordPort,
  hasAnOpaquePath
} from "./url-state-machine.js";
import { URLSearchParams } from "./URLSearchParams.js";
import { parseUrlencodedString } from "./urlencoded.js";

export class URL {
  constructor(url, base) {
    url = String(url);

    let parsedBase = null;
    if (base !== undefined) {
      parsedBase = basicURLParse(String(base));
      if (parsedBase === null) {
        throw new TypeError(`Invalid base URL: ${base}`);
      }
    }

    const parsedURL = basicURLParse(url, { baseURL: parsedBase });
    if (parsedURL === null) {
      throw new TypeError(`Invalid URL: ${url}`);
    }

    this._url = parsedURL;

    const query = parsedURL.query !== null ? parsedURL.query : "";
    this._searchParams = new URLSearchParams(query);
    this._searchParams._url = this;
  }

  static canParse(url, base) {
    try {
      new URL(url, base);
      return true;
    } catch {
      return false;
    }
  }

  static parse(url, base) {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  }

  get href() {
    return serializeURL(this._url);
  }

  set href(value) {
    const parsedURL = basicURLParse(String(value));
    if (parsedURL === null) {
      throw new TypeError(`Invalid URL: ${value}`);
    }

    this._url = parsedURL;

    const query = parsedURL.query !== null ? parsedURL.query : "";
    this._searchParams._list = [];
    if (query !== "") {
      this._searchParams._list = parseUrlencodedString(query);
    }
  }

  get origin() {
    return serializeURLOrigin(this._url);
  }

  get protocol() {
    return `${this._url.scheme}:`;
  }

  set protocol(value) {
    basicURLParse(`${String(value)}:`, { url: this._url, stateOverride: "scheme start" });
  }

  get username() {
    return this._url.username;
  }

  set username(value) {
    if (cannotHaveAUsernamePasswordPort(this._url)) {
      return;
    }
    setTheUsername(this._url, String(value));
  }

  get password() {
    return this._url.password;
  }

  set password(value) {
    if (cannotHaveAUsernamePasswordPort(this._url)) {
      return;
    }
    setThePassword(this._url, String(value));
  }

  get host() {
    const { host, port } = this._url;
    if (host === null) {
      return "";
    }
    if (port === null) {
      return serializeHost(host);
    }
    return `${serializeHost(host)}:${serializeInteger(port)}`;
  }

  set host(value) {
    if (hasAnOpaquePath(this._url)) {
      return;
    }
    basicURLParse(String(value), { url: this._url, stateOverride: "host" });
  }

  get hostname() {
    const { host } = this._url;
    if (host === null) {
      return "";
    }
    return serializeHost(host);
  }

  set hostname(value) {
    if (hasAnOpaquePath(this._url)) {
      return;
    }
    basicURLParse(String(value), { url: this._url, stateOverride: "hostname" });
  }

  get port() {
    const { port } = this._url;
    if (port === null) {
      return "";
    }
    return serializeInteger(port);
  }

  set port(value) {
    if (cannotHaveAUsernamePasswordPort(this._url)) {
      return;
    }
    value = String(value);
    if (value === "") {
      this._url.port = null;
    } else {
      basicURLParse(value, { url: this._url, stateOverride: "port" });
    }
  }

  get pathname() {
    return serializePath(this._url);
  }

  set pathname(value) {
    if (hasAnOpaquePath(this._url)) {
      return;
    }
    this._url.path = [];
    basicURLParse(String(value), { url: this._url, stateOverride: "path start" });
  }

  get search() {
    const { query } = this._url;
    if (query === null || query === "") {
      return "";
    }
    return `?${query}`;
  }

  set search(value) {
    value = String(value);
    if (value === "") {
      this._url.query = null;
      this._searchParams._list = [];
      return;
    }
    if (value[0] === "?") {
      value = value.slice(1);
    }
    this._url.query = "";
    basicURLParse(value, { url: this._url, stateOverride: "query" });
    this._searchParams._list = parseUrlencodedString(value);
  }

  get searchParams() {
    return this._searchParams;
  }

  get hash() {
    const { fragment } = this._url;
    if (fragment === null || fragment === "") {
      return "";
    }
    return `#${fragment}`;
  }

  set hash(value) {
    value = String(value);
    if (value === "") {
      this._url.fragment = null;
      return;
    }
    if (value[0] === "#") {
      value = value.slice(1);
    }
    this._url.fragment = "";
    basicURLParse(value, { url: this._url, stateOverride: "fragment" });
  }

  toString() {
    return this.href;
  }

  toJSON() {
    return this.href;
  }
}

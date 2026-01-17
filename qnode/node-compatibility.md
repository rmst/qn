# qnode Compatibility

`qnode` provides a subset of the Node.js API on top of QuickJS. This document lists what's available and what's not.

CommonJS is not supported. Use ES modules with `import.meta.dirname` and `import.meta.filename` instead of `__dirname` and `__filename`.

Reference: [Node.js Globals](https://nodejs.org/api/globals.html)

---

## Globals

### Console

| Global | Status |
|--------|--------|
| `console.log` | ✅ |
| `console.error` | ✅ |
| `console.warn` | ✅ |
| `console.info` | ✅ |
| `console.debug` | ✅ |
| `console.trace` | ❌ |
| `console.dir` | ❌ |
| `console.time` / `timeEnd` | ❌ |
| `console.table` | ❌ |
| `console.assert` | ❌ |

### Timers

| Global | Status | Notes |
|--------|--------|-------|
| `setTimeout` | ⚠️ | No extra args (throws `NodeCompatibilityError`) |
| `clearTimeout` | ✅ | |
| `setInterval` | ❌ | Throws `NodeCompatibilityError` |
| `clearInterval` | ❌ | Throws `NodeCompatibilityError` |
| `setImmediate` | ❌ | |
| `clearImmediate` | ❌ | |
| `queueMicrotask` | ❌ | |

### URL

| Global | Status | Notes |
|--------|--------|-------|
| `URL` | ✅ | IDN not supported (throws on non-ASCII hostnames) |
| `URLSearchParams` | ✅ | |

### Encoding

| Global | Status | Notes |
|--------|--------|-------|
| `TextEncoder` | ✅ | UTF-8 only |
| `TextDecoder` | ⚠️ | UTF-8 only; `fatal` and `stream` options throw `NodeCompatibilityError` |
| `atob` | ✅ | |
| `btoa` | ✅ | |

### Web APIs

| Global | Status | Notes |
|--------|--------|-------|
| `fetch` | ⚠️ | Requires `curl` in PATH; supports GET/POST/PUT/DELETE/etc, headers, body, redirects |
| `Response` | ✅ | `.text()`, `.json()`, `.arrayBuffer()`, `.clone()`, `Response.json()` |
| `Headers` | ✅ | Full WHATWG Headers interface |
| `Request` | ❌ | |
| `AbortController` / `AbortSignal` | ✅ | Full implementation with `abort()`, `signal.aborted`, events |
| `DOMException` | ✅ | Used by fetch and AbortController |
| `Blob` / `File` | ❌ | |
| `WebSocket` | ❌ | |
| `crypto` (Web Crypto) | ❌ | |

### Other

| Global | Status |
|--------|--------|
| `process` | ✅ |
| `global` / `globalThis` | ✅ |
| `structuredClone` | ❌ |
| `performance.now()` | ✅ |
| `navigator` | ❌ |

---

## Available `node:*` Imports

### `node:fs`

```js
import { readFileSync, writeFileSync, existsSync, ... } from 'node:fs';
```

| Function | Status | Notes |
|----------|--------|-------|
| `readFileSync` | ✅ | Returns `Uint8Array` if no encoding, string if `utf8` |
| `writeFileSync` | ✅ | Accepts string, `ArrayBuffer`, or `TypedArray` |
| `existsSync` | ✅ | |
| `statSync` | ✅ | |
| `lstatSync` | ✅ | |
| `readdirSync` | ⚠️ | No `withFileTypes` or `recursive` |
| `mkdirSync` | ✅ | Supports `recursive` |
| `unlinkSync` | ✅ | |
| `symlinkSync` | ✅ | |
| `readlinkSync` | ✅ | |
| `renameSync` | ✅ | |
| `realpathSync` | ✅ | |
| `rmSync` | ✅ | Supports `recursive` and `force` |
| `openSync` | ✅ | Returns file descriptor; supports `'r'` and `'w'` flags |
| `closeSync` | ✅ | Closes file descriptor |
| `linkSync` | ❌ | Throws |

### `node:process`

```js
import process from 'node:process';
```

| Property/Method | Status | Notes |
|-----------------|--------|-------|
| `argv` | ✅ | |
| `env` | ✅ | Full Proxy |
| `exit` | ✅ | |
| `cwd` | ✅ | |
| `pid` | ✅ | |
| `platform` | ⚠️ | Returns `os.platform` or `'quickjs'` |
| `version` | ⚠️ | Returns `'v1.0.0-quickjs'` |
| `stdin` | ⚠️ | Has `isTTY` only |
| `stdout` / `stderr` | ⚠️ | Has `write` and `isTTY` |
| `on` | ⚠️ | Signals only |

### `node:child_process`

```js
import { spawn, exec, execFile, execSync, execFileSync } from 'node:child_process';
```

| Function | Status | Notes |
|----------|--------|-------|
| `spawn` | ✅ | Supports `cwd`, `env`, `stdio`, `shell` |
| `exec` | ✅ | Async with callback, runs via shell |
| `execFile` | ✅ | Async with callback and events; supports `timeout`, `killSignal` |
| `execSync` | ✅ | Supports `cwd`, `env`, `input` (string/Buffer), `shell` |
| `execFileSync` | ✅ | Supports `cwd`, `env`, `input` (string/Buffer), `timeout`, `killSignal`, `stdio` (including numeric fds) |
| `ChildProcess` | ✅ | EventEmitter with streaming stdio |
| `spawnSync` | ❌ | |
| `fork` | ❌ | |

**Unsupported options** (throw `NodeCompatibilityError`): `uid`, `gid`, `detached`

**Ignored options**: `maxBuffer`, `windowsHide`

### `node:path`

```js
import path from 'node:path';
```

### `node:crypto`

```js
import { createHash } from 'node:crypto';
```

| Function | Status | Notes |
|----------|--------|-------|
| `createHash` | ⚠️ | SHA-256 only |

### `node:events`

```js
import { EventEmitter } from 'node:events';
```

| Method | Status |
|--------|--------|
| `on` / `addListener` | ✅ |
| `once` | ✅ |
| `emit` | ✅ |
| `off` / `removeListener` | ✅ |
| `removeAllListeners` | ✅ |
| `listeners` | ✅ |
| `listenerCount` | ✅ |
| `eventNames` | ✅ |

### `node:stream`

```js
import { Readable, Writable } from 'node:stream';
```

| Class | Status | Notes |
|-------|--------|-------|
| `Readable` | ✅ | `data`, `end`, `close`, `error` events; `pause`, `resume`, `destroy` |
| `Writable` | ✅ | `write`, `end`, `cork`, `uncork`, `destroy` |

### `node:buffer`

```js
import { Buffer } from 'node:buffer';
```

| Method | Status | Notes |
|--------|--------|-------|
| `Buffer.from` | ✅ | string, Array, ArrayBuffer, Uint8Array |
| `Buffer.alloc` | ✅ | |
| `Buffer.allocUnsafe` | ✅ | Same as `alloc` (no uninitialized memory) |
| `Buffer.isBuffer` | ✅ | |
| `Buffer.isEncoding` | ✅ | |
| `Buffer.concat` | ✅ | |
| `Buffer.byteLength` | ✅ | |
| `buffer.toString` | ✅ | utf8, base64, hex, latin1, ascii |
| `buffer.write` | ✅ | |
| `buffer.copy` | ✅ | |
| `buffer.equals` | ✅ | |
| `buffer.compare` | ✅ | |
| `buffer.slice` | ✅ | Returns Buffer (not Uint8Array) |
| `buffer.toJSON` | ✅ | |
| `buffer.fill` | ❌ | |
| `buffer.indexOf` | ❌ | |
| `buffer.includes` | ❌ | |
| `buffer.swap*` | ❌ | |
| `buffer.read*` / `write*` | ❌ | Integer read/write methods |

### `node:url`

```js
import { URL, URLSearchParams } from 'node:url';
```

WHATWG URL Standard implementation. Also available as globals.

| API | Status | Notes |
|-----|--------|-------|
| `URL` | ✅ | Full WHATWG URL parsing |
| `URL.canParse` | ✅ | |
| `URL.parse` | ✅ | |
| `URLSearchParams` | ✅ | Full query string handling |

**Limitation:** Internationalized Domain Names (IDN) are not supported. URLs with non-ASCII hostnames (e.g., `https://münchen.de/`) will throw a `TypeError`. Use Punycode form instead: `https://xn--mnchen-3ya.de/`

### `node:fetch`

```js
import { fetch, Headers, Response } from 'node:fetch';
```

Fetch API implementation using curl. Also available as globals (`fetch`, `Headers`, `Response`).

| API | Status | Notes |
|-----|--------|-------|
| `fetch` | ⚠️ | Async HTTP client; requires `curl` in PATH |
| `Headers` | ✅ | Case-insensitive header management |
| `Response` | ✅ | Response object with body consumption methods |
| `Request` | ❌ | Use plain options object instead |

**fetch() options:**
| Option | Status | Notes |
|--------|--------|-------|
| `method` | ✅ | GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS |
| `headers` | ✅ | Object, array of tuples, or Headers instance |
| `body` | ✅ | String, Uint8Array, or ArrayBuffer |
| `redirect` | ✅ | `'follow'` (default), `'manual'`, `'error'` |
| `signal` | ✅ | AbortSignal for cancellation |

**Response methods:**
| Method | Status | Notes |
|--------|--------|-------|
| `.text()` | ✅ | |
| `.json()` | ✅ | |
| `.arrayBuffer()` | ✅ | |
| `.clone()` | ✅ | |
| `.body` | ❌ | No streaming; response is fully buffered |
| `.blob()` | ❌ | |
| `.formData()` | ❌ | |
| `Response.json()` | ✅ | |
| `Response.redirect()` | ✅ | |
| `Response.error()` | ✅ | |

**Requirement:** `curl` must be available in PATH.

---

## Unavailable `node:*` Imports

The following Node.js built-in modules are **not available**:

- `node:assert`
- `node:async_hooks`
- `node:cluster`
- `node:dgram`
- `node:diagnostics_channel`
- `node:dns`
- `node:domain`
- `node:http`
- `node:http2`
- `node:https`
- `node:inspector`
- `node:net`
- `node:os`
- `node:perf_hooks`
- `node:punycode`
- `node:querystring`
- `node:readline`
- `node:repl`
- `node:string_decoder`
- `node:test`
- `node:timers`
- `node:tls`
- `node:tty`
- `node:util`
- `node:v8`
- `node:vm`
- `node:wasi`
- `node:worker_threads`
- `node:zlib`

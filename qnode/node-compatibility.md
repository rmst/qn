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

| Global | Status |
|--------|--------|
| `URL` | ❌ |
| `URLSearchParams` | ❌ |

### Encoding

| Global | Status |
|--------|--------|
| `Buffer` | ❌ |
| `TextEncoder` | ❌ |
| `TextDecoder` | ❌ |
| `atob` | ✅ |
| `btoa` | ✅ |

### Web APIs

| Global | Status |
|--------|--------|
| `fetch` | ❌ |
| `Request` / `Response` / `Headers` | ❌ |
| `AbortController` / `AbortSignal` | ❌ |
| `Blob` / `File` | ❌ |
| `WebSocket` | ❌ |
| `crypto` (Web Crypto) | ❌ |

### Other

| Global | Status |
|--------|--------|
| `process` | ✅ via `import` |
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
| `readFileSync` | ⚠️ | String only, requires encoding |
| `writeFileSync` | ⚠️ | String only |
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
import { execFileSync, execFile } from 'node:child_process';
```

| Function | Status | Notes |
|----------|--------|-------|
| `execFileSync` | ✅ | Supports `env`, `cwd`, `input` |
| `execFile` | ✅ | Async with callback and events |
| `ChildProcess` | ✅ | EventEmitter with streaming stdio |

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

---

## Unavailable `node:*` Imports

The following Node.js built-in modules are **not available**:

- `node:assert`
- `node:async_hooks`
- `node:buffer`
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
- `node:url`
- `node:util`
- `node:v8`
- `node:vm`
- `node:wasi`
- `node:worker_threads`
- `node:zlib`

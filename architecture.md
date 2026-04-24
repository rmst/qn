# Architecture

Qn is built from ~24K LOC of own code plus four vendored C dependencies and one vendored JS dependency. Everything compiles with just `make` and a C compiler — no cmake, autoconf, or other build tools.

## Own Code (~24K LOC)

**Node.js compatibility** (`node/node/`) — ~12.6K LOC JS. Shims for `node:fs`, `node:net`, `node:dgram`, `node:http`, `node:child_process`, `node:stream`, `node:crypto`, `node:path`, `node:events`, `node:url`, `node:os`, `node:buffer`, `node:assert`, `node:test`, `node:sqlite`, `node:module`, etc.

**Bootstrap and REPL** (`node/bootstrap.js`, `node/node-globals.js`, `node/repl.js`) — ~1.9K LOC JS. Startup, global setup, interactive shell.

**qn modules** (`node/qn/`) — ~0.5K LOC JS + crypto native module. Higher-level APIs: crypto primitives (`qn:crypto`, BearSSL-backed), async TLS I/O (`qn:tls`), HTTP server (`qn:http`), reverse proxy (`qn:proxy`), pseudo-terminal (`qn:pty`), TypeScript transform (`qn:sucrase`), package installer (`qn install`), bundler (`qn build` / `qn:bundle`), watch-mode runner (`qn --watch` / `qn:watch`, reuses `traceModuleGraph` from `qn:bundle`), libuv JS wrappers.

**qx** (`qx/`) — ~1K LOC JS. Shell scripting with `$` function (similar to zx).

**libuv C modules** (`libuv/`) — ~4.9K LOC C. Event loop, async I/O, networking, workers:
- `qn-vm.c` (761) — event loop ownership, timers, fd polling, microtask draining, promise rejection tracking (all state is `_Thread_local` for worker thread safety)
- `qn-worker.c` (674) — Web Worker implementation via `uv_socketpair` + `uv_pipe_t` + `uv_thread_create`. Each worker gets its own JSRuntime, JSContext, and libuv event loop. Messages use 4-byte length-prefixed `JS_WriteObject2`/`JS_ReadObject` serialization.
- `qn-uv-fs.c` (903) — async/sync filesystem operations via `uv_fs_*`
- `qn-uv-stream.c` (634) — unified TCP/Pipe/TTY stream abstraction
- `qn-uv-dgram.c` (310) — UDP datagram sockets via `uv_udp_t`
- `qn-uv-process.c` (698) — child process spawning via `uv_spawn`
- `qn-uv-pty.c` (480) — pseudo-terminal support via `forkpty` + libuv async I/O
- `qn-uv-utils.c` (540) — shared promise plumbing, error handling, string array helpers
- `qn-uv-signals.c` (181) — signal handling via `uv_signal_t`
- `qn-uv-dns.c` (163) — async DNS resolution via `uv_getaddrinfo`
- `qn-uv-fs-event.c` (218) — filesystem watching via `uv_fs_event_t` (powers `fs.watch`)

**Other C modules** — ~3.5K LOC C:
- `qnc/` — standalone compiler for building executables. Self-contained: embeds JS sources, C sources, headers, and static libs so it needs only a C compiler to produce binaries. Includes all default modules (node:\*, qn:\*, qx, ws) automatically. Native module auto-embedding via `package.json` `"qnc"` field.
- `sandboxed-worker/` (978) — sandboxed JS execution (currently broken, pending libuv integration)
- `introspect/` (30) — closure introspection (bulk is in QuickJS patch)

**Native module packages** — C modules auto-compiled and embedded by qnc at build time via `package.json` `"qnc"` field:
- `node/qn/crypto/qn-crypto.c` — crypto primitives + TLS bindings, compiled with BearSSL sources
- `node/node/sqlite/qjs-sqlite.c` — SQLite bindings, compiled with amalgamation

**Module resolution** ([`module_resolution/`](module_resolution/Readme.md)) — ~1.2K LOC C. NODE_PATH, node_modules walking, package.json resolution, `.ts`/`.js` extension probing. For standalone binaries: `embedded://` namespace separation, compile-time import map, `file://` protocol for forced disk loading.

**TypeScript support** — `.ts` files are transparently transformed on load via a per-thread source transform hook in `qn-vm.c`, called by `qn_module_loader` in `module-resolution.h`. The hook tries position-preserving strip mode first (accurate error locations), falling back to Sucrase's full transform for constructs like enums. Uses the same `stripTypeScriptTypes` / Sucrase infrastructure as the `node:module` shim. Value namespaces are desugared to the canonical `var N;(function(N){...})(N||(N={}))` IIFE form via a text-level pre-pass before either Sucrase path runs — Sucrase itself deliberately drops namespace bodies, and its `pushTypeContext` tokenization also splits `<<`/`>>`/`>=` inside those bodies, which would break the initial parse.

## Vendored Dependencies

### [libuv](https://libuv.org) (submodule: `vendor/libuv/`)

Cross-platform async I/O library. Powers the event loop, networking, filesystem, child processes, signals, and DNS. libuv uses CMake upstream, but its source files are well-organized by platform (`src/unix/*.c` for POSIX, `src/win/*.c` for Windows). We compile them directly in our Makefile, same as QuickJS. ~57K LOC.

### [QuickJS](https://github.com/bellard/quickjs) (submodule: `quickjs/`)

The JavaScript engine. Qn patches it lightly:
- `quickjs.patch` → `quickjs.c`: enhanced import error locations
- `quickjs-libc.patch` → `quickjs-libc.c`: `import.meta.dirname/filename`, UTF-8 encoding helpers

~90K LOC.

### [SQLite](https://sqlite.org) (vendored: `sqlite/`)

Single-file amalgamation. Bound to JS via `qjs-sqlite.c`. ~281K LOC.

### [BearSSL](https://github.com/nickray/bearssl) (submodule: `vendor/bearssl/`)

Crypto library providing TLS, hashing, HMAC, symmetric ciphers, RSA, ECDSA, and ECDH. Compiled as part of the `qn:crypto` native module via qnc's `source_dirs` feature. ~90K LOC.

### [ws](https://github.com/websockets/ws) (vendored: `vendor/ws/`)

WebSocket client and server implementation (RFC 6455). Vendored from ws v8.19.0 (MIT license, Luigi Pinca), converted from CJS to ESM, with compression (permessage-deflate) removed. Importable as `"ws"`. ~3.5K LOC.

### [Sucrase](https://github.com/alangpierce/sucrase) (submodule: `vendor/sucrase-js/`)

TypeScript/JSX transformer with its own parser (no TypeScript compiler dependency). Used by `node:module` to implement `stripTypeScriptTypes()` — types are replaced with whitespace to preserve source positions, inspired by [ts-blank-space](https://github.com/bloomberg/ts-blank-space). The vendored copy is a pure-JS conversion of Sucrase's TypeScript source. ~20K LOC.
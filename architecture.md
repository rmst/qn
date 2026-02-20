# Architecture

Qn is built from ~24K LOC of own code plus four vendored C dependencies and one vendored JS dependency. Everything compiles with just `make` and a C compiler — no cmake, autoconf, or other build tools.

## Own Code (~24K LOC)

**Node.js compatibility** (`node/node/`) — ~12.6K LOC JS. Shims for `node:fs`, `node:net`, `node:tls`, `node:http`, `node:child_process`, `node:stream`, `node:crypto`, `node:path`, `node:events`, `node:url`, `node:os`, `node:buffer`, `node:assert`, `node:test`, `node:sqlite`, `node:module`, etc.

**Bootstrap and REPL** (`node/bootstrap.js`, `node/node-globals.js`, `node/repl.js`) — ~1.9K LOC JS. Startup, global setup, interactive shell.

**qn modules** (`node/qn/`) — ~0.5K LOC JS. Higher-level APIs: HTTP server (`qn:http`), TypeScript transform (`qn:sucrase`), libuv JS wrappers.

**qx** (`qx/`) — ~1K LOC JS. Shell scripting with `$` function (similar to zx).

**libuv C modules** (`libuv/`) — ~4.2K LOC C. Event loop, async I/O, networking:
- `qn-vm.c` (761) — event loop ownership, timers, fd polling, microtask draining, promise rejection tracking
- `qn-uv-fs.c` (903) — async/sync filesystem operations via `uv_fs_*`
- `qn-uv-stream.c` (634) — unified TCP/Pipe/TTY stream abstraction
- `qn-uv-process.c` (698) — child process spawning via `uv_spawn`
- `qn-uv-utils.c` (503) — shared promise plumbing, error handling
- `qn-uv-signals.c` (181) — signal handling via `uv_signal_t`
- `qn-uv-dns.c` (163) — async DNS resolution via `uv_getaddrinfo`

**Other C modules** — ~3.5K LOC C:
- `qnc.c` (1068) — standalone compiler for building executables
- `sandboxed-worker/` (978) — sandboxed JS execution (currently broken, pending libuv integration)
- `tls/qn-tls.c` (921) — TLS bindings using BearSSL
- `sqlite/qjs-sqlite.c` (480) — SQLite bindings
- `introspect/` (30) — closure introspection (bulk is in QuickJS patch)

**Module resolution** ([`module_resolution/`](module_resolution/Readme.md)) — ~1.2K LOC C. NODE_PATH, node_modules walking, package.json resolution. For standalone binaries: `embedded://` namespace separation, compile-time import map, `file://` protocol for forced disk loading.

## Vendored Dependencies

### [libuv](https://libuv.org) (submodule: `vendor/libuv/`)

Cross-platform async I/O library. Powers the event loop, networking, filesystem, child processes, signals, and DNS. libuv uses CMake upstream, but its source files are well-organized by platform (`src/unix/*.c` for POSIX, `src/win/*.c` for Windows). We compile them directly in our Makefile, same as QuickJS and BearSSL. ~57K LOC.

### [QuickJS](https://github.com/bellard/quickjs) (submodule: `quickjs/`)

The JavaScript engine. Qn patches it lightly:
- `quickjs.patch` → `quickjs.c`: enhanced import error locations
- `quickjs-libc.patch` → `quickjs-libc.c`: `import.meta.dirname/filename`, UTF-8 encoding helpers

~90K LOC.

### [SQLite](https://sqlite.org) (vendored: `sqlite/`)

Single-file amalgamation. Bound to JS via `qjs-sqlite.c`. ~281K LOC.

### [BearSSL](https://github.com/nickray/bearssl) (submodule: `vendor/bearssl/`)

TLS library. BearSSL's state machine API fits well with libuv streams. Built via its own Makefile. ~90K LOC.

### [Sucrase](https://github.com/alangpierce/sucrase) (submodule: `vendor/sucrase-js/`)

TypeScript/JSX transformer with its own parser (no TypeScript compiler dependency). Used by `node:module` to implement `stripTypeScriptTypes()` — types are replaced with whitespace to preserve source positions, inspired by [ts-blank-space](https://github.com/bloomberg/ts-blank-space). The vendored copy is a pure-JS conversion of Sucrase's TypeScript source. ~20K LOC.
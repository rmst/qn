# Architecture

Qn is built from ~17K LOC of own code plus three vendored C dependencies. Everything compiles with just `make` and a C compiler — no cmake, autoconf, or other build tools.

## Own Code (~17K LOC)

**Node.js compatibility** (`node/node/`) — ~12.4K LOC JS. Shims for `node:fs`, `node:path`, `node:stream`, `node:crypto`, `node:http`, `node:net`, `node:tls`, etc.

**Bootstrap and REPL** (`node/bootstrap.js`, `node/node-globals.js`, `node/repl.js`) — ~1.9K LOC JS. Startup, global setup, interactive shell.

**qn modules** (`node/qn/`) — ~0.3K LOC JS. Higher-level APIs: HTTP server.

**qx** (`qx/`) — ~1K LOC JS. Shell scripting with `$` function (similar to zx).

**C native modules** — ~2.9K LOC C:
- Sandboxed workers (`sandboxed-worker/`) — 1K LOC
- TLS bindings (`tls/`) — 0.9K LOC
- POSIX sockets (`socket/`) — 0.6K LOC
- Filesystem extras (`native/`) — 0.4K LOC
- Closure introspection (`introspect/`) — 49 LOC (bulk is in QuickJS patch)

**Module resolution** ([`module_resolution/`](module_resolution/Readme.md)) — ~0.8K LOC C. NODE_PATH, node_modules walking, package.json resolution. For standalone binaries: `embedded://` namespace separation, compile-time import map, `file://` protocol for forced disk loading.

## Vendored Dependencies

### [QuickJS](https://github.com/bellard/quickjs) (submodule: `quickjs/`)

The JavaScript engine. Qn patches it lightly for enhanced import errors, module resolution, sandboxed workers, and closure introspection.

| Extension | Files | LOC |
|-----------|------:|-------:|
| .c        |    20 | 77,763 |
| .h        |    13 |  8,282 |
| .js       |     8 |  1,499 |
| other     |    13 |  2,967 |
| **Total** | **54**| **90,511** |

### [SQLite](https://sqlite.org) (vendored: `sqlite/`)

Provided as the single-file amalgamation. Bound to JS via `qjs-sqlite.c` (480 LOC).

| File         |     LOC |
|--------------|--------:|
| sqlite3.c    | 265,952 |
| sqlite3.h    |  13,968 |
| sqlite3ext.h |     730 |
| qjs-sqlite.c |     480 |
| **Total**    | **281,130** |

### [BearSSL](https://github.com/nickray/bearssl) (submodule: `vendor/bearssl/`)

TLS library. Used by `node:fetch` for HTTPS. Built via its own Makefile (`make lib`), which qn invokes.

| Extension | Files | LOC |
|-----------|------:|------:|
| .c        |   314 | 68,944 |
| .h        |    21 | 18,841 |
| other     |    16 |  2,441 |
| **Total** | **351** | **90,227** |


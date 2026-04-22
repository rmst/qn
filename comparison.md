# Comparison with Node.js and txiki.js

Qn, Node.js, and txiki.js all use libuv but pair it with different JavaScript engines (QuickJS in qn and txiki.js, V8 in Node.js) and make very different design trade-offs.

## Module-level C comparison (txiki.js)

| txiki module | txiki LOC | qn equivalent | qn LOC | Notes |
|---|---|---|---|---|
| `vm.c` | 659 | `qn-vm.c` | 761 | Both use three-handle pattern; qn also has timers, poll, randomFill, process/TTY utils |
| `mod_fs.c` | 1683 | `qn-uv-fs.c` + `qn/uv-fs.js` | 903 + 108 | Single-dispatch C + JS wrappers. Raw fds, not JSClassDef. |
| `mod_streams.c` | 1011 | `qn-uv-stream.c` + `qn/uv-stream.js` | 634 + 48 | TCP/Pipe/TTY via libuv |
| `mod_posix-socket.c` | 810 | *(removed)* | — | Streams cover this |
| `mod_udp.c` | 477 | — | — | Not needed yet |
| `mod_process.c` | 574 | `qn-uv-process.c` + `qn/uv-process.js` | 698 + 18 | Includes sync spawn and kill-by-PID |
| `mod_dns.c` | 122 | `qn-uv-dns.c` | 163 | Comparable |
| `mod_fswatch.c` | 235 | — | — | Not yet implemented |
| `signals.c` | 186 | `qn-uv-signals.c` | 181 | Nearly identical |
| `timers.c` | 173 | (in `qn-vm.c`) | (included above) | |
| — | — | `qn-uv-utils.c` | 503 | Shared promise plumbing, error handling |
| **Total own C** | **~19.7K** | | **~4.2K** | qn is ~5x less C code |
| **Total own JS** | **~13.4K** | | **~16.0K** | qn pushes more to JS |

## Module-level C comparison (Node.js)

Node.js C++ source files (`src/`) for the same subsystems qn implements. LOC counts are approximate (primary files only, not headers or JS layer).

| Node.js C++ source | Node LOC | qn equivalent | qn LOC | Notes |
|---|---|---|---|---|
| `env.cc` + `node.cc` (event loop) | ~4500 | `qn-vm.c` | 761 | Node manages per-isolate state, async hooks, etc. |
| `node_file.cc` | ~2800 | `qn-uv-fs.c` + `qn/uv-fs.js` | 1011 | Both use `uv_fs_*`. Node wraps fds in C++ `FileHandle`; qn uses raw fd ints. |
| `stream_base.cc` + `*_wrap.cc` | ~3200 | `qn-uv-stream.c` + `qn/uv-stream.js` | 682 | Node has `StreamBase` → `LibuvStreamWrap` → `TCPWrap` hierarchy. qn uses one flat struct. |
| `process_wrap.cc` + `spawn_sync.cc` | ~1300 | `qn-uv-process.c` + `qn/uv-process.js` | 716 | Both use fresh `uv_loop_t` for sync spawn. |
| `cares_wrap.cc` | ~2100 | `qn-uv-dns.c` | 163 | Node bundles c-ares for full DNS. qn only uses `uv_getaddrinfo`. |
| `signal_wrap.cc` | ~150 | `qn-uv-signals.c` | 181 | Comparable |
| `timer_wrap.cc` | ~150 | (in `qn-vm.c`) | (included above) | |
| `tls_wrap.cc` + `crypto_tls.cc` | ~3000 | `qn-tls.c` | 921 | Node uses OpenSSL. qn uses BearSSL state machine. |
| `crypto_random.cc` | ~200 | (in `qn-vm.c`) | (included above) | Node uses OpenSSL's `RAND_bytes`. qn uses `uv_random()`. |
| **Total** | **~17.4K** | | **~4.2K** | qn is ~4x less C code |

Node's total `src/` is ~150K LOC C++, but most is crypto (~45K), HTTP/2 (~8K), inspector (~10K), WASI (~3K), V8 integration (~15K) — subsystems qn doesn't have.

## Dependency comparison

### vs txiki.js

| txiki.js dep | LOC | qn equivalent | Notes |
|---|---|---|---|
| quickjs-ng | ~90K | Bellard's QuickJS (~84K) | Bellard's has 64-bit BigInt limbs, regex modifiers |
| libuv | ~57K | libuv (~57K) | Same |
| mbedtls | ~271K | BearSSL (~102K) | BearSSL is smaller, state-machine API fits well |
| libwebsockets | ~484K | JS HTTP parser + JS fetch (~3.5K) | Overkill; pure-JS approach is far simpler |
| ada | ~30K (C++) | JS URL parser (~2K) | Requires C++ compiler; JS impl works fine |
| wamr | ~232K | (none) | WebAssembly not needed |
| mimalloc | ~26K | system malloc | Optimization only |
| miniz | ~9.4K | (none) | Might add for HTTP gzip |
| sqlite3 | ~281K | sqlite3 (~281K) | Same |
| libffi | system | compiled-in C modules | Static modules are simpler |
| **Total vendored** | **~1.48M** | **~524K** | qn is ~3x less vendored code |

### vs Node.js

| Node.js dep | LOC | qn equivalent | Notes |
|---|---|---|---|
| V8 | ~3M+ | Bellard's QuickJS (~84K) | JIT-compiled vs interpreter-only, ~36x less code |
| libuv | ~57K | libuv (~57K) | Same |
| OpenSSL | ~700K+ | BearSSL (~102K) | BearSSL is minimal and constant-time by design |
| llhttp | ~6K | JS HTTP parser (~1.5K) | C parser for perf vs JS parser for simplicity |
| c-ares | ~30K | (libuv `uv_getaddrinfo`) | Full DNS vs A/AAAA only |
| nghttp2 | ~50K | (none) | HTTP/2 not needed yet |
| ada | ~30K (C++) | JS URL parser (~2K) | |
| ICU | ~25M | (none) | QuickJS has built-in Unicode tables |
| zlib | ~15K | (none) | Might add miniz later |
| brotli | ~450K | (none) | |
| simdutf | ~100K | (none) | QuickJS handles UTF conversion internally |
| **Total** | **~4M+** | **~524K** | qn is ~8x less vendored code (no C++) |

## Design differences

### vs Node.js

- **Single-dispatch C vs per-method C++ bindings** — Node registers each method as a separate V8 `FunctionTemplate`. qn uses one `_op(opcode, ...)` dispatch per module.
- **No C++ class hierarchy** — Node's `BaseObject` → `AsyncWrap` → `HandleWrap` → `StreamBase` → `TCPWrap`. qn uses flat C structs with a type tag.
- **Raw fd ints vs C++ FileHandle** — Node wraps fds in C++ objects with GC-driven close as a safety net. qn currently uses raw fd ints (no GC safety net for leaked fds).
- **QuickJS vs V8 embedding** — V8 needs `FunctionTemplate`/`ObjectTemplate`, accessors, weak callbacks. QuickJS uses `JS_NewCFunction` + `JSClassDef`.
- **JS-heavy composition** — Node implements `readFile` in C++. qn implements it as a JS loop over fd primitives. More flexible, easier to debug, less C.

### vs txiki.js

- **Single-dispatch C** instead of per-operation functions — less boilerplate, less C.
- **Raw fd ints for fs** instead of JSClassDef File objects (planned: add JSClassDef wrapper with GC-driven close, matching txiki and Node).
- **Stat as plain object** (constructed in JS) instead of JSClassDef StatResult.
- **Node.js API compat** — qn programs using `node:*` imports run on Node.js unchanged. txiki has its own `tjs.*` API.
- **Plain Makefile** — no CMake.

## Patterns adopted

### From txiki.js

- `js_malloc`/`js_free` for QuickJS-tracked allocation
- Centralized error handling (`qn_throw_errno` / `qn_new_error`)
- Two-phase shutdown (`closed`/`finalized` flags) for libuv handles
- `JSClassDef` with `.finalizer` and `.gc_mark` for handle-owning classes
- Three-handle pattern (`uv_prepare` + `uv_idle` + `uv_check`) for microtask integration
- Own promise rejection tracking via `JS_SetHostPromiseRejectionTracker`

### From Node.js

- Fresh `uv_loop_t` for sync operations (sync spawn)
- Stdio as `uv_stdio_container_t` array (pipe/inherit/ignore)
- `uv_kill` for kill-by-PID (cross-platform)
- Sync fs via `uv_fs_*` with NULL callback
- Signal name/number mapping table

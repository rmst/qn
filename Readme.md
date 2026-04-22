# Qn - Quickjs+Node.js

Qn is a lightweight JavaScript runtime built on [QuickJS](https://bellard.org/quickjs) and [libuv](https://libuv.org). It provides a subset of the Node.js API — not every Node.js program will run on qn, but every qn program using only the `node:*` API should run on Node.js without modification.

Features:

1. **libuv-based async I/O** — true async file I/O via thread pool (io_uring on supported kernels), TCP/TLS/HTTP networking, child process spawning, signal handling, DNS resolution
2. **Node.js compatibility** — `node:fs`, `node:net`, `node:dgram`, `node:http`, `node:child_process`, `node:stream`, `node:crypto`, `node:path`, `node:events`, `node:url`, `node:os`, `node:buffer`, `node:assert`, `node:test`, `node:sqlite`, `node:module`
2. **WebSocket support** — `ws` (client + server, RFC 6455) vendored and importable as `"ws"`
3. **TypeScript support** — `.ts` files run directly (`qn script.ts`), with source-position-preserving type stripping (falls back to full transform for enums/namespaces). Extension probing resolves `./foo` to `./foo.ts` when no `.js` exists.
4. **Module resolution** with two modes (see [docs](module_resolution/Readme.md)):
   - **Bundler mode** (default): `NODE_PATH` for bare imports, `node_modules` walking, `.js` and `/index.js` fallbacks
   - **Node mode** (`QJSX_MODULE_RESOLUTION=node`): matches Node.js ESM exactly
5. `import.meta.dirname` and `import.meta.filename`
6. `qn:http` — high-level HTTP server (`serve()` API)
7. `qn:introspect` — closure introspection and function serialization (see [introspect/](introspect/Readme.md))
8. Import errors include source location:
   - Export not found: `Could not find export 'foo' in module 'bar.js' (imported at main.js:5)`
   - Module not found: `could not load module filename 'foo.js' (imported from 'main.js')`

All original QuickJS features are preserved.


### Build
Building Qn, like QuickJS, should take less than a minute.

```bash
git clone --recurse-submodules https://github.com/rmst/qn.git
cd qn
make build  # Builds ./bin/qn, ./bin/qx, and ./bin/qnc
```


### Usage

**Run a script**
```bash
./bin/qn script.js    # JavaScript
./bin/qn script.ts    # TypeScript (types stripped on load)
```

Scripts can use `node:fs`, `node:net`, `node:http`, etc. TypeScript files are transparently transformed — type annotations are stripped while preserving source positions for accurate error messages.

**Module resolution with NODE_PATH**
```bash
NODE_PATH=./my_modules:./lib ./bin/qn script.js
```

`NODE_PATH` enables bare module imports (e.g., `import foo from "foo"`) by specifying search directories. Standard `node_modules` walking with `package.json` resolution is also supported.

**Shell scripting (qx)**
```bash
./bin/qx script.js  # zx-compatible shell scripting with $ function
```

**Bundle a web frontend**
```bash
./bin/qn build src/main.tsx --outdir=dist --jsx-import-source=preact
```

Walks static imports from an entry point, transforms TS/JSX via Sucrase, resolves `node_modules` with `package.json` exports, and emits a single self-contained JS file. No tree shaking or minification — a roughly Bun.build-compatible API for simple cases.

**Watch mode** (re-run on file change)
```bash
./bin/qn --watch script.js
```

Runs the script, then restarts it whenever any file in its import graph changes. The graph is traced statically via `qn:bundle`'s `traceModuleGraph`, so `.js`, `.ts`, `.json`, and literal-dynamic `import()` are all tracked. Computed dynamic imports aren't.


### Building Standalone Applications

`qnc` compiles JavaScript applications into standalone executables with embedded modules.

```bash
# Compile an application and embed all modules imported by main.js
NODE_PATH=./my_modules ./bin/qnc -o my-app main.js

# The resulting binary is a standalone executable
./my-app
```

Use the `-D` flag to embed modules that aren't directly imported but should be available to dynamically loaded scripts:

```bash
NODE_PATH=./libs ./bin/qnc -D utils -D config -o runtime bootstrap.js
./runtime external-script.js      # Can use import { ... } from "utils"
```

This is how `qn` itself is built — it compiles a minimal bootstrap with all node modules embedded using `-D` flags, creating a single native executable.


### Architecture

See [architecture.md](architecture.md) for codebase structure, [node/node-compatibility.md](node/node-compatibility.md) for API coverage, and [comparison.md](comparison.md) for comparisons with Node.js and txiki.js.

Key source files:

- `libuv/` — C modules for libuv integration (event loop, streams, fs, process, DNS, signals)
- `node/node/` — Node.js API shims in JS
- `node/qn/` — qn-specific modules (`qn:http`, libuv JS wrappers)
- `qnc/` — standalone compiler (main.c, embed.c for self-extracting support files, pack.c for build-time packing)
- `module_resolution/module-resolution.h` — shared module resolution logic
- `quickjs.patch` — applied to `quickjs/quickjs.c` (import error locations)
- `quickjs-libc.patch` — applied to `quickjs/quickjs-libc.c` (`import.meta.dirname/filename`, UTF-8 helpers)

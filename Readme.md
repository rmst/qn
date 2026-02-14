# Qn - Quickjs+Node.js

Qn is [QuickJS](https://bellard.org/quickjs) with a few additional features:

1. **Module resolution** with two modes (see [tests](test/module-resolution/)):
   - **Bundler mode** (default): `NODE_PATH` for bare imports, `node_modules` walking, `.js` and `/index.js` fallbacks
   - **Node mode** (`QJSX_MODULE_RESOLUTION=node`): matches Node.js ESM exactly

2. `import.meta.dirname` and `import.meta.filename`

3. `qn` binary with Node.js standard library shims (`node:fs`, `node:child_process`, etc.)

4. `os.SandboxedWorker` for running JS in a restricted environment (see [test](test/sandbox.test.js))

5. `qn:introspect` module for closure introspection and function serialization (see [introspect/](introspect/Readme.md))

6. Import errors include source location:
   - Export not found: `Could not find export 'foo' in module 'bar.js' (imported at main.js:5)`
   - Module not found: `could not load module filename 'foo.js' (imported from 'main.js')`

All original QuickJS features are preserved.


### Build
Building Qn, like QuickJS, should take less than a minute.

```bash
git clone --recurse-submodules https://github.com/rmst/qn.git
cd qn
make build  # Builds ./bin/qjsx, ./bin/qn, and ./bin/qjsxc
```


### Usage

**Basic JavaScript execution like QuickJS**
```bash
./bin/qjsx script.js
```

**Module resolution with NODE_PATH**
```bash
# script.js can import all modules in ./mymodules and ./lib.
NODE_PATH=./my_modules:./lib ./bin/qjsx script.js
```

`NODE_PATH` enables bare module imports (e.g., `import foo from "foo"`) by specifying search directories. Standard `node_modules` walking with `package.json` resolution is also supported.

**With Node.js compatibility modules**
```bash
./bin/qn script.js
```

`script.js` can use a subset of node:fs, node:child_process, etc (see `node/node`)


### Building Standalone Applications

`qjsxc` can be used to compile JavaScript applications into standalone executables with embedded modules.

#### Basic Usage
```bash
# Compile an application and embed all modules imported by main.js
NODE_PATH=./my_modules ./bin/qjsxc -o my-app main.js

# The resulting binary is a standalone executable
./my-app                          # (runs your application)
```

#### Embedding Additional Modules
Use the `-D` flag to embed modules that aren't directly imported but should be available to dynamically loaded scripts:

```bash
# Embed modules for dynamic loading
NODE_PATH=./libs ./bin/qjsxc -D utils -D config -o runtime bootstrap.js

# External scripts can now import these modules
./runtime external-script.js      # Can use import { ... } from "utils"
```

This is how `qn` is built - it compiles a minimal bootstrap with all node modules embedded using `-D` flags, creating a single native executable that can run any script with Node.js compatibility.

### Architecture

See [architecture.md](architecture.md) for an overview of own code and vendored dependencies (QuickJS, SQLite, BearSSL, lwIP, WireGuard).

The following files are used to compile the `qjsx` binary:

- `quickjs.patch` is applied to `quickjs/quickjs.c` (import error locations)
- `qjsx.patch` is applied to `quickjs/qjs.c`
- `qjsxc.patch` is applied to `quickjs/qjsc.c`
- `quickjs-libc.patch` is applied to `quickjs/quickjs-libc.c`
- `module_resolution/module-resolution.h` contains shared module resolution logic (NODE_PATH, node_modules, package.json)

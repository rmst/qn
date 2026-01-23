# qx vs zx Compatibility

This document compares qx (for QuickJS) with [Google's zx](https://google.github.io/zx/api).

## Key Differences

| Feature | zx | qx |
|---------|-----|-----|
| Configuration | `` $`cmd`.quiet() `` or `$.quiet = true` | **`` $.quiet`cmd` ``** |
| Assignment | `$.quiet = true` allowed | **Throws error** |
| Runtime | Node.js | QuickJS |

## Core Execution

| Feature | zx | qx | Notes |
|---------|-----|-----|-------|
| `` $`cmd` `` | ✅ | ✅ | |
| `` $.sync`cmd` `` | ✅ | ❌ | Not implemented |
| `` $({...})`cmd` `` | ✅ | ✅ | |

## Configuration via `$` Properties

| Property | zx | qx | Notes |
|----------|-----|-----|-------|
| `$.quiet` | Returns boolean | **Returns configured shell** | Use `` $.quiet`cmd` `` |
| `$.verbose` | Returns boolean | **Returns configured shell** | Use `` $.verbose`cmd` `` |
| `$.nothrow` | Returns boolean | **Returns configured shell** | Use `` $.nothrow`cmd` `` |
| `$.shell` | ✅ Read/write | Read-only | Use `` $({ shell: '...' })`cmd` `` |
| `$.prefix` | ✅ Read/write | Read-only | Use `` $({ prefix: '...' })`cmd` `` |
| `$.quiet = true` | ✅ Sets global | ❌ **Throws error** | Use `` $.quiet`cmd` `` |
| `$.verbose = true` | ✅ Sets global | ❌ **Throws error** | Use `` $.verbose`cmd` `` |
| `$.nothrow = true` | ✅ Sets global | ❌ **Throws error** | Use `` $.nothrow`cmd` `` |

## ProcessPromise Methods

| Method | zx | qx | Notes |
|--------|-----|-----|-------|
| `.quiet()` | ✅ | ✅ | Deprecated in qx, use `$.quiet` |
| `.nothrow()` | ✅ | ✅ | Deprecated in qx, use `$.nothrow` |
| `.verbose()` | ✅ | ✅ | Deprecated in qx, use `$.verbose` |
| `.pipe(dest)` | ✅ | ✅ | Supports late piping with buffer replay |
| `.pipe(filepath)` | ✅ | ✅ | |
| `.kill(signal)` | ✅ | ✅ | |
| `.text()` | ✅ | ✅ | |
| `.lines()` | ✅ | ✅ | |
| `.json()` | ✅ | ✅ | |
| `.buffer()` | ✅ | ✅ | |
| `.blob()` | ✅ | ❌ | Not implemented |
| `.timeout(ms)` | ✅ | ✅ | |
| `.abort()` | ✅ | ❌ | Not implemented |
| `.stdio()` | ✅ | ❌ | Not implemented |
| `.unpipe()` | ✅ | ❌ | Not implemented |
| `.run()` | ✅ | ✅ | For manual start |
| `[Symbol.asyncIterator]` | ✅ | ❌ | Not implemented |

## ProcessPromise Properties

| Property | zx | qx | Notes |
|----------|-----|-----|-------|
| `.stdin` | ✅ | ✅ | |
| `.stdout` | ✅ | ✅ | |
| `.stderr` | ✅ | ✅ | |
| `.stage` | ✅ | ✅ | |
| `.exitCode` | ✅ Promise | ❌ | Use `(await p).exitCode` |
| `.signal` | ✅ AbortSignal | ❌ | Not implemented |

## ProcessOutput Properties & Methods

| Feature | zx | qx | Notes |
|---------|-----|-----|-------|
| `.stdout` | ✅ | ✅ | |
| `.stderr` | ✅ | ✅ | |
| `.exitCode` | ✅ | ✅ | |
| `.signal` | ✅ | ✅ | |
| `.text()` | ✅ | ✅ | |
| `.lines()` | ✅ | ✅ | |
| `.json()` | ✅ | ✅ | |
| `.toString()` | ✅ | ✅ | |
| `.buffer()` | ✅ | ✅ | |
| `.blob()` | ✅ | ❌ | Not implemented |

## Utilities & Helpers

| Feature | zx | qx | Notes |
|---------|-----|-----|-------|
| `cd()` | ✅ | ✅ | |
| `pwd()` | ✅ | ✅ | |
| `within()` | ✅ | ✅ | |
| `sleep()` | ✅ | ✅ | |
| `argv` | ✅ | ✅ | |
| `echo()` | ✅ | ❌ | Use `console.log` |
| `question()` | ✅ | ❌ | Not implemented |
| `stdin()` | ✅ | ❌ | Not implemented |
| `retry(count, fn)` | ✅ | ✅ | |
| `spinner()` | ✅ | ❌ | Not implemented |
| `fetch()` | ✅ | ✅ | Via `node:fetch` shim |
| `glob()` | ✅ | ✅ | |
| `which()` | ✅ | ❌ | Not implemented |
| `tmpdir()` | ✅ | ❌ | Use `node:fs` and `node:os` |
| `tmpfile()` | ✅ | ❌ | Use `node:fs` and `node:os` |
| `kill()` | ✅ | ❌ | Not implemented |
| `ps` | ✅ | ❌ | Not implemented |

## Bundled Packages

| Package | zx | qx | Notes |
|---------|-----|-----|-------|
| `chalk` | ✅ | ❌ | Not bundled |
| `fs-extra` | ✅ | ❌ | Use `node:fs` shim |
| `globby` | ✅ | ❌ | Not bundled |
| `yaml` | ✅ | ❌ | Not bundled |
| `minimist` | ✅ | ❌ | Not bundled |
| `dotenv` | ✅ | ❌ | Not bundled |

## Shell Presets

| Feature | zx | qx | Notes |
|---------|-----|-----|-------|
| `useBash()` | ✅ | ❌ | Use `$({ shell: '/bin/bash' })` |
| `usePowerShell()` | ✅ | ❌ | Not applicable (POSIX focus) |
| `usePwsh()` | ✅ | ❌ | Not applicable (POSIX focus) |

## Advanced Features

| Feature | zx | qx | Notes |
|---------|-----|-----|-------|
| `$({halt: true})` | ✅ | ❌ | Not implemented |
| `syncProcessCwd()` | ✅ | ❌ | Not implemented |
| Quote functions | ✅ | ✅ | Built-in escaping |
| Template interpolation | ✅ | ✅ | With automatic escaping |
| Array interpolation | ✅ | ✅ | Joins with spaces |
| ProcessOutput interpolation | ✅ | ✅ | Uses stdout |

## Piping

| Feature | zx | qx | Notes |
|---------|-----|-----|-------|
| `.pipe(dest)` | ✅ | ✅ | |
| `.pipe(filepath)` | ✅ | ✅ | |
| Streaming pipe | ✅ | ✅ | Data flows immediately |
| Late piping | ✅ | ✅ | Buffer replay supported |
| `pipe.stdout`, `pipe.stderr` | ✅ | ❌ | Only stdout piping |

## Summary

qx implements the core zx functionality needed for shell scripting:
- Command execution with template literals
- Output handling (text, lines, json, buffer)
- Piping between processes (streaming, with binary support)
- Configuration (quiet, nothrow, verbose)

**Better in qx:**
- Cleaner configuration API (`` $.quiet`cmd` `` vs `` $`cmd`.quiet() ``)
- No global mutable state (assignments throw)

**Not implemented in qx:**
- Sync execution (`$.sync`)
- Advanced process control (abort, stdio)
- Rich utilities (which, question, spinner)
- Bundled packages (chalk, yaml, etc.)

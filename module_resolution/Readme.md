# Module Resolution

This directory contains the module resolution implementation for QJSX.

## Import Types

| Import type | Example | Resolution |
|-------------|---------|------------|
| **Bare** | `lodash`, `node:fs` | QJSXPATH / embedded lookup, no realpath |
| **Filesystem** | `./foo`, `../bar`, `/path/to/foo` | `realpath()` → absolute canonical path |

## Resolution Details

### Bare Imports

Bare imports (no leading `/`, `./`, or `../`) are resolved via:

1. **Colon-to-slash translation**: `node:fs` → `node/fs`
2. **QJSXPATH lookup**: Search directories in `QJSXPATH` environment variable
3. **Extension probing** (bundler mode only): Try `.js`, then `/index.js`

For compiled binaries, bare imports check the embedded module list first, then fall back to QJSXPATH.

### Filesystem Paths (Relative and Absolute)

Both relative (`./foo`, `../bar`) and absolute (`/path/to/foo`) imports are filesystem paths:

1. **Relative resolution**: Resolve against the importing module's directory
2. **Symlink resolution**: `realpath()` converts to canonical absolute path
3. **Extension probing** (bundler mode only): Try `.js`, then `/index.js`

This means relative imports resolve against the **real location** of the importing file, not a symlink's location. This matches Node.js ESM behavior.

### Compile Time vs Runtime

| Context | Behavior |
|---------|----------|
| **Compile time** | Modules are discovered and embedded under their resolved canonical names |
| **Runtime (interpreted)** | Modules are resolved and loaded from disk |
| **Runtime (compiled)** | Embedded modules checked first by name, then fall back to disk |

## Resolution Modes

### Bundler Mode (default)

- Extension probing enabled: `./foo` tries `./foo.js`, `./foo/index.js`
- More lenient, matches bundler conventions

### Node Mode (`QJSX_MODULE_RESOLUTION=node`)

- Explicit extensions required: `./foo.js` not `./foo`
- Matches Node.js ESM behavior exactly
- QJSXPATH and colon-to-slash still work

## Debugging

Set `QJSX_MODULE_DEBUG=1` to print module resolution steps:

```bash
QJSX_MODULE_DEBUG=1 ./bin/qjsx script.js
```

Output shows:
- Normalizer inputs (base module, import specifier)
- Realpath resolution results
- Final resolved module name

## Path Leakage in Compiled Binaries

When compiling with `qjsxc`, filesystem paths (relative and absolute imports) are embedded as absolute canonical paths. This may expose build environment paths in the binary.

To avoid path leakage, use **bare imports** with QJSXPATH:

```bash
# Instead of relative imports:
import { foo } from './lib/utils.js'

# Use bare imports:
import { foo } from 'lib/utils'
# With: QJSXPATH=./lib qjsxc -o app main.js
```

Bare imports are embedded under canonical names like `lib/utils.js` without absolute paths.

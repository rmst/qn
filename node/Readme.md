# qn

Standalone QuickJS executable with embedded Node.js-compatible modules.

## Building

Built automatically via `make build`. The build:
- Compiles `node/bootstrap.js` with `qjsxc`
- Embeds all modules from `node/node/` directory
- Uses `NODE_PATH=./node` for module resolution

Note: `node:*` imports (e.g., `node:fs`, `node:process`) are normalized to `node/*` paths, so NODE_PATH must point to the parent directory containing the `node/` folder.

## Usage

```bash
./bin/qn script.js
```

The executable includes built-in support for:
- `node:fs` - File system operations
- `node:process` - Process information
- `node:child_process` - Child process spawning
- `node:crypto` - Cryptographic operations
- `node:path` - Path manipulation utilities

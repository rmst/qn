# qx

Minimal [zx](https://github.com/google/zx)-compatible shell scripting for QuickJS.

Commands run via `/bin/sh` (POSIX shell). Interpolated values are safely escaped using single quotes.

## Usage

**As a standalone binary:**
```bash
./bin/qx script.js
```

**As a library in qn:**
```javascript
import { $, ProcessPromise, ProcessOutput } from 'qx'
// or
import $ from 'qx'

const result = await $`ls -la`
```

## The `$` Function

```javascript
// Basic command
const result = await $`echo "Hello World"`
console.log(result.stdout)  // "Hello World\n"

// Output formatters
const text = await $`echo "hello"`.text()       // "hello"
const lines = await $`ls`.lines()               // ["file1", "file2", ...]
const data = await $`cat config.json`.json()    // { ... }

// Error handling
const result = await $`exit 1`.nothrow()        // No exception thrown
console.log(result.exitCode)                    // 1

// Piping
await $`echo "hello"`.pipe($`tr a-z A-Z`)       // HELLO
await $`ls`.pipe('files.txt')                   // Write to file

// Interpolation
const name = "world"
await $`echo "Hello ${name}"`
```

## Helpers

```javascript
cd('/tmp')              // Change directory
pwd()                   // Get current directory
echo('Hello')           // Print to stdout
await sleep(1000)       // Sleep for 1 second
argv                    // Script arguments (process.argv.slice(2))

// Run code in different directory, restore cwd after
await within(async () => {
    cd('/tmp')
    await $`ls`
})
```

## Node.js Modules

All qn shims are available:

```javascript
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
```

See [node-compatibility.md](../qnode/node-compatibility.md) for details.

## Configuration

```javascript
$.shell = '/bin/sh'     // Shell to use (default: /bin/sh)
$.prefix = 'set -e;'    // Prefix for shell commands (default: set -e;)
$.verbose = false       // Print commands before execution

// For bash with pipefail:
$.shell = '/bin/bash'
$.prefix = 'set -euo pipefail;'
```

**POSIX notes:**
- `set -e` — exit on error (POSIX)
- `set -u` — error on undefined variables (POSIX)
- `set -o pipefail` — NOT POSIX (bash/zsh only)

# SandboxedWorker

A Worker-like API for running JavaScript in a restricted environment without access to `std` or `os` modules.

## Usage

```javascript
import * as os from 'os'

const worker = new os.SandboxedWorker({
    code: `
        Worker.parent.onmessage = (e) => {
            Worker.parent.postMessage({ result: e.data.value * 2 })
        }
    `
})

worker.onmessage = (e) => console.log(e.data.result)  // 42
worker.postMessage({ value: 21 })
```

File-based workers: `new os.SandboxedWorker('worker.js')`

With imports enabled: `new os.SandboxedWorker('worker.js', { allowImports: true })`

## What's available in the sandbox

- `console.log` / `print`
- `Worker.parent.postMessage()` / `Worker.parent.onmessage`
- Pure JavaScript (no `std`, no `os`, no native modules)

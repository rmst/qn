# SandboxedWorker Development Notes

## Architecture

SandboxedWorker is implemented as a separate module that integrates with QuickJS via a small patch to `quickjs-libc.c`. The patch adds three things:
1. `#include "sandboxed-worker/sandboxed-worker.h"`
2. Call to `js_sandbox_init()` during os module initialization
3. Call to `js_sandbox_add_export()` to export the class

All sandbox logic lives in this directory, keeping the patch minimal.

## Type Compatibility with QuickJS Worker

The implementation reuses QuickJS's existing event loop infrastructure. Our types are memory-compatible with QuickJS internal types:

| Our Type | QuickJS Type | Purpose |
|----------|--------------|---------|
| `SandboxMessagePipe` | `JSWorkerMessagePipe` | Message queue + waker |
| `SandboxMessageHandler` | `JSWorkerMessageHandler` | Port in event loop |
| `SandboxMessage` | `JSWorkerMessage` | Serialized message |

This allows us to add our message handler to the main thread's `port_list`, so the existing `js_os_poll` function handles our messages automatically.

**Risk**: If upstream changes these struct layouts, we break (tests would catch this). The escape hatch (below) provides a quick fix while we update our types.

## Escape Hatch

All code is guarded by `#ifdef USE_SANDBOX`. To disable if upstream breaks:

```makefile
# Comment out this line in Makefile:
CFLAGS += -DUSE_SANDBOX
```

This compiles `sandboxed-worker.o` to empty, and the patch-added code is ifdef'd out.

## Security Model

**What's blocked in the sandbox:**
- `std` module (file I/O, etc.)
- `os` module (processes, signals, etc.)
- Native `.so` modules (checked in module loader)

**What's available:**
- `console.log` / `print` (for debugging)
- `Worker.parent.postMessage()` / `Worker.parent.onmessage`
- All standard JavaScript built-ins

**Import behavior:**
- `allowImports: false` (default for code strings): No module loader, no imports
- `allowImports: true` or file-based workers: Can import JS files, but not `.so`

## Event Loop Integration

Parent side: When `worker.onmessage` is set, we add a `SandboxMessageHandler` to the main thread's `port_list` (accessed via `JS_GetRuntimeOpaque`). The existing `js_os_poll` then handles incoming messages.

Worker side: The worker thread runs its own event loop (`sandbox_event_loop`) that polls for messages and calls `Worker.parent.onmessage`.

## Thread Lifecycle

Worker threads are created with `PTHREAD_CREATE_DETACHED`, same as regular Worker. Resources are automatically reclaimed when the thread exits.

## Limitations (same as regular os.Worker)

- No `terminate()` method (regular Worker doesn't have one either)
- No graceful shutdown on SIGTERM
- File-based workers can import other files even with `allowImports: false`

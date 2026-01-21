# AsyncLocalStorage Implementation Notes

This document outlines an approach for implementing `AsyncLocalStorage` from `node:async_hooks` in qn.

## The Problem

A pure JS shim for `AsyncLocalStorage` cannot work because QuickJS's native `await` bypasses `Promise.prototype.then`. Verified with:

```javascript
const orig = Promise.prototype.then
Promise.prototype.then = function(...args) {
  console.log("then intercepted")  // Never prints for await!
  return orig.call(this, ...args)
}

async function test() {
  await Promise.resolve(1)
}
test()
```

Explicit `.then()` calls are intercepted, but `await` goes straight through C-level promise machinery.

## Minimal C-Level Solution

All async continuations (await, .then, etc.) flow through QuickJS's job queue. Hooking `JS_EnqueueJob` and `JS_ExecutePendingJob` captures everything.

### Required Changes (~15 lines of C)

**1. Add context ID to JSContext** (`quickjs.c`):
```c
// In JSContext struct
uint64_t current_async_context_id;
```

**2. Add context ID to JSJobEntry** (~line 859):
```c
typedef struct JSJobEntry {
    struct list_head link;
    JSContext *realm;
    JSJobFunc *job_func;
    int argc;
    uint64_t async_context_id;  // ADD THIS
    JSValue argv[0];
} JSJobEntry;
```

**3. Capture context in JS_EnqueueJob()** (~line 1793):
```c
e->async_context_id = ctx->current_async_context_id;
```

**4. Restore context in JS_ExecutePendingJob()** (~line 1823):
```c
uint64_t saved = ctx->current_async_context_id;
ctx->current_async_context_id = e->async_context_id;
res = e->job_func(ctx, e->argc, (JSValueConst *)e->argv);
ctx->current_async_context_id = saved;
```

**5. Expose to JS** (new exported functions):
```c
uint64_t JS_GetAsyncContextId(JSContext *ctx) {
    return ctx->current_async_context_id;
}

void JS_SetAsyncContextId(JSContext *ctx, uint64_t id) {
    ctx->current_async_context_id = id;
}
```

These need JS bindings, likely in `quickjs-libc.c` or a new qn-specific file.

### JavaScript Implementation

With the C bindings in place:

```javascript
const stores = new Map()
let nextId = 1

class AsyncLocalStorage {
  run(store, callback, ...args) {
    const id = nextId++
    const prev = getAsyncContextId()  // C binding
    stores.set(id, store)
    setAsyncContextId(id)
    try {
      return callback(...args)
    } finally {
      setAsyncContextId(prev)
      // Cannot delete store here - async callbacks may still reference it
    }
  }

  exit(callback, ...args) {
    const prev = getAsyncContextId()
    setAsyncContextId(0)
    try {
      return callback(...args)
    } finally {
      setAsyncContextId(prev)
    }
  }

  getStore() {
    const id = getAsyncContextId()
    return id ? stores.get(id) : undefined
  }

  enterWith(store) {
    const id = nextId++
    stores.set(id, store)
    setAsyncContextId(id)
  }

  disable() {
    const id = getAsyncContextId()
    if (id) stores.delete(id)
    setAsyncContextId(0)
  }
}

export { AsyncLocalStorage }
```

## Memory Management Considerations

The `stores` Map will leak if `disable()` is never called. Options:

1. **Manual cleanup** - Require users to call `disable()` (Node.js behavior)
2. **WeakRef** - If QuickJS supports it, use `FinalizationRegistry` to clean up
3. **Scope tracking** - Track nested run() calls and clean up when outermost exits

## What This Does NOT Implement

The full `node:async_hooks` API includes more than just `AsyncLocalStorage`:

- `createHook()` - Low-level async lifecycle hooks
- `executionAsyncId()` / `triggerAsyncId()` - Async resource IDs
- `AsyncResource` - Manual async context management

These would require more extensive C changes to track async resource creation/destruction. For most use cases, `AsyncLocalStorage` alone is sufficient.

## Testing

Key test cases:

```javascript
import { AsyncLocalStorage } from 'node:async_hooks'

const als = new AsyncLocalStorage()

// Basic sync
als.run({ id: 1 }, () => {
  assert(als.getStore().id === 1)
})

// Across await
als.run({ id: 2 }, async () => {
  assert(als.getStore().id === 2)
  await Promise.resolve()
  assert(als.getStore().id === 2)  // Must still work!
  await fetch('...')
  assert(als.getStore().id === 2)  // And here
})

// Nested runs
als.run({ id: 3 }, () => {
  als.run({ id: 4 }, () => {
    assert(als.getStore().id === 4)
  })
  assert(als.getStore().id === 3)
})

// exit()
als.run({ id: 5 }, () => {
  als.exit(() => {
    assert(als.getStore() === undefined)
  })
  assert(als.getStore().id === 5)
})
```

## References

- Node.js AsyncLocalStorage: https://nodejs.org/api/async_context.html
- QuickJS source: `quickjs/quickjs.c`
- Existing qn patches: `*.patch` files in repo root

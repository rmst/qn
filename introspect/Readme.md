# qn:introspect

Closure introspection and function serialization for Qn.

```javascript
import { getClosureVars, serialize, deserialize } from 'qn:introspect';
```

## API

### getClosureVars(fn)

Returns an object containing the closure variables captured by a function.

```javascript
let x = 5, y = 10;
let f = () => x + y;
getClosureVars(f)  // { x: 5, y: 10 }
```

### serialize(fn, options?)

Serializes a function and its closure variables to a JSON string. Uses a tagged union format where all values are wrapped with type information.

```javascript
let multiplier = 3;
let f = (x) => x * multiplier;
serialize(f)  // '{"t":"function","code":"(x) => x * multiplier","closureVars":{...}}'
```

Options:
- `replacer(value)` - Custom serialization for non-standard types. Must return `{ t: 'TypeName', ...data }` or `undefined` to use default handling.

```javascript
serialize(fn, {
    replacer: (value) => {
        if (value instanceof Date) {
            return { t: 'Date', iso: value.toISOString() };
        }
    }
});
```

### deserialize(str, options?)

Restores a function from its serialized form.

```javascript
let restored = deserialize(str);
restored(5)  // works like the original
```

Options:
- `reviver(type, data)` - Custom deserialization for types created by a replacer.

```javascript
deserialize(str, {
    reviver: (type, data) => {
        if (type === 'Date') return new Date(data.iso);
    }
});
```

## Limitations

### What gets captured

Closure variables from enclosing scopes are captured, including module-level bindings:

```javascript
// utils.js
let secret = 42;
export function helper(x) { return x + secret; }

// main.js
import { helper } from './utils.js';  // captured (including helper's own closure)
let multiplier = 2;                    // captured

let f = (x) => helper(x) * multiplier;
serialize(f);  // captures: helper (with secret=42), multiplier
```

Imported functions are serialized recursively with their own closure variables.

**Not captured:** True globals like `console`, `Math`, `fetch` that aren't defined in any module scope. These must exist in the deserialize environment.

### Types requiring custom replacer/reviver

- `Date`, `RegExp`, `Error`
- `Map`, `Set`
- `BigInt`
- `ArrayBuffer`, typed arrays (`Uint8Array`, etc.)
- Class instances (prototype chain is lost without custom handling)

### Cannot be serialized

- **Native functions** - `.toString()` returns `[native code]`
- **WeakMap/WeakSet** - contents cannot be enumerated
- **Symbols** - not JSON-serializable
- **Circular object references** - JSON.stringify throws

### Behavioral limitations

- **Object identity** - same object in multiple places becomes distinct objects after deserialize
- **Prototype chains** - plain objects only; class instances lose their prototype
- **Property descriptors** - getters, setters, non-enumerable properties are lost
- **`this` binding** - `.bind()` is not preserved; method context depends on call site
- **Self-referential named functions** - `function f() { return f(); }` won't work (f is undefined after deserialize)

### Security

Uses `new Function()` internally. **Never deserialize untrusted input.**

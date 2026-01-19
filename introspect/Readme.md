# qn:introspect

Closure introspection and function serialization for Qn.

```javascript
import { getClosureVars, closureToSource } from 'qn:introspect';
```

## API

### getClosureVars(fn)

Returns an object containing the closure variables captured by a function.

```javascript
let x = 5, y = 10;
let f = () => x + y;
getClosureVars(f)  // { x: 5, y: 10 }
```

### closureToSource(fn)

Converts a function to standalone JavaScript source code. The returned code, when evaluated, produces the function with all closure variables embedded.

```javascript
let multiplier = 3;
let f = (x) => x * multiplier;

closureToSource(f)
// Returns:
// (() => {
//   let multiplier = 3;
//   return (x) => x * multiplier;
// })()
```

The output is portable JavaScript that works in any JS environment - Node.js, browsers, Deno, etc. No deserialization library needed.

```javascript
// Generate standalone code
let code = closureToSource(f);

// Use it anywhere
let restored = eval(code);
// Or: new Function('return ' + code)()
// Or: write to file and import
```

Nested functions are handled recursively:

```javascript
// utils.js
let secret = 42;
export function helper(x) { return x + secret; }

// main.js
import { helper } from './utils.js';
let f = (x) => helper(x) + 100;

closureToSource(f)
// Returns:
// (() => {
//   let helper = (() => {
//     let secret = 42;
//     return function helper(x) { return x + secret; };
//   })();
//   return (x) => helper(x) + 100;
// })()
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
closureToSource(f);  // captures: helper (with secret=42), multiplier
```

Imported functions are serialized recursively with their own closure variables.

**Not captured:** True globals like `console`, `Math`, `fetch` that aren't defined in any module scope. These must exist in the execution environment.

### Supported types

- Primitives: `number`, `string`, `boolean`, `null`, `undefined`
- `Array`
- Plain objects
- Functions (recursively with their closures)

### Cannot be converted

- **Native functions** - `.toString()` returns `[native code]`
- **Date, RegExp, Map, Set, etc.** - not yet supported (custom type support planned)
- **Symbols** - not representable as source code
- **Circular function references** - throws an error
- **Class instances** - converted to plain objects (prototype lost)

### Behavioral limitations

- **Object identity** - same object referenced multiple times becomes distinct objects
- **Property descriptors** - getters, setters, non-enumerable properties are lost
- **`this` binding** - `.bind()` is not preserved
- **Self-referential named functions** - `function f() { return f(); }` won't work

### Security

The output is executable code. **Never execute untrusted output.**

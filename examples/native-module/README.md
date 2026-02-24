# Native Module Example

A minimal native C module for qn.

## Development (dynamic loading)

Build the `.so` and run with the interpreter:

```bash
qnc package .
qn index.js
```

## Production (standalone binary)

Compile everything into a single executable:

```bash
qnc -o app index.js
./app
```

Both commands read the same `package.json` `"qnc"` field for build configuration.

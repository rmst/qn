
### Read/Watch
- Structured stack trace access: https://github.com/bellard/quickjs/issues/235
- Typescript: https://github.com/bellard/quickjs/issues/173
- Sockets: https://github.com/bellard/quickjs/pull/405

## Bugs

## Improvements

The Nodejs --import cli option https://nodejs.org/api/cli.html#--importmodule (usage: https://nodejs.org/api/module.html#enabling) is probably how importing should be done here as well

`-e` / `--eval` doesn't support static `import` declarations (only dynamic `import()`). Node.js has the same limitation — it requires `--input-type=module` to enable module syntax in eval. We'd need to expose `JS_Eval` with `JS_EVAL_TYPE_MODULE` from C or use a similar flag.
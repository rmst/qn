
### Read/Watch
- Structured stack trace access: https://github.com/bellard/quickjs/issues/235
- Typescript: https://github.com/bellard/quickjs/issues/173
- Sockets: https://github.com/bellard/quickjs/pull/405

## Bugs
fs.rmSync with force: true should ignore errors if the path doesn't exist, but probably it should still throw errors for permission issues

## Improvements

The Nodejs --import cli option https://nodejs.org/api/cli.html#--importmodule (usage: https://nodejs.org/api/module.html#enabling) is probably how importing should be done here as well
# Tests

Run with `jix run` (container) or `jix run host` (local node).

Tests execute qjsx/qjsxc binaries and verify JSON output. For qjsx-node shim tests,  each test runs twice: once with Node.js, once with qjsx-node. Both must produce the expected output. That way we're testing qjsx-node and testing our tests at the same time.

`util.js` exports `test` (wraps each test with a temp dir as `{ dir }`) and `$` (tagged template for shell commands).

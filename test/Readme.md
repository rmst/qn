# Tests

Run with `jix run` (container) or `jix run host` (local node).

Tests execute qjsx/qjsxc binaries and verify JSON output. For qjsx-node shim tests, we compare output against real Node.js to ensure compatibility.

`util.js` exports `test` (wraps each test with a temp dir as `{ dir }`) and `$` (tagged template for shell commands).

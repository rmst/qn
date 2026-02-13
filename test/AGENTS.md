Don't make any assumptions about your test environment (except POSIX), e.g. never just use /bin/bash in a test.

Be careful, the test could be run in a TTY, and ansi color codes can mess up output comparison.

### macOS vs Linux portability
Tests run on both macOS and Linux. Watch out for:
- GNU vs BSD CLI differences (`stat -c` vs `stat -f`, `date +%3N` not supported on macOS)
- `printf '\xNN'` escape handling differs (macOS builtin doesn't support `\x`)
- `/tmp` is a symlink to `/private/tmp` on macOS — use `realpathSync` when comparing paths
- Socket constants differ (`AF_INET6` is 30 on macOS, 10 on Linux) — don't hardcode, compare against the actual exported values
- `NO_NODEJS_TESTS` env var means Node.js is not available — tests that use `node` as a fixture (e.g. spawning a test server) must also respect this
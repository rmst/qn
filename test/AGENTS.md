Don't make any assumptions about your test environment (except POSIX), e.g. never just use /bin/bash in a test.

Be careful, the test could be run in a TTY, and ansi color codes can mess up output comparison.
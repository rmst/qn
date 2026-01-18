# SQLite Amalgamation

This directory contains the SQLite amalgamation and QuickJS bindings.

## Source

The SQLite amalgamation was obtained from the official SQLite download page:

- **Version**: 3.51.2
- **URL**: https://www.sqlite.org/2026/sqlite-amalgamation-3510200.zip
- **SHA3-256**: `9a9dd4eef7a97809bfacd84a7db5080a5c0eff7aaf1fc1aca20a6dc9a0c26f96`

## Files

- `sqlite3.c` - SQLite amalgamation (all source in one file)
- `sqlite3.h` - SQLite header
- `sqlite3ext.h` - SQLite extension header
- `qjs-sqlite.c` - QuickJS bindings

## Updating

To update to a newer version:

1. Download the latest amalgamation from https://www.sqlite.org/download.html
2. Replace `sqlite3.c`, `sqlite3.h`, and `sqlite3ext.h`
3. Verify the SHA3-256 hash matches the one listed on the download page

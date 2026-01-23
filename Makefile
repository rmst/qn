#
# QJSX Makefile
#
# Builds the qjsx executable with QJSXPATH module resolution support
#

VERSION = 2024-01-13

# Git version info for --version flag
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_DIRTY := $(shell test -n "$$(git status --porcelain 2>/dev/null)" && echo 1 || echo 0)
BUILD_TIME := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

# Install prefix (override with: make install PREFIX=~/.local)
PREFIX ?= /usr/local

# Compiler settings
CC = gcc
CFLAGS = -Wall -Wno-array-bounds -fwrapv \
         -D_GNU_SOURCE -DCONFIG_VERSION='"$(VERSION)"' -DCONFIG_BIGNUM

# GCC-specific warning flags (Clang doesn't support these)
ifneq (,$(findstring gcc,$(shell $(CC) --version 2>/dev/null)))
CFLAGS += -Wno-format-truncation
endif

# Sandbox support (comment out to disable if upstream QuickJS breaks compatibility)
CFLAGS += -DUSE_SANDBOX

CFLAGS_OPT = $(CFLAGS) -O2
LDFLAGS = -rdynamic -s

# Debug build: make DEBUG=1
ifdef DEBUG
CFLAGS += -g
LDFLAGS += -g
endif
LIBS = -lm -ldl -lpthread

# Build directories (can be overridden: make BIN_DIR=/tmp/build)
PLATFORM := $(shell uname -s | tr '[:upper:]' '[:lower:]')
BIN_DIR ?= bin/$(PLATFORM)

# Program names
QJSX_PROG = $(BIN_DIR)/qjsx
QN_PROG = $(BIN_DIR)/qn
QX_PROG = $(BIN_DIR)/qx
QJSXC_PROG = $(BIN_DIR)/qjsxc

# QuickJS object files (from our copied and built QuickJS)
# Note: use our patched quickjs-libc.o to extend import.meta
QUICKJS_OBJS = $(BIN_DIR)/quickjs/.obj/quickjs.o $(BIN_DIR)/quickjs/.obj/libregexp.o \
               $(BIN_DIR)/quickjs/.obj/libunicode.o $(BIN_DIR)/quickjs/.obj/cutils.o \
               $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/quickjs/.obj/dtoa.o \
               $(BIN_DIR)/quickjs/.obj/repl.o $(BIN_DIR)/obj/sandboxed-worker.o \
               $(BIN_DIR)/obj/introspect.o

# Convenience symlinks
QJSX_LINK = bin/qjsx
QN_LINK = bin/qn
QX_LINK = bin/qx
QJSXC_LINK = bin/qjsxc

# Default target
all: quickjs-deps $(QJSX_PROG) $(QN_PROG) $(QX_PROG) $(QJSXC_PROG) convenience-links

# Create directories
$(BIN_DIR):
	mkdir -p $(BIN_DIR)

$(BIN_DIR)/obj:
	mkdir -p $(BIN_DIR)/obj

# Build qjsx executable
$(QJSX_PROG): $(BIN_DIR)/obj/qjsx.o $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/obj/sandboxed-worker.o $(BIN_DIR)/obj/introspect.o quickjs-deps | $(BIN_DIR)
	$(CC) $(LDFLAGS) -o $@ $(BIN_DIR)/obj/qjsx.o $(QUICKJS_OBJS) $(LIBS)
	chmod +x $@

# Generate qjsx.c from quickjs/qjs.c by applying the patch
$(BIN_DIR)/obj/qjsx.c: quickjs/qjs.c qjsx.patch module_resolution/module-resolution.h | $(BIN_DIR)/obj
	patch -p0 < qjsx.patch -o $@ quickjs/qjs.c

# Build qjsx.o from the patched source
$(BIN_DIR)/obj/qjsx.o: $(BIN_DIR)/obj/qjsx.c module_resolution/module-resolution.h | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Build qjsxc executable
$(QJSXC_PROG): $(BIN_DIR)/obj/qjsxc.o $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/obj/sandboxed-worker.o $(BIN_DIR)/obj/introspect.o quickjs-deps | $(BIN_DIR)
	$(CC) $(LDFLAGS) -o $@ $(BIN_DIR)/obj/qjsxc.o $(QUICKJS_OBJS) $(LIBS)
	chmod +x $@
	cp $(BIN_DIR)/quickjs/*.h $(BIN_DIR)/
	mkdir -p $(BIN_DIR)/module_resolution
	cp module_resolution/module-resolution.h $(BIN_DIR)/module_resolution/
	cp exit-handler.h $(BIN_DIR)/
	cp $(BIN_DIR)/quickjs/libquickjs.a $(BIN_DIR)/
	# Replace unpatched quickjs-libc.o with patched version in libquickjs.a
	# Also add sandboxed-worker.o and introspect.o which are required by the patched quickjs-libc
	ar d $(BIN_DIR)/libquickjs.a quickjs-libc.nolto.o 2>/dev/null || true
	ar r $(BIN_DIR)/libquickjs.a $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/obj/sandboxed-worker.o $(BIN_DIR)/obj/introspect.o

# Generate qjsxc.c from quickjs/qjsc.c by applying the patch
$(BIN_DIR)/obj/qjsxc.c: quickjs/qjsc.c qjsxc.patch module_resolution/module-resolution.h | $(BIN_DIR)/obj
	patch -p0 < qjsxc.patch -o $@ quickjs/qjsc.c

# Build qjsxc.o from the patched source
$(BIN_DIR)/obj/qjsxc.o: $(BIN_DIR)/obj/qjsxc.c module_resolution/module-resolution.h | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -DCONFIG_CC=\"$(CC)\" -DCONFIG_PREFIX=\"/usr/local\" -I. -I$(BIN_DIR)/obj -I$(BIN_DIR)/quickjs -c -o $@ $<

# Patch and build quickjs-libc (adds import.meta.dirname, sandbox support, and introspection)
$(BIN_DIR)/obj/quickjs-libc.c: quickjs/quickjs-libc.c quickjs-libc.patch sandboxed-worker/sandboxed-worker.patch introspect/introspect.patch | $(BIN_DIR)/obj
	patch -p0 < quickjs-libc.patch -o $@ quickjs/quickjs-libc.c
	patch -p0 < sandboxed-worker/sandboxed-worker.patch $@
	patch -p0 < introspect/introspect.patch $@

$(BIN_DIR)/obj/quickjs-libc.o: $(BIN_DIR)/obj/quickjs-libc.c | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Build introspect module (depends on quickjs-deps for patched quickjs.h with JS_GetClosureVars)
$(BIN_DIR)/obj/introspect.o: introspect/introspect.c introspect/introspect.h quickjs-deps | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Build sandbox module (compiles to empty if USE_SANDBOX is not defined)
$(BIN_DIR)/obj/sandboxed-worker.o: sandboxed-worker/sandboxed-worker.c sandboxed-worker/sandboxed-worker.h quickjs-deps | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Build SQLite amalgamation
$(BIN_DIR)/obj/sqlite3.o: sqlite/sqlite3.c | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -DSQLITE_OMIT_LOAD_EXTENSION -c -o $@ $<

# Build SQLite QuickJS bindings
$(BIN_DIR)/obj/qjs-sqlite.o: sqlite/qjs-sqlite.c sqlite/sqlite3.h | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Isqlite -c -o $@ $<

# Build qn-native (extra OS functions like chmod)
$(BIN_DIR)/obj/qn-native.o: native/qn-native.c quickjs-deps | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Native C extensions for linking
NATIVE_OBJS = $(BIN_DIR)/obj/sqlite3.o $(BIN_DIR)/obj/qjs-sqlite.o $(BIN_DIR)/obj/qn-native.o

# Generate version info module for qn/qx --version
$(BIN_DIR)/obj/qn/version-info.js: | $(BIN_DIR)/obj
	@mkdir -p $(BIN_DIR)/obj/qn
	@if [ "$(GIT_DIRTY)" = "1" ]; then \
		echo "export const commit = '$(GIT_COMMIT)', buildTime = '$(BUILD_TIME)';" > $@; \
	else \
		echo "export const commit = '$(GIT_COMMIT)', buildTime = null;" > $@; \
	fi

# Build qn (standalone executable with embedded node modules, qx, sqlite, and native extensions)
$(QN_PROG): node/bootstrap.js node/node-globals.js node/node/* node/node/*/* node/repl.js qx/index.js qx/core.js $(QJSXC_PROG) $(NATIVE_OBJS) $(BIN_DIR)/obj/qn/version-info.js quickjs-deps | $(BIN_DIR)
	QJSXPATH=./node:./qx:$(BIN_DIR)/obj $(QJSXC_PROG) -e -M sqlite_native,sqlite -M qn_native,qn_native -D node-globals -D repl -D node:fs -D node:process -D node:child_process -D node:crypto -D node:path -D node:events -D node:stream -D node:buffer -D node:url -D node:abort -D node:fetch -D node:sqlite -D node:util -D node:assert -D node:test -D node:os -D qn:introspect -D qn:version-info -D qx -o $(BIN_DIR)/obj/qn.c node/bootstrap.js
	$(CC) $(CFLAGS_OPT) $(LDFLAGS) -I$(BIN_DIR) -o $@ $(BIN_DIR)/obj/qn.c $(NATIVE_OBJS) $(BIN_DIR)/libquickjs.a $(LIBS)

# Build qx (zx-compatible shell scripting with $ function)
$(QX_PROG): qx/bootstrap.js node/node-globals.js qx/* node/node/* node/node/*/* node/repl.js $(QJSXC_PROG) $(NATIVE_OBJS) $(BIN_DIR)/obj/qn/version-info.js quickjs-deps | $(BIN_DIR)
	QJSXPATH=./node:./qx:$(BIN_DIR)/obj $(QJSXC_PROG) -e -M sqlite_native,sqlite -M qn_native,qn_native -D node-globals -D repl -D node:fs -D node:process -D node:child_process -D node:crypto -D node:path -D node:events -D node:stream -D node:buffer -D node:url -D node:abort -D node:fetch -D node:sqlite -D node:util -D node:assert -D node:test -D node:os -D qn:introspect -D qn:version-info -D qx -o $(BIN_DIR)/obj/qx.c qx/bootstrap.js
	$(CC) $(CFLAGS_OPT) $(LDFLAGS) -I$(BIN_DIR) -o $@ $(BIN_DIR)/obj/qx.c $(NATIVE_OBJS) $(BIN_DIR)/libquickjs.a $(LIBS)

# Create convenience symlinks in bin/ directory
convenience-links: $(QJSX_PROG) $(QN_PROG) $(QX_PROG) $(QJSXC_PROG)
	@mkdir -p bin
	@ln -sf $(PLATFORM)/qjsx $(QJSX_LINK)
	@ln -sf $(PLATFORM)/qn $(QN_LINK)
	@ln -sf $(PLATFORM)/qx $(QX_LINK)
	@ln -sf $(PLATFORM)/qjsxc $(QJSXC_LINK)

# Build QuickJS by copying it to our bin dir, patching, and building
# Uses a sentinel file to track when patch was applied, so changes to
# quickjs.patch trigger a re-copy and re-patch
$(BIN_DIR)/quickjs/.patched: quickjs.patch $(wildcard quickjs/*.c quickjs/*.h) | $(BIN_DIR)
	@echo "Copying QuickJS to $(BIN_DIR)/quickjs..."
	@rm -rf $(BIN_DIR)/quickjs
	@cp -r quickjs $(BIN_DIR)/quickjs
	@echo "Applying quickjs.patch..."
	@patch -p0 -d $(BIN_DIR) < quickjs.patch
	@touch $@

quickjs-deps: $(BIN_DIR)/quickjs/.patched
	$(MAKE) -C $(BIN_DIR)/quickjs .obj/quickjs.o .obj/libregexp.o .obj/libunicode.o .obj/cutils.o .obj/dtoa.o .obj/repl.o libquickjs.a

# Objects using -I$(BIN_DIR)/quickjs need quickjs-deps to exist first
$(BIN_DIR)/obj/qjsx.o $(BIN_DIR)/obj/qjsxc.o $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/obj/qjs-sqlite.o: quickjs-deps

# Clean build artifacts
clean:
	rm -rf $(BIN_DIR)

# Clean all platforms
clean-all:
	rm -rf bin/

# Build everything (QuickJS + qjsx)
build: quickjs-deps all

# Install qjsx, qn, qx, and qjsxc
install: $(QJSX_PROG) $(QN_PROG) $(QX_PROG) $(QJSXC_PROG)
	mkdir -p "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QJSX_PROG) "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QN_PROG) "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QX_PROG) "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QJSXC_PROG) "$(DESTDIR)$(PREFIX)/bin"

# Test target
test:
	jix run -f test

test2:
	jix run -f test containerized


# Help target
help:
	@echo "QJSX Makefile targets:"
	@echo "  all         - Build qjsx, qn, qx, and qjsxc executables"
	@echo "  build       - Build QuickJS dependencies and all programs"
	@echo "  test        - Build and run tests"
	@echo "  clean       - Clean build artifacts"
	@echo "  clean-all   - Clean everything including QuickJS"
	@echo "  install     - Install all programs to \$$(PREFIX)/bin"
	@echo ""
	@echo "Usage examples:"
	@echo "  make build"
	@echo "  make test"
	@echo "  QJSXPATH=./my_modules ./bin/qjsx script.js"
	@echo "  QJSXPATH=./my_modules ./bin/qjsxc -o app.c app.js"
	@echo "  ./bin/qx script.js    # zx-compatible shell scripting"

.PHONY: all build clean clean-all install help quickjs-deps convenience-links test

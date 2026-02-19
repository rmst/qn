#
# QJSX Makefile
#
# Builds the qjsx executable with NODE_PATH module resolution support
#

VERSION = 2024-01-13

# Git version info for --version flag
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_DIRTY := $(shell test -n "$$(git status --porcelain 2>/dev/null)" && echo 1 || echo 0)
BUILD_TIME := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

# Install prefix (override with: make install PREFIX=~/.local)
PREFIX ?= /usr/local

# Platform detection (used for build dirs and conditional flags)
PLATFORM := $(shell uname -s | tr '[:upper:]' '[:lower:]')

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
LDFLAGS = -rdynamic
ifneq ($(PLATFORM),darwin)
LDFLAGS += -s
endif

# Debug build: make DEBUG=1
ifdef DEBUG
CFLAGS += -g
LDFLAGS += -g
endif
LIBS = -lm -ldl -lpthread
ifneq ($(PLATFORM),darwin)
LIBS += -lrt
endif

# Build directories (can be overridden: make BIN_DIR=/tmp/build)
BIN_DIR ?= bin/$(PLATFORM)

# libuv static library path (must be defined before rules that reference it)
LIBUV_LIB := $(BIN_DIR)/libuv.a
LIBUV_DIR := vendor/libuv
LIBUV_CFLAGS := -Ivendor/libuv/include -Ivendor/libuv/src

# libuv source files (core + unix + linux-specific)
LIBUV_SRCS = src/fs-poll.c src/idna.c src/inet.c src/random.c src/strscpy.c \
             src/strtok.c src/thread-common.c src/threadpool.c src/timer.c \
             src/uv-common.c src/uv-data-getter-setters.c src/version.c \
             src/unix/async.c src/unix/core.c src/unix/dl.c src/unix/fs.c \
             src/unix/getaddrinfo.c src/unix/getnameinfo.c src/unix/loop.c \
             src/unix/loop-watcher.c src/unix/pipe.c src/unix/poll.c \
             src/unix/posix-hrtime.c src/unix/process.c \
             src/unix/proctitle.c src/unix/random-devurandom.c \
             src/unix/random-getrandom.c src/unix/random-sysctl-linux.c \
             src/unix/signal.c src/unix/stream.c src/unix/tcp.c \
             src/unix/thread.c src/unix/tty.c src/unix/udp.c \
             src/unix/linux.c src/unix/procfs-exepath.c \
             src/unix/sysinfo-loadavg.c src/unix/sysinfo-memory.c \
             src/unix/no-proctitle.c

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

# Build libuv static library from source (no cmake needed)
$(LIBUV_LIB): $(addprefix $(LIBUV_DIR)/,$(LIBUV_SRCS)) | $(BIN_DIR)
	@echo "Building libuv..."
	@mkdir -p $(BIN_DIR)/obj/libuv
	@for f in $(LIBUV_SRCS); do \
		oname=$$(echo $$f | tr '/' '_' | sed 's/\.c$$/.o/'); \
		$(CC) $(CFLAGS_OPT) $(LIBUV_CFLAGS) -c -o $(BIN_DIR)/obj/libuv/$$oname $(LIBUV_DIR)/$$f; \
	done
	@ar rcs $@ $(BIN_DIR)/obj/libuv/*.o

# Build qjsx executable
$(QJSX_PROG): $(BIN_DIR)/obj/qjsx.o $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/obj/sandboxed-worker.o $(BIN_DIR)/obj/introspect.o quickjs-deps $(LIBUV_LIB) | $(BIN_DIR)
	$(CC) $(LDFLAGS) -o $@ $(BIN_DIR)/obj/qjsx.o $(QUICKJS_OBJS) $(LIBUV_LIB) $(LIBS)
	chmod +x $@

# Generate qjsx.c from quickjs/qjs.c by applying the patch
$(BIN_DIR)/obj/qjsx.c: quickjs/qjs.c qjsx.patch module_resolution/module-resolution.h | $(BIN_DIR)/obj
	patch -p0 < qjsx.patch -o $@ quickjs/qjs.c

# Build qjsx.o from the patched source
$(BIN_DIR)/obj/qjsx.o: $(BIN_DIR)/obj/qjsx.c module_resolution/module-resolution.h | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Build qjsxc executable
$(QJSXC_PROG): $(BIN_DIR)/obj/qjsxc.o $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/obj/sandboxed-worker.o $(BIN_DIR)/obj/introspect.o quickjs-deps $(LIBUV_LIB) | $(BIN_DIR)
	$(CC) $(LDFLAGS) -o $@ $(BIN_DIR)/obj/qjsxc.o $(QUICKJS_OBJS) $(LIBUV_LIB) $(LIBS)
	chmod +x $@
	cp $(BIN_DIR)/quickjs/*.h $(BIN_DIR)/
	mkdir -p $(BIN_DIR)/module_resolution
	cp module_resolution/module-resolution.h $(BIN_DIR)/module_resolution/
	cp exit-handler.h $(BIN_DIR)/
	mkdir -p $(BIN_DIR)/libuv
	cp libuv/qn-vm.h $(BIN_DIR)/libuv/
	cp $(BIN_DIR)/quickjs/libquickjs.a $(BIN_DIR)/
	# Replace unpatched quickjs-libc.o with patched version in libquickjs.a
	# Also add sandboxed-worker.o, introspect.o, qn-vm.o, qn-uv-utils.o which are required
	ar d $(BIN_DIR)/libquickjs.a quickjs-libc.nolto.o 2>/dev/null || true
	ar r $(BIN_DIR)/libquickjs.a $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/obj/sandboxed-worker.o $(BIN_DIR)/obj/introspect.o $(BIN_DIR)/obj/qn-vm.o $(BIN_DIR)/obj/qn-uv-utils.o
	# libuv.a is already in $(BIN_DIR) via $(LIBUV_LIB)

# Generate qjsxc.c from quickjs/qjsc.c by applying the patch
$(BIN_DIR)/obj/qjsxc.c: quickjs/qjsc.c qjsxc.patch module_resolution/module-resolution.h | $(BIN_DIR)/obj
	patch -p0 < qjsxc.patch -o $@ quickjs/qjsc.c

# Build qjsxc.o from the patched source
$(BIN_DIR)/obj/qjsxc.o: $(BIN_DIR)/obj/qjsxc.c module_resolution/module-resolution.h | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -DCONFIG_CC=\"$(CC)\" -DCONFIG_PREFIX=\"/usr/local\" -I. -I$(BIN_DIR)/obj -I$(BIN_DIR)/quickjs -c -o $@ $<

# Patch and build quickjs-libc (adds import.meta.dirname, sandbox support, introspection, and libuv hook)
$(BIN_DIR)/obj/quickjs-libc.c: quickjs/quickjs-libc.c quickjs-libc.patch sandboxed-worker/sandboxed-worker.patch introspect/introspect.patch libuv/libuv.patch | $(BIN_DIR)/obj
	patch -p0 < quickjs-libc.patch -o $@ quickjs/quickjs-libc.c
	patch -p0 < sandboxed-worker/sandboxed-worker.patch $@
	patch -p0 < introspect/introspect.patch $@
	patch -p0 < libuv/libuv.patch $@

$(BIN_DIR)/obj/quickjs-libc.o: $(BIN_DIR)/obj/quickjs-libc.c $(LIBUV_LIB) | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

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

# Build qn-socket (POSIX socket bindings)
$(BIN_DIR)/obj/qn-socket.o: socket/qn-socket.c quickjs-deps | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Build BearSSL static library
BEARSSL_LIB = $(BIN_DIR)/bearssl/libbearssl.a
$(BEARSSL_LIB):
	@echo "Building BearSSL..."
	@$(MAKE) -s -C vendor/bearssl BUILD=$(abspath $(BIN_DIR)/bearssl) lib

# Build qn-tls (TLS client bindings using BearSSL)
$(BIN_DIR)/obj/qn-tls.o: tls/qn-tls.c $(BEARSSL_LIB) quickjs-deps | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/bearssl/inc -c -o $@ $<

# Build qn-uv-utils (shared utility infrastructure for libuv modules)
$(BIN_DIR)/obj/qn-uv-utils.o: libuv/qn-uv-utils.c libuv/qn-uv-utils.h quickjs-deps $(LIBUV_LIB) | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

# Build qn-uv-fs (async filesystem operations via libuv)
$(BIN_DIR)/obj/qn-uv-fs.o: libuv/qn-uv-fs.c libuv/qn-uv-utils.h quickjs-deps $(LIBUV_LIB) | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

# Build qn-uv-dns (async DNS resolution via libuv)
$(BIN_DIR)/obj/qn-uv-dns.o: libuv/qn-uv-dns.c libuv/qn-uv-utils.h quickjs-deps $(LIBUV_LIB) | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

# Build qn-uv-signals (signal handling via libuv uv_signal_t)
$(BIN_DIR)/obj/qn-uv-signals.o: libuv/qn-uv-signals.c libuv/qn-uv-utils.h quickjs-deps $(LIBUV_LIB) | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

# Build qn-uv-stream (TCP/Pipe/TTY streams via libuv)
$(BIN_DIR)/obj/qn-uv-stream.o: libuv/qn-uv-stream.c libuv/qn-uv-stream.h libuv/qn-uv-utils.h quickjs-deps $(LIBUV_LIB) | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

# Build qn-uv-process (child process spawning via libuv)
$(BIN_DIR)/obj/qn-uv-process.o: libuv/qn-uv-process.c libuv/qn-uv-stream.h libuv/qn-uv-utils.h quickjs-deps $(LIBUV_LIB) | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

# Build qn-vm (event loop ownership: timers, poll, uv_run)
$(BIN_DIR)/obj/qn-vm.o: libuv/qn-vm.c libuv/qn-vm.h libuv/qn-uv-utils.h quickjs-deps $(LIBUV_LIB) | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

# Native C extensions for linking
NATIVE_OBJS = $(BIN_DIR)/obj/sqlite3.o $(BIN_DIR)/obj/qjs-sqlite.o $(BIN_DIR)/obj/qn-native.o $(BIN_DIR)/obj/qn-socket.o $(BIN_DIR)/obj/qn-tls.o $(BIN_DIR)/obj/qn-uv-utils.o $(BIN_DIR)/obj/qn-uv-fs.o $(BIN_DIR)/obj/qn-uv-dns.o $(BIN_DIR)/obj/qn-uv-signals.o $(BIN_DIR)/obj/qn-uv-stream.o $(BIN_DIR)/obj/qn-uv-process.o $(BIN_DIR)/obj/qn-vm.o
# Generate version info module for qn/qx --version
# Uses FORCE + cmp to always check but only update when content changes,
# avoiding unnecessary rebuilds of qn/qx.
$(BIN_DIR)/obj/qn/version-info.js: FORCE | $(BIN_DIR)/obj
	@mkdir -p $(BIN_DIR)/obj/qn
	@if [ "$(GIT_DIRTY)" = "1" ]; then \
		echo "export const commit = '$(GIT_COMMIT)', buildTime = '$(BUILD_TIME)';" > $@.tmp; \
	else \
		echo "export const commit = '$(GIT_COMMIT)', buildTime = null;" > $@.tmp; \
	fi
	@cmp -s $@ $@.tmp && rm $@.tmp || mv $@.tmp $@

# Build qn (standalone executable with embedded node modules, qx, sqlite, and native extensions)
$(QN_PROG): node/bootstrap.js node/node-globals.js node/node/* node/node/*/* node/repl.js qx/index.js qx/core.js $(QJSXC_PROG) $(NATIVE_OBJS) $(BEARSSL_LIB) $(BIN_DIR)/obj/qn/version-info.js quickjs-deps | $(BIN_DIR)
	NODE_PATH=./node:./qx:$(BIN_DIR)/obj $(QJSXC_PROG) -e -M sqlite_native,sqlite -M qn_native,qn_native -M qn_socket,qn_socket -M qn_tls,qn_tls -M qn_uv_fs,qn_uv_fs -M qn_uv_dns,qn_uv_dns -M qn_uv_signals,qn_uv_signals -M qn_uv_stream,qn_uv_stream -M qn_uv_process,qn_uv_process -M qn_vm,qn_vm -D node-globals -D repl -D node:fs -D node:process -D node:child_process -D node:crypto -D node:path -D node:events -D node:stream -D node:stream/promises -D node:fs/promises -D node:buffer -D node:url -D node:abort -D node:fetch -D node:fetch/Headers -D node:fetch/Response -D node:net -D node:tls -D node:http -D node:http/parse -D node:sqlite -D node:util -D node:assert -D node:test -D node:os -D qn:introspect -D qn:http -D qn:version-info -D qx -o $(BIN_DIR)/obj/qn.c node/bootstrap.js
	$(CC) $(CFLAGS_OPT) $(LDFLAGS) -I. -I$(BIN_DIR) -o $@ $(BIN_DIR)/obj/qn.c $(NATIVE_OBJS) $(BEARSSL_LIB) $(BIN_DIR)/libquickjs.a $(LIBUV_LIB) $(LIBS)

# Build qx (zx-compatible shell scripting with $ function)
$(QX_PROG): qx/bootstrap.js node/node-globals.js qx/* node/node/* node/node/*/* node/repl.js $(QJSXC_PROG) $(NATIVE_OBJS) $(BEARSSL_LIB) $(BIN_DIR)/obj/qn/version-info.js quickjs-deps | $(BIN_DIR)
	NODE_PATH=./node:./qx:$(BIN_DIR)/obj $(QJSXC_PROG) -e -M sqlite_native,sqlite -M qn_native,qn_native -M qn_socket,qn_socket -M qn_tls,qn_tls -M qn_uv_fs,qn_uv_fs -M qn_uv_dns,qn_uv_dns -M qn_uv_signals,qn_uv_signals -M qn_uv_stream,qn_uv_stream -M qn_uv_process,qn_uv_process -M qn_vm,qn_vm -D node-globals -D repl -D node:fs -D node:process -D node:child_process -D node:crypto -D node:path -D node:events -D node:stream -D node:stream/promises -D node:fs/promises -D node:buffer -D node:url -D node:abort -D node:fetch -D node:fetch/Headers -D node:fetch/Response -D node:net -D node:tls -D node:http -D node:http/parse -D node:sqlite -D node:util -D node:assert -D node:test -D node:os -D qn:introspect -D qn:http -D qn:version-info -D qx -o $(BIN_DIR)/obj/qx.c qx/bootstrap.js
	$(CC) $(CFLAGS_OPT) $(LDFLAGS) -I. -I$(BIN_DIR) -o $@ $(BIN_DIR)/obj/qx.c $(NATIVE_OBJS) $(BEARSSL_LIB) $(BIN_DIR)/libquickjs.a $(LIBUV_LIB) $(LIBS)

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
	@$(MAKE) -s -C $(BIN_DIR)/quickjs .obj/quickjs.o .obj/libregexp.o .obj/libunicode.o .obj/cutils.o .obj/dtoa.o .obj/repl.o libquickjs.a

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
	@echo "  NODE_PATH=./my_modules ./bin/qjsx script.js"
	@echo "  NODE_PATH=./my_modules ./bin/qjsxc -o app.c app.js"
	@echo "  ./bin/qx script.js    # zx-compatible shell scripting"

.PHONY: all build clean clean-all install help quickjs-deps convenience-links test FORCE
FORCE:

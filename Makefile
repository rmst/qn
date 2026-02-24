#
# Qn Makefile
#
# Builds qn, qx, and qnc executables
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
LIBS += -lrt -lutil
endif

# Build directories (can be overridden: make BIN_DIR=/tmp/build)
BIN_DIR ?= bin/$(PLATFORM)

# libuv static library path (must be defined before rules that reference it)
LIBUV_LIB := $(BIN_DIR)/libuv.a
LIBUV_DIR := vendor/libuv
LIBUV_CFLAGS := -Ivendor/libuv/include -Ivendor/libuv/src

# libuv source files (core + unix platform-specific)
LIBUV_SRCS = src/fs-poll.c src/idna.c src/inet.c src/random.c src/strscpy.c \
             src/strtok.c src/thread-common.c src/threadpool.c src/timer.c \
             src/uv-common.c src/uv-data-getter-setters.c src/version.c \
             src/unix/async.c src/unix/core.c src/unix/dl.c src/unix/fs.c \
             src/unix/getaddrinfo.c src/unix/getnameinfo.c src/unix/loop.c \
             src/unix/loop-watcher.c src/unix/pipe.c src/unix/poll.c \
             src/unix/process.c src/unix/proctitle.c \
             src/unix/random-devurandom.c \
             src/unix/signal.c src/unix/stream.c src/unix/tcp.c \
             src/unix/thread.c src/unix/tty.c src/unix/udp.c

# Platform-specific libuv sources
ifeq ($(PLATFORM),darwin)
LIBUV_SRCS += src/unix/bsd-ifaddrs.c src/unix/kqueue.c \
              src/unix/random-getentropy.c \
              src/unix/darwin-proctitle.c src/unix/darwin.c src/unix/fsevents.c
LIBUV_CFLAGS += -D_DARWIN_UNLIMITED_SELECT=1 -D_DARWIN_USE_64_BIT_INODE=1
else
LIBUV_SRCS += src/unix/linux.c src/unix/procfs-exepath.c \
              src/unix/random-getrandom.c src/unix/random-sysctl-linux.c \
              src/unix/sysinfo-loadavg.c src/unix/sysinfo-memory.c \
              src/unix/posix-hrtime.c src/unix/no-proctitle.c
endif

# Program names
QN_PROG = $(BIN_DIR)/qn
QX_PROG = $(BIN_DIR)/qx
QNC_PROG = $(BIN_DIR)/qnc

# QuickJS object files (from our copied and built QuickJS)
# Note: use our patched quickjs-libc.o to extend import.meta
QUICKJS_OBJS = $(BIN_DIR)/quickjs/.obj/quickjs.o $(BIN_DIR)/quickjs/.obj/libregexp.o \
               $(BIN_DIR)/quickjs/.obj/libunicode.o $(BIN_DIR)/quickjs/.obj/cutils.o \
               $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/quickjs/.obj/dtoa.o \
               $(BIN_DIR)/quickjs/.obj/repl.o $(BIN_DIR)/obj/sandboxed-worker.o \
               $(BIN_DIR)/obj/introspect.o

# Convenience symlinks
QN_LINK = bin/qn
QX_LINK = bin/qx
QNC_LINK = bin/qnc

# Default target
all: quickjs-deps $(QN_PROG) $(QX_PROG) $(QNC_PROG) convenience-links

# Create directories
$(BIN_DIR):
	mkdir -p $(BIN_DIR)

$(BIN_DIR)/obj:
	mkdir -p $(BIN_DIR)/obj

# Build libuv static library from source (no cmake needed)
$(LIBUV_LIB): $(addprefix $(LIBUV_DIR)/,$(LIBUV_SRCS)) | $(BIN_DIR)
	@echo "Building libuv..."
	@rm -rf $(BIN_DIR)/obj/libuv
	@mkdir -p $(BIN_DIR)/obj/libuv
	@set -e; for f in $(LIBUV_SRCS); do \
		oname=$$(echo $$f | tr '/' '_' | sed 's/\.c$$/.o/'); \
		$(CC) $(CFLAGS_OPT) $(LIBUV_CFLAGS) -c -o $(BIN_DIR)/obj/libuv/$$oname $(LIBUV_DIR)/$$f; \
	done
	@ar rcs $@ $(BIN_DIR)/obj/libuv/*.o

# Build qnc executable (compiler)
# After linking, copy support files next to it (for local builds) and embed them
# into the binary (for standalone distribution).
QNC_PACK = $(BIN_DIR)/qnc-pack
$(QNC_PROG): $(BIN_DIR)/obj/qnc.o $(BIN_DIR)/obj/qnc-embed.o $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/obj/sandboxed-worker.o $(BIN_DIR)/obj/introspect.o $(BIN_DIR)/obj/qn-vm.o $(BIN_DIR)/obj/qn-uv-utils.o $(BIN_DIR)/obj/qn-worker.o quickjs-deps $(LIBUV_LIB) $(QNC_PACK) | $(BIN_DIR)
	$(CC) $(LDFLAGS) -o $@ $(BIN_DIR)/obj/qnc.o $(BIN_DIR)/obj/qnc-embed.o $(BIN_DIR)/obj/qn-worker.o $(BIN_DIR)/obj/qn-vm.o $(BIN_DIR)/obj/qn-uv-utils.o $(QUICKJS_OBJS) $(LIBUV_LIB) $(LIBS)
	chmod +x $@
	cp $(BIN_DIR)/quickjs/*.h $(BIN_DIR)/
	mkdir -p $(BIN_DIR)/module_resolution
	cp module_resolution/module-resolution.h $(BIN_DIR)/module_resolution/
	cp exit-handler.h $(BIN_DIR)/
	mkdir -p $(BIN_DIR)/libuv
	cp libuv/qn-vm.h $(BIN_DIR)/libuv/
	cp libuv/qn-worker.h $(BIN_DIR)/libuv/
	cp $(BIN_DIR)/quickjs/libquickjs.a $(BIN_DIR)/
	# Replace unpatched quickjs-libc.o with patched version in libquickjs.a
	# Also add sandboxed-worker.o, introspect.o, qn-vm.o, qn-uv-utils.o which are required
	ar d $(BIN_DIR)/libquickjs.a quickjs-libc.nolto.o 2>/dev/null || true
	ar r $(BIN_DIR)/libquickjs.a $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/obj/sandboxed-worker.o $(BIN_DIR)/obj/introspect.o $(BIN_DIR)/obj/qn-vm.o $(BIN_DIR)/obj/qn-uv-utils.o $(BIN_DIR)/obj/qn-worker.o
	# libuv.a is already in $(BIN_DIR) via $(LIBUV_LIB)
	# Embed support files into the qnc binary for standalone use.
	# Headers are embedded at both top level (for generated C includes)
	# and quickjs/ subdirectory (for module-resolution.h includes).
	$(QNC_PACK) $@ \
		quickjs.h:$(BIN_DIR)/quickjs/quickjs.h \
		quickjs-libc.h:$(BIN_DIR)/quickjs/quickjs-libc.h \
		cutils.h:$(BIN_DIR)/quickjs/cutils.h \
		list.h:$(BIN_DIR)/quickjs/list.h \
		quickjs/quickjs.h:$(BIN_DIR)/quickjs/quickjs.h \
		quickjs/quickjs-libc.h:$(BIN_DIR)/quickjs/quickjs-libc.h \
		quickjs/cutils.h:$(BIN_DIR)/quickjs/cutils.h \
		quickjs/list.h:$(BIN_DIR)/quickjs/list.h \
		module_resolution/module-resolution.h:module_resolution/module-resolution.h \
		exit-handler.h:exit-handler.h \
		libuv/qn-vm.h:libuv/qn-vm.h \
		libuv/qn-worker.h:libuv/qn-worker.h \
		libquickjs.a:$(BIN_DIR)/libquickjs.a \
		libuv.a:$(LIBUV_LIB)

# Build qnc.o from standalone source
$(BIN_DIR)/obj/qnc.o: qnc/main.c qnc/embed.h module_resolution/module-resolution.h quickjs-deps | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -DCONFIG_CC=\"$(CC)\" -DCONFIG_PREFIX=\"/usr/local\" -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

# Build qnc embed extraction module
$(BIN_DIR)/obj/qnc-embed.o: qnc/embed.c qnc/embed.h | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -c -o $@ $<

# Build qnc-pack tool (used at build time to embed support files)
$(QNC_PACK): qnc/pack.c qnc/embed.h | $(BIN_DIR)
	$(CC) $(CFLAGS_OPT) -I. -o $@ $<

# Patch and build quickjs-libc (adds import.meta.dirname, sandbox support, introspection)
$(BIN_DIR)/obj/quickjs-libc.c: quickjs/quickjs-libc.c quickjs-libc.patch introspect/introspect.patch | $(BIN_DIR)/obj
	patch -p0 < quickjs-libc.patch -o $@ quickjs/quickjs-libc.c
	patch -p0 < introspect/introspect.patch $@

$(BIN_DIR)/obj/quickjs-libc.o: $(BIN_DIR)/obj/quickjs-libc.c $(LIBUV_LIB) | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

# Build introspect module (depends on quickjs-deps for patched quickjs.h with JS_GetClosureVars)
$(BIN_DIR)/obj/introspect.o: introspect/introspect.c introspect/introspect.h quickjs-deps | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Build sandbox module (compiles to empty if USE_SANDBOX is not defined)
$(BIN_DIR)/obj/sandboxed-worker.o: sandboxed-worker/sandboxed-worker.c sandboxed-worker/sandboxed-worker.h quickjs-deps | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# SQLite is now built automatically by qnc via package.json "qnc" field in node/node/sqlite/

# TLS (qn_tls + BearSSL) is now built automatically by qnc via package.json "qnc" field in node/node/tls/

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

# Build qn-uv-dgram (UDP datagram sockets via libuv)
$(BIN_DIR)/obj/qn-uv-dgram.o: libuv/qn-uv-dgram.c libuv/qn-uv-dgram.h libuv/qn-uv-utils.h quickjs-deps $(LIBUV_LIB) | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

# Build qn-uv-process (child process spawning via libuv)
$(BIN_DIR)/obj/qn-uv-process.o: libuv/qn-uv-process.c libuv/qn-uv-stream.h libuv/qn-uv-utils.h quickjs-deps $(LIBUV_LIB) | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

# Build qn-uv-pty (pseudo-terminal support via forkpty + libuv)
$(BIN_DIR)/obj/qn-uv-pty.o: libuv/qn-uv-pty.c libuv/qn-uv-utils.h libuv/qn-vm.h quickjs-deps $(LIBUV_LIB) | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

# Build qn-vm (event loop ownership: timers, poll, uv_run)
$(BIN_DIR)/obj/qn-vm.o: libuv/qn-vm.c libuv/qn-vm.h libuv/qn-uv-utils.h quickjs-deps $(LIBUV_LIB) | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

# Build qn-worker (Web Worker API via libuv threads + socketpair)
$(BIN_DIR)/obj/qn-worker.o: libuv/qn-worker.c libuv/qn-worker.h libuv/qn-vm.h libuv/qn-uv-utils.h quickjs-deps $(LIBUV_LIB) | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -Ivendor/libuv/include -c -o $@ $<

# Native C extensions for linking (sqlite is now auto-embedded via binding.gyp)
NATIVE_OBJS = $(BIN_DIR)/obj/qn-uv-utils.o $(BIN_DIR)/obj/qn-uv-fs.o $(BIN_DIR)/obj/qn-uv-dns.o $(BIN_DIR)/obj/qn-uv-signals.o $(BIN_DIR)/obj/qn-uv-stream.o $(BIN_DIR)/obj/qn-uv-dgram.o $(BIN_DIR)/obj/qn-uv-process.o $(BIN_DIR)/obj/qn-uv-pty.o $(BIN_DIR)/obj/qn-vm.o $(BIN_DIR)/obj/qn-worker.o
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

# Common qnc flags for building qn/qx
QNC_FLAGS = -M qn_uv_fs,qn_uv_fs -M qn_uv_dns,qn_uv_dns \
            -M qn_uv_signals,qn_uv_signals -M qn_uv_stream,qn_uv_stream \
            -M qn_uv_dgram,qn_uv_dgram -M qn_uv_process,qn_uv_process \
            -M qn_uv_pty,qn_uv_pty -M qn_vm,qn_vm \
            -M qn_worker,qn_worker
QNC_MODULES = -D node-globals -D repl -D node:fs -D node:process \
              -D node:child_process -D node:crypto -D node:path -D node:events \
              -D node:stream -D node:stream/promises -D node:fs/promises \
              -D node:buffer -D node:url -D node:abort -D node:fetch \
              -D node:fetch/Headers -D node:fetch/Response -D node:dgram \
              -D node:net -D node:tls -D node:http -D node:http/parse \
              -D node:sqlite -D node:util -D node:assert -D node:test \
              -D node:os -D qn:introspect -D qn:http -D qn:pty -D qn:version-info \
              -D qn:sucrase -D qn:worker -D node:module -D qx
# Extra .o/.a files to pass through to the linker (non-packaged native modules)
QNC_EXTRA_LINK = $(patsubst %,--link %,$(NATIVE_OBJS))

# Build qn (standalone executable with embedded node modules, qx, sqlite, and native extensions)
# SQLite and TLS are auto-embedded via package.json "qnc" field; other native modules still use -M + --link
$(QN_PROG): node/bootstrap.js node/node-globals.js node/node/* node/node/*/* node/repl.js qx/index.js qx/core.js vendor/ws/*.js $(QNC_PROG) $(NATIVE_OBJS) $(BIN_DIR)/obj/qn/version-info.js quickjs-deps | $(BIN_DIR)
	NODE_PATH=./node:./qx:./vendor:$(BIN_DIR)/obj $(QNC_PROG) $(QNC_FLAGS) $(QNC_MODULES) -D ws $(QNC_EXTRA_LINK) -o $@ node/bootstrap.js

# Build qx (zx-compatible shell scripting with $ function)
$(QX_PROG): qx/bootstrap.js node/node-globals.js qx/* node/node/* node/node/*/* node/repl.js vendor/ws/*.js $(QNC_PROG) $(NATIVE_OBJS) $(BIN_DIR)/obj/qn/version-info.js quickjs-deps | $(BIN_DIR)
	NODE_PATH=./node:./qx:./vendor:$(BIN_DIR)/obj $(QNC_PROG) $(QNC_FLAGS) $(QNC_MODULES) -D ws $(QNC_EXTRA_LINK) -o $@ qx/bootstrap.js

# Create convenience symlinks in bin/ directory
convenience-links: $(QN_PROG) $(QX_PROG) $(QNC_PROG)
	@mkdir -p bin
	@ln -sf $(PLATFORM)/qn $(QN_LINK)
	@ln -sf $(PLATFORM)/qx $(QX_LINK)
	@ln -sf $(PLATFORM)/qnc $(QNC_LINK)

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
$(BIN_DIR)/obj/qnc.o $(BIN_DIR)/obj/quickjs-libc.o: quickjs-deps

# Clean build artifacts
clean:
	rm -rf $(BIN_DIR)

# Clean all platforms
clean-all:
	rm -rf bin/

# Build everything (QuickJS + qn)
build: quickjs-deps all

# Install qn, qx, and qnc
install: $(QN_PROG) $(QX_PROG) $(QNC_PROG)
	mkdir -p "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QN_PROG) "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QX_PROG) "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QNC_PROG) "$(DESTDIR)$(PREFIX)/bin"

# Test target
test:
	jix run -f test

test2:
	jix run -f test containerized


# Help target
help:
	@echo "Qn Makefile targets:"
	@echo "  all         - Build qn, qx, and qnc executables"
	@echo "  build       - Build QuickJS dependencies and all programs"
	@echo "  test        - Build and run tests"
	@echo "  clean       - Clean build artifacts"
	@echo "  clean-all   - Clean everything including QuickJS"
	@echo "  install     - Install all programs to \$$(PREFIX)/bin"
	@echo ""
	@echo "Usage examples:"
	@echo "  make build"
	@echo "  make test"
	@echo "  ./bin/qn script.js     # Node.js-compatible runtime"
	@echo "  ./bin/qx script.js     # zx-compatible shell scripting"
	@echo "  NODE_PATH=./my_modules ./bin/qnc -o app.c app.js"

.PHONY: all build clean clean-all install help quickjs-deps convenience-links test FORCE
FORCE:

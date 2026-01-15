#
# QJSX Makefile
#
# Builds the qjsx executable with QJSXPATH module resolution support
#

VERSION = 2024-01-13

# Compiler settings (mirroring QuickJS defaults)
CC = gcc
CFLAGS = -g -Wall -Wno-array-bounds -Wno-format-truncation -fwrapv \
         -D_GNU_SOURCE -DCONFIG_VERSION='"$(VERSION)"' -DCONFIG_BIGNUM

# Sandbox support (comment out to disable if upstream QuickJS breaks compatibility)
CFLAGS += -DUSE_SANDBOX

CFLAGS_OPT = $(CFLAGS) -O2
LDFLAGS = -g -rdynamic
LIBS = -lm -ldl -lpthread

# Build directories (can be overridden: make BIN_DIR=/tmp/build)
PLATFORM := $(shell uname -s | tr '[:upper:]' '[:lower:]')
BIN_DIR ?= bin/$(PLATFORM)

# Program names
QJSX_PROG = $(BIN_DIR)/qjsx
QJSX_NODE_PROG = $(BIN_DIR)/qjsx-node
QJSXC_PROG = $(BIN_DIR)/qjsxc

# QuickJS object files (from our copied and built QuickJS)
# Note: use our patched quickjs-libc.o to extend import.meta
QUICKJS_OBJS = $(BIN_DIR)/quickjs/.obj/quickjs.o $(BIN_DIR)/quickjs/.obj/libregexp.o \
               $(BIN_DIR)/quickjs/.obj/libunicode.o $(BIN_DIR)/quickjs/.obj/cutils.o \
               $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/quickjs/.obj/dtoa.o \
               $(BIN_DIR)/quickjs/.obj/repl.o $(BIN_DIR)/obj/sandboxed-worker.o

# Convenience symlinks
QJSX_LINK = bin/qjsx
QJSX_NODE_LINK = bin/qjsx-node
QJSXC_LINK = bin/qjsxc

# Default target
all: quickjs-deps $(QJSX_PROG) $(QJSX_NODE_PROG) $(QJSXC_PROG) convenience-links

# Create directories
$(BIN_DIR):
	mkdir -p $(BIN_DIR)

$(BIN_DIR)/obj:
	mkdir -p $(BIN_DIR)/obj

# Build qjsx executable
$(QJSX_PROG): $(BIN_DIR)/obj/qjsx.o $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/obj/sandboxed-worker.o quickjs-deps | $(BIN_DIR)
	$(CC) $(LDFLAGS) -o $@ $(BIN_DIR)/obj/qjsx.o $(QUICKJS_OBJS) $(LIBS)
	chmod +x $@

# Generate qjsx.c from quickjs/qjs.c by applying the patch
$(BIN_DIR)/obj/qjsx.c: quickjs/qjs.c qjsx.patch qjsx-module-resolution.h | $(BIN_DIR)/obj
	patch -p0 < qjsx.patch -o $@ quickjs/qjs.c

# Build qjsx.o from the patched source
$(BIN_DIR)/obj/qjsx.o: $(BIN_DIR)/obj/qjsx.c qjsx-module-resolution.h | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Build qjsxc executable
$(QJSXC_PROG): $(BIN_DIR)/obj/qjsxc.o $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/obj/sandboxed-worker.o quickjs-deps | $(BIN_DIR)
	$(CC) $(LDFLAGS) -o $@ $(BIN_DIR)/obj/qjsxc.o $(QUICKJS_OBJS) $(LIBS)
	chmod +x $@
	cp $(BIN_DIR)/quickjs/*.h $(BIN_DIR)/
	cp $(BIN_DIR)/quickjs/libquickjs.a $(BIN_DIR)/

# Generate embedded header from qjsx-module-resolution.h
qjsx-module-resolution-embedded.h: qjsx-module-resolution.h embed-header.sh
	./embed-header.sh

# Generate qjsxc.c from quickjs/qjsc.c by applying the patch
$(BIN_DIR)/obj/qjsxc.c: quickjs/qjsc.c qjsxc.patch qjsx-module-resolution.h qjsx-module-resolution-embedded.h | $(BIN_DIR)/obj
	patch -p0 < qjsxc.patch -o $@ quickjs/qjsc.c

# Build qjsxc.o from the patched source
$(BIN_DIR)/obj/qjsxc.o: $(BIN_DIR)/obj/qjsxc.c qjsx-module-resolution.h | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -DCONFIG_CC=\"$(CC)\" -DCONFIG_PREFIX=\"/usr/local\" -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Patch and build quickjs-libc (adds import.meta.dirname and sandbox support)
$(BIN_DIR)/obj/quickjs-libc.c: quickjs/quickjs-libc.c quickjs-libc.patch sandboxed-worker/sandboxed-worker.patch | $(BIN_DIR)/obj
	patch -p0 < quickjs-libc.patch -o $@ quickjs/quickjs-libc.c
	patch -p0 < sandboxed-worker/sandboxed-worker.patch $@

$(BIN_DIR)/obj/quickjs-libc.o: $(BIN_DIR)/obj/quickjs-libc.c | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Build sandbox module (compiles to empty if USE_SANDBOX is not defined)
$(BIN_DIR)/obj/sandboxed-worker.o: sandboxed-worker/sandboxed-worker.c sandboxed-worker/sandboxed-worker.h | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Build qjsx-node (standalone executable with embedded node modules)
$(QJSX_NODE_PROG): qjsx-node-bootstrap.js qjsx-node/node/* $(QJSXC_PROG) quickjs-deps | $(BIN_DIR)
	QJSXPATH=./qjsx-node $(QJSXC_PROG) -D node:fs -D node:process -D node:child_process -D node:crypto -D node:path -D node:events -D node:stream -o $@ qjsx-node-bootstrap.js

# Create convenience symlinks in bin/ directory
convenience-links: $(QJSX_PROG) $(QJSX_NODE_PROG) $(QJSXC_PROG)
	@mkdir -p bin
	@ln -sf $(PLATFORM)/qjsx $(QJSX_LINK)
	@ln -sf $(PLATFORM)/qjsx-node $(QJSX_NODE_LINK)
	@ln -sf $(PLATFORM)/qjsxc $(QJSXC_LINK)

# Build QuickJS by copying it to our bin dir and building it there
quickjs-deps: | $(BIN_DIR)
	@if [ ! -d "$(BIN_DIR)/quickjs" ]; then \
		echo "Copying QuickJS to $(BIN_DIR)/quickjs..."; \
		cp -r quickjs $(BIN_DIR)/quickjs; \
	fi
	$(MAKE) -C $(BIN_DIR)/quickjs .obj/quickjs.o .obj/libregexp.o .obj/libunicode.o .obj/cutils.o .obj/dtoa.o .obj/repl.o libquickjs.a

# Clean build artifacts
clean:
	rm -rf $(BIN_DIR)

# Clean all platforms
clean-all:
	rm -rf bin/

# Build everything (QuickJS + qjsx)
build: quickjs-deps all

# Install qjsx, qjsx-node, and qjsxc
install: $(QJSX_PROG) $(QJSX_NODE_PROG) $(QJSXC_PROG)
	mkdir -p "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QJSX_PROG) "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QJSX_NODE_PROG) "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QJSXC_PROG) "$(DESTDIR)$(PREFIX)/bin"

# Test target
test: build
	jix run -f test/__jix__.js

# Help target
help:
	@echo "QJSX Makefile targets:"
	@echo "  all         - Build qjsx, qjsx-node, and qjsxc executables"
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

.PHONY: all build clean clean-all install help quickjs-deps convenience-links test

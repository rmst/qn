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
QNODE_PROG = $(BIN_DIR)/qnode
QX_PROG = $(BIN_DIR)/qx
QJSXC_PROG = $(BIN_DIR)/qjsxc

# QuickJS object files (from our copied and built QuickJS)
# Note: use our patched quickjs-libc.o to extend import.meta
QUICKJS_OBJS = $(BIN_DIR)/quickjs/.obj/quickjs.o $(BIN_DIR)/quickjs/.obj/libregexp.o \
               $(BIN_DIR)/quickjs/.obj/libunicode.o $(BIN_DIR)/quickjs/.obj/cutils.o \
               $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/quickjs/.obj/dtoa.o \
               $(BIN_DIR)/quickjs/.obj/repl.o $(BIN_DIR)/obj/sandboxed-worker.o

# Convenience symlinks
QJSX_LINK = bin/qjsx
QNODE_LINK = bin/qnode
QX_LINK = bin/qx
QJSXC_LINK = bin/qjsxc

# Default target
all: quickjs-deps $(QJSX_PROG) $(QNODE_PROG) $(QX_PROG) $(QJSXC_PROG) convenience-links

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
	cp qjsx-module-resolution.h $(BIN_DIR)/
	cp $(BIN_DIR)/quickjs/libquickjs.a $(BIN_DIR)/
	# Replace unpatched quickjs-libc.o with patched version in libquickjs.a
	# Also add sandboxed-worker.o which is required by the patched quickjs-libc
	ar d $(BIN_DIR)/libquickjs.a quickjs-libc.nolto.o 2>/dev/null || true
	ar r $(BIN_DIR)/libquickjs.a $(BIN_DIR)/obj/quickjs-libc.o $(BIN_DIR)/obj/sandboxed-worker.o

# Generate qjsxc.c from quickjs/qjsc.c by applying the patch
$(BIN_DIR)/obj/qjsxc.c: quickjs/qjsc.c qjsxc.patch qjsx-module-resolution.h | $(BIN_DIR)/obj
	patch -p0 < qjsxc.patch -o $@ quickjs/qjsc.c

# Build qjsxc.o from the patched source
$(BIN_DIR)/obj/qjsxc.o: $(BIN_DIR)/obj/qjsxc.c qjsx-module-resolution.h | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -DCONFIG_CC=\"$(CC)\" -DCONFIG_PREFIX=\"/usr/local\" -I. -I$(BIN_DIR)/obj -I$(BIN_DIR)/quickjs -c -o $@ $<

# Patch and build quickjs-libc (adds import.meta.dirname and sandbox support)
$(BIN_DIR)/obj/quickjs-libc.c: quickjs/quickjs-libc.c quickjs-libc.patch sandboxed-worker/sandboxed-worker.patch | $(BIN_DIR)/obj
	patch -p0 < quickjs-libc.patch -o $@ quickjs/quickjs-libc.c
	patch -p0 < sandboxed-worker/sandboxed-worker.patch $@

$(BIN_DIR)/obj/quickjs-libc.o: $(BIN_DIR)/obj/quickjs-libc.c | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Build sandbox module (compiles to empty if USE_SANDBOX is not defined)
$(BIN_DIR)/obj/sandboxed-worker.o: sandboxed-worker/sandboxed-worker.c sandboxed-worker/sandboxed-worker.h | $(BIN_DIR)/obj
	$(CC) $(CFLAGS_OPT) -I. -I$(BIN_DIR)/quickjs -c -o $@ $<

# Build qnode (standalone executable with embedded node modules and qx)
$(QNODE_PROG): qnode/bootstrap.js qnode/node/* qnode/repl.js qx/index.js qx/core.js $(QJSXC_PROG) quickjs-deps | $(BIN_DIR)
	QJSXPATH=./qnode:./qx $(QJSXC_PROG) -D repl -D node:fs -D node:process -D node:child_process -D node:crypto -D node:path -D node:events -D node:stream -D node:buffer -D qx -o $@ qnode/bootstrap.js

# Build qx (zx-compatible shell scripting with $ function)
$(QX_PROG): qx/bootstrap.js qx/* qnode/node/* qnode/repl.js $(QJSXC_PROG) quickjs-deps | $(BIN_DIR)
	QJSXPATH=./qnode:./qx $(QJSXC_PROG) -D repl -D node:fs -D node:process -D node:child_process -D node:crypto -D node:path -D node:events -D node:stream -D node:buffer -D qx/core -o $@ qx/bootstrap.js

# Create convenience symlinks in bin/ directory
convenience-links: $(QJSX_PROG) $(QNODE_PROG) $(QX_PROG) $(QJSXC_PROG)
	@mkdir -p bin
	@ln -sf $(PLATFORM)/qjsx $(QJSX_LINK)
	@ln -sf $(PLATFORM)/qnode $(QNODE_LINK)
	@ln -sf $(PLATFORM)/qx $(QX_LINK)
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

# Install qjsx, qnode, qx, and qjsxc
install: $(QJSX_PROG) $(QNODE_PROG) $(QX_PROG) $(QJSXC_PROG)
	mkdir -p "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QJSX_PROG) "$(DESTDIR)$(PREFIX)/bin"
	install -m755 $(QNODE_PROG) "$(DESTDIR)$(PREFIX)/bin"
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
	@echo "  all         - Build qjsx, qnode, qx, and qjsxc executables"
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

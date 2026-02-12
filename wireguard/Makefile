# wireguard/Makefile - builds libwireguard.a (lwIP + wireguard-lwip + glue + bindings)
#
# Usage from parent: $(MAKE) -C wireguard QUICKJS_INC=... BIN_DIR=...

QUICKJS_INC ?= ../bin/linux/quickjs
BIN_DIR ?= build

LWIP_INC = -I. -I../vendor/lwip/src/include
WG_INC = $(LWIP_INC) -I../vendor/wireguard-lwip/src
WG_DEFINES = -DWIREGUARD_MAX_PEERS=64 -DWIREGUARD_MAX_SRC_IPS=4

CC ?= gcc

# lwIP core
LWIP_CORE_SRCS = $(wildcard ../vendor/lwip/src/core/*.c) $(wildcard ../vendor/lwip/src/core/ipv4/*.c)
LWIP_CORE_OBJS = $(patsubst ../vendor/lwip/src/%.c,$(BIN_DIR)/lwip/%.o,$(LWIP_CORE_SRCS))

$(BIN_DIR)/lwip/%.o: ../vendor/lwip/src/%.c
	@mkdir -p $(dir $@)
	$(CC) -O2 -w $(LWIP_INC) -c -o $@ $<

# wireguard-lwip (crypto + protocol, excluding wireguardif.c)
WG_VENDOR_SRCS = ../vendor/wireguard-lwip/src/wireguard.c \
                 ../vendor/wireguard-lwip/src/crypto.c \
                 $(wildcard ../vendor/wireguard-lwip/src/crypto/refc/*.c)
WG_VENDOR_OBJS = $(patsubst ../vendor/wireguard-lwip/src/%.c,$(BIN_DIR)/wg/%.o,$(WG_VENDOR_SRCS))

$(BIN_DIR)/wg/%.o: ../vendor/wireguard-lwip/src/%.c
	@mkdir -p $(dir $@)
	$(CC) -O2 -w $(WG_INC) $(WG_DEFINES) -c -o $@ $<

# Our glue code
$(BIN_DIR)/wg-platform.o: wireguard-platform.c
	@mkdir -p $(BIN_DIR)
	$(CC) -O2 -w $(WG_INC) $(WG_DEFINES) -c -o $@ $<

$(BIN_DIR)/wg-netif.o: wg-netif.c wg-netif.h
	@mkdir -p $(BIN_DIR)
	$(CC) -O2 -Wall $(WG_INC) $(WG_DEFINES) -c -o $@ $<

# QuickJS bindings
$(BIN_DIR)/qn-wireguard.o: qn-wireguard.c wg-netif.h
	@mkdir -p $(BIN_DIR)
	$(CC) -O2 -Wall -I.. -I$(QUICKJS_INC) $(WG_INC) $(WG_DEFINES) -c -o $@ $<

# All objects -> static library
ALL_OBJS = $(LWIP_CORE_OBJS) $(WG_VENDOR_OBJS) \
           $(BIN_DIR)/wg-platform.o $(BIN_DIR)/wg-netif.o $(BIN_DIR)/qn-wireguard.o

$(BIN_DIR)/libwireguard.a: $(ALL_OBJS)
	ar rcs $@ $^

lib: $(BIN_DIR)/libwireguard.a

clean:
	rm -rf $(BIN_DIR)

.PHONY: lib clean
.DEFAULT_GOAL := lib

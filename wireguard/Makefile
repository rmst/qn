# wireguard/Makefile - builds libwireguard.a (lwIP + wireguard-lwip + glue + bindings)
#
# Usage from parent: $(MAKE) -C wireguard QUICKJS_INC=... BUILD=...

QUICKJS_INC ?= ../bin/linux/quickjs
BUILD ?= build

LWIP_INC = -I. -I../vendor/lwip/src/include
WG_INC = $(LWIP_INC) -I../vendor/wireguard-lwip/src
WG_DEFINES = -DWIREGUARD_MAX_PEERS=64 -DWIREGUARD_MAX_SRC_IPS=4

CC ?= gcc

# lwIP core
LWIP_CORE_SRCS = $(wildcard ../vendor/lwip/src/core/*.c) $(wildcard ../vendor/lwip/src/core/ipv4/*.c)
LWIP_CORE_OBJS = $(patsubst ../vendor/lwip/src/%.c,$(BUILD)/lwip/%.o,$(LWIP_CORE_SRCS))

$(BUILD)/lwip/%.o: ../vendor/lwip/src/%.c
	@mkdir -p $(dir $@)
	$(CC) -O2 -w $(LWIP_INC) -c -o $@ $<

# wireguard-lwip (crypto + protocol, excluding wireguardif.c)
WG_VENDOR_SRCS = ../vendor/wireguard-lwip/src/wireguard.c \
                 ../vendor/wireguard-lwip/src/crypto.c \
                 $(wildcard ../vendor/wireguard-lwip/src/crypto/refc/*.c)
WG_VENDOR_OBJS = $(patsubst ../vendor/wireguard-lwip/src/%.c,$(BUILD)/wg/%.o,$(WG_VENDOR_SRCS))

$(BUILD)/wg/%.o: ../vendor/wireguard-lwip/src/%.c
	@mkdir -p $(dir $@)
	$(CC) -O2 -w $(WG_INC) $(WG_DEFINES) -c -o $@ $<

# Our glue code
$(BUILD)/wg-platform.o: wireguard-platform.c
	@mkdir -p $(BUILD)
	$(CC) -O2 -w $(WG_INC) $(WG_DEFINES) -c -o $@ $<

$(BUILD)/wg-netif.o: wg-netif.c wg-netif.h
	@mkdir -p $(BUILD)
	$(CC) -O2 -Wall $(WG_INC) $(WG_DEFINES) -c -o $@ $<

# QuickJS bindings
$(BUILD)/qn-wireguard.o: qn-wireguard.c wg-netif.h
	@mkdir -p $(BUILD)
	$(CC) -O2 -Wall -I.. -I$(QUICKJS_INC) $(WG_INC) $(WG_DEFINES) -c -o $@ $<

# All objects -> static library
ALL_OBJS = $(LWIP_CORE_OBJS) $(WG_VENDOR_OBJS) \
           $(BUILD)/wg-platform.o $(BUILD)/wg-netif.o $(BUILD)/qn-wireguard.o

$(BUILD)/libwireguard.a: $(ALL_OBJS)
	ar rcs $@ $^

lib: $(BUILD)/libwireguard.a

clean:
	rm -rf $(BUILD)

.PHONY: lib clean
.DEFAULT_GOAL := lib

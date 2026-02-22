/*
 * qnc-pack — Append support files to a qnc binary
 *
 * Usage: qnc-pack <binary> <name1:file1> [name2:file2] ...
 *
 * Appends files to the binary with an index footer so qnc can
 * extract them at runtime. Each argument is name:path where name
 * is the relative path in the extract directory (e.g. "quickjs.h",
 * "module_resolution/module-resolution.h", "libquickjs.a").
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "embed.h"

static void write_u16(FILE *f, uint16_t v) {
	uint8_t b[2] = { v & 0xff, (v >> 8) & 0xff };
	fwrite(b, 1, 2, f);
}

static void write_u32(FILE *f, uint32_t v) {
	uint8_t b[4] = { v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff };
	fwrite(b, 1, 4, f);
}

static void write_u64(FILE *f, uint64_t v) {
	write_u32(f, (uint32_t)(v & 0xffffffff));
	write_u32(f, (uint32_t)(v >> 32));
}

static long file_size(const char *path) {
	FILE *f = fopen(path, "rb");
	if (!f) return -1;
	fseek(f, 0, SEEK_END);
	long sz = ftell(f);
	fclose(f);
	return sz;
}

static int copy_file(FILE *dst, const char *src_path) {
	FILE *src = fopen(src_path, "rb");
	if (!src) return -1;
	uint8_t buf[65536];
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), src)) > 0)
		fwrite(buf, 1, n, dst);
	fclose(src);
	return 0;
}

int main(int argc, char **argv) {
	if (argc < 3) {
		fprintf(stderr, "usage: qnc-pack <binary> <name:file> ...\n");
		return 1;
	}

	const char *binary = argv[1];
	int nfiles = argc - 2;

	/* Parse name:path pairs */
	const char **names = calloc(nfiles, sizeof(char *));
	const char **paths = calloc(nfiles, sizeof(char *));
	uint32_t *sizes = calloc(nfiles, sizeof(uint32_t));

	for (int i = 0; i < nfiles; i++) {
		char *colon = strchr(argv[i + 2], ':');
		if (!colon) {
			fprintf(stderr, "qnc-pack: bad argument '%s' (expected name:path)\n", argv[i + 2]);
			return 1;
		}
		*colon = '\0';
		names[i] = argv[i + 2];
		paths[i] = colon + 1;
		long sz = file_size(paths[i]);
		if (sz < 0) {
			fprintf(stderr, "qnc-pack: cannot read '%s'\n", paths[i]);
			return 1;
		}
		sizes[i] = (uint32_t)sz;
	}

	/* Open binary for appending */
	FILE *f = fopen(binary, "rb");
	if (!f) {
		fprintf(stderr, "qnc-pack: cannot open '%s'\n", binary);
		return 1;
	}
	fseek(f, 0, SEEK_END);
	uint64_t data_start = (uint64_t)ftell(f);
	fclose(f);

	f = fopen(binary, "ab");
	if (!f) {
		fprintf(stderr, "qnc-pack: cannot append to '%s'\n", binary);
		return 1;
	}

	/* Write file data */
	for (int i = 0; i < nfiles; i++) {
		if (copy_file(f, paths[i]) != 0) {
			fprintf(stderr, "qnc-pack: failed to copy '%s'\n", paths[i]);
			fclose(f);
			return 1;
		}
	}

	/* Write directory */
	long dir_start = ftell(f);
	for (int i = 0; i < nfiles; i++) {
		uint16_t name_len = (uint16_t)strlen(names[i]);
		write_u16(f, name_len);
		fwrite(names[i], 1, name_len, f);
		write_u32(f, sizes[i]);
	}
	uint32_t dir_size = (uint32_t)(ftell(f) - dir_start);

	/* Write footer */
	write_u64(f, data_start);
	write_u32(f, (uint32_t)nfiles);
	write_u32(f, dir_size);
	fwrite(QNC_PACK_MAGIC, 1, QNC_PACK_MAGIC_SIZE, f);

	fclose(f);
	free(names);
	free(paths);
	free(sizes);
	return 0;
}

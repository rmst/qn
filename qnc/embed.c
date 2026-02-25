/*
 * qnc embedded support file extraction
 *
 * Reads the appended archive from the qnc binary itself and extracts
 * all files to a temporary directory for use during compilation.
 */
#include "embed.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <dirent.h>
#include <sys/stat.h>

/*
 * Archive footer (last 24 bytes of file):
 *   uint64_t data_start   — offset where appended data begins (= original binary size)
 *   uint32_t file_count   — number of files in the archive
 *   uint32_t dir_size     — byte size of the directory section
 *   char     magic[8]     — "QNCPAK\0\0"
 *
 * Directory (dir_size bytes, immediately before footer):
 *   For each file:
 *     uint16_t name_len
 *     char     name[name_len]   (relative path, no null terminator)
 *     uint32_t file_size
 *
 * File data (between data_start and directory):
 *   Concatenated file contents in directory order.
 */

/* Read a little-endian uint16 from buf */
static uint16_t read_u16(const uint8_t *p) {
	return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

/* Read a little-endian uint32 from buf */
static uint32_t read_u32(const uint8_t *p) {
	return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
	       ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* Read a little-endian uint64 from buf */
static uint64_t read_u64(const uint8_t *p) {
	return (uint64_t)read_u32(p) | ((uint64_t)read_u32(p + 4) << 32);
}

/* Ensure all directories in path exist (like mkdir -p for the parent) */
static void ensure_parent_dirs(const char *path) {
	char *tmp = strdup(path);
	for (char *p = tmp + 1; *p; p++) {
		if (*p == '/') {
			*p = '\0';
			mkdir(tmp, 0700);
			*p = '/';
		}
	}
	free(tmp);
}

char *qnc_embed_extract(const char *exe_path, const char *target_dir) {
	FILE *f = fopen(exe_path, "rb");
	if (!f) return NULL;

	/* Read footer */
	uint8_t footer[QNC_PACK_FOOTER_SIZE];
	if (fseek(f, -(long)QNC_PACK_FOOTER_SIZE, SEEK_END) != 0) goto fail;
	if (fread(footer, 1, QNC_PACK_FOOTER_SIZE, f) != QNC_PACK_FOOTER_SIZE) goto fail;

	/* Check magic */
	if (memcmp(footer + 16, QNC_PACK_MAGIC, QNC_PACK_MAGIC_SIZE) != 0) goto fail;

	uint64_t data_start = read_u64(footer);
	uint32_t file_count = read_u32(footer + 8);
	uint32_t dir_size = read_u32(footer + 12);

	if (file_count == 0) goto fail;

	/* Read directory */
	long dir_offset = -(long)(QNC_PACK_FOOTER_SIZE + dir_size);
	if (fseek(f, dir_offset, SEEK_END) != 0) goto fail;
	uint8_t *dir = malloc(dir_size);
	if (!dir) goto fail;
	if (fread(dir, 1, dir_size, f) != dir_size) { free(dir); goto fail; }

	/* Create or reuse target directory */
	char *result;
	if (target_dir) {
		ensure_parent_dirs(target_dir);
		mkdir(target_dir, 0700);
		result = strdup(target_dir);
	} else {
		char tmpdir[] = "/tmp/qnc_XXXXXX";
		if (!mkdtemp(tmpdir)) { free(dir); goto fail; }
		result = strdup(tmpdir);
	}

	/* Parse directory and extract files */
	const uint8_t *dp = dir;
	uint64_t file_offset = data_start;

	for (uint32_t i = 0; i < file_count; i++) {
		if (dp + 2 > dir + dir_size) break;
		uint16_t name_len = read_u16(dp); dp += 2;

		if (dp + name_len + 4 > dir + dir_size) break;
		char name[1024];
		if (name_len >= sizeof(name)) break;
		memcpy(name, dp, name_len);
		name[name_len] = '\0';
		dp += name_len;

		uint32_t fsize = read_u32(dp); dp += 4;

		/* Build output path */
		char outpath[2048];
		snprintf(outpath, sizeof(outpath), "%s/%s", result, name);

		/* When using a persistent target dir, skip existing files */
		if (target_dir) {
			struct stat st;
			if (stat(outpath, &st) == 0) {
				file_offset += fsize;
				continue;
			}
		}

		ensure_parent_dirs(outpath);

		/* Read file data and write */
		if (fseek(f, (long)file_offset, SEEK_SET) != 0) break;
		uint8_t *buf = malloc(fsize);
		if (!buf) break;
		if (fread(buf, 1, fsize, f) != fsize) { free(buf); break; }

		FILE *out = fopen(outpath, "wb");
		if (out) {
			fwrite(buf, 1, fsize, out);
			fclose(out);
		}
		free(buf);
		file_offset += fsize;
	}

	free(dir);
	fclose(f);
	return result;

fail:
	fclose(f);
	return NULL;
}

/* Recursively remove a directory tree */
static void rmrf(const char *path) {
	struct stat st;
	if (lstat(path, &st) != 0) return;
	if (S_ISDIR(st.st_mode)) {
		DIR *d = opendir(path);
		if (!d) return;
		struct dirent *ent;
		while ((ent = readdir(d)) != NULL) {
			if (ent->d_name[0] == '.' &&
			    (ent->d_name[1] == '\0' ||
			     (ent->d_name[1] == '.' && ent->d_name[2] == '\0')))
				continue;
			char child[2048];
			snprintf(child, sizeof(child), "%s/%s", path, ent->d_name);
			rmrf(child);
		}
		closedir(d);
		rmdir(path);
	} else {
		unlink(path);
	}
}

void qnc_embed_cleanup(const char *tmpdir) {
	if (!tmpdir) return;
	/* Safety: only delete paths under /tmp/ */
	if (strncmp(tmpdir, "/tmp/", 5) != 0) return;
	rmrf(tmpdir);
}

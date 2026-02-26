/*
 * qnc embedded support file extraction
 *
 * Reads the appended archive from the qnc binary itself and extracts
 * all files to a directory for use during compilation. When using a
 * persistent cache directory, a .stamp file tracks the qnc binary's mtime
 * to detect when the cache is stale and needs re-extraction.
 *
 * Uses libuv for all file operations for cross-platform compatibility.
 */
#include "embed.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <uv.h>

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

/* Ensure all parent directories in path exist */
static void ensure_parent_dirs(const char *path) {
	char *tmp = strdup(path);
	uv_fs_t req;
	for (char *p = tmp + 1; *p; p++) {
		if (*p == '/') {
			*p = '\0';
			uv_fs_mkdir(NULL, &req, tmp, 0700, NULL);
			uv_fs_req_cleanup(&req);
			*p = '/';
		}
	}
	free(tmp);
}

/* Get file mtime in seconds since epoch. Returns 0 on failure. */
static double get_mtime(const char *path) {
	uv_fs_t req;
	int r = uv_fs_stat(NULL, &req, path, NULL);
	double mtime = 0;
	if (r == 0)
		mtime = req.statbuf.st_mtim.tv_sec + req.statbuf.st_mtim.tv_nsec / 1e9;
	uv_fs_req_cleanup(&req);
	return mtime;
}

/* Set file mtime (atime is set to the same value) */
static void set_mtime(const char *path, double mtime) {
	uv_fs_t req;
	uv_fs_utime(NULL, &req, path, mtime, mtime, NULL);
	uv_fs_req_cleanup(&req);
}

/* Recursively remove a directory tree */
static void rmrf(const char *path) {
	uv_fs_t req;
	int r = uv_fs_stat(NULL, &req, path, NULL);
	if (r != 0) { uv_fs_req_cleanup(&req); return; }
	int is_dir = (req.statbuf.st_mode & S_IFMT) == S_IFDIR;
	uv_fs_req_cleanup(&req);

	if (is_dir) {
		uv_fs_t scanreq;
		r = uv_fs_scandir(NULL, &scanreq, path, 0, NULL);
		if (r >= 0) {
			uv_dirent_t ent;
			while (uv_fs_scandir_next(&scanreq, &ent) != UV_EOF) {
				char child[2048];
				snprintf(child, sizeof(child), "%s/%s", path, ent.name);
				rmrf(child);
			}
		}
		uv_fs_req_cleanup(&scanreq);
		uv_fs_rmdir(NULL, &req, path, NULL);
		uv_fs_req_cleanup(&req);
	} else {
		uv_fs_unlink(NULL, &req, path, NULL);
		uv_fs_req_cleanup(&req);
	}
}

/* Check if the cache is still valid by comparing qnc binary mtime
   against the .stamp file in the target dir. Returns 1 if valid. */
static int cache_is_valid(const char *target_dir, double exe_mtime) {
	char stamp_path[2048];
	snprintf(stamp_path, sizeof(stamp_path), "%s/.stamp", target_dir);

	uv_fs_t req;
	int r = uv_fs_open(NULL, &req, stamp_path, UV_FS_O_RDONLY, 0, NULL);
	uv_fs_req_cleanup(&req);
	if (r < 0) return 0;

	uv_file fd = r;
	char buf[64] = {0};
	uv_buf_t uvbuf = uv_buf_init(buf, sizeof(buf) - 1);
	r = uv_fs_read(NULL, &req, fd, &uvbuf, 1, 0, NULL);
	uv_fs_req_cleanup(&req);
	uv_fs_close(NULL, &req, fd, NULL);
	uv_fs_req_cleanup(&req);

	if (r <= 0) return 0;
	double stamp_mtime = strtod(buf, NULL);
	return stamp_mtime == exe_mtime;
}

/* Write the qnc binary mtime to .stamp in the target dir */
static void write_stamp(const char *target_dir, double exe_mtime) {
	char stamp_path[2048];
	snprintf(stamp_path, sizeof(stamp_path), "%s/.stamp", target_dir);

	uv_fs_t req;
	int fd = uv_fs_open(NULL, &req, stamp_path,
	                     UV_FS_O_WRONLY | UV_FS_O_CREAT | UV_FS_O_TRUNC, 0600, NULL);
	uv_fs_req_cleanup(&req);
	if (fd < 0) return;

	char buf[64];
	int len = snprintf(buf, sizeof(buf), "%.9f", exe_mtime);
	uv_buf_t uvbuf = uv_buf_init(buf, len);
	uv_fs_write(NULL, &req, fd, &uvbuf, 1, 0, NULL);
	uv_fs_req_cleanup(&req);
	uv_fs_close(NULL, &req, fd, NULL);
	uv_fs_req_cleanup(&req);
}

char *qnc_embed_extract(const char *exe_path, const char *target_dir) {
	uv_fs_t req;

	/* Read the qnc binary */
	int fd = uv_fs_open(NULL, &req, exe_path, UV_FS_O_RDONLY, 0, NULL);
	uv_fs_req_cleanup(&req);
	if (fd < 0) return NULL;

	/* Get file size */
	int r = uv_fs_fstat(NULL, &req, fd, NULL);
	if (r != 0) {
		uv_fs_req_cleanup(&req);
		uv_fs_close(NULL, &req, fd, NULL);
		uv_fs_req_cleanup(&req);
		return NULL;
	}
	int64_t file_size = req.statbuf.st_size;
	uv_fs_req_cleanup(&req);

	/* Read footer (last 24 bytes) */
	uint8_t footer[QNC_PACK_FOOTER_SIZE];
	uv_buf_t footer_buf = uv_buf_init((char *)footer, QNC_PACK_FOOTER_SIZE);
	r = uv_fs_read(NULL, &req, fd, &footer_buf, 1,
	               file_size - QNC_PACK_FOOTER_SIZE, NULL);
	uv_fs_req_cleanup(&req);
	if (r != QNC_PACK_FOOTER_SIZE) goto fail;

	/* Check magic */
	if (memcmp(footer + 16, QNC_PACK_MAGIC, QNC_PACK_MAGIC_SIZE) != 0) goto fail;

	uint64_t data_start = read_u64(footer);
	uint32_t file_count = read_u32(footer + 8);
	uint32_t dir_size = read_u32(footer + 12);

	if (file_count == 0) goto fail;

	/* Read directory */
	uint8_t *dir = malloc(dir_size);
	if (!dir) goto fail;
	uv_buf_t dir_buf = uv_buf_init((char *)dir, dir_size);
	r = uv_fs_read(NULL, &req, fd, &dir_buf, 1,
	               file_size - QNC_PACK_FOOTER_SIZE - dir_size, NULL);
	uv_fs_req_cleanup(&req);
	if (r != (int)dir_size) { free(dir); goto fail; }

	/* Create or reuse target directory */
	char *result;
	if (target_dir) {
		/* Check cache validity via .stamp file */
		double exe_mtime = get_mtime(exe_path);
		if (cache_is_valid(target_dir, exe_mtime)) {
			/* Cache is valid — skip extraction entirely */
			free(dir);
			uv_fs_close(NULL, &req, fd, NULL);
			uv_fs_req_cleanup(&req);
			return strdup(target_dir);
		}
		/* Cache is stale or missing — wipe and re-extract */
		rmrf(target_dir);
		ensure_parent_dirs(target_dir);
		uv_fs_mkdir(NULL, &req, target_dir, 0700, NULL);
		uv_fs_req_cleanup(&req);
		result = strdup(target_dir);
	} else {
		char tmpdir[] = "/tmp/qnc_XXXXXX";
		r = uv_fs_mkdtemp(NULL, &req, tmpdir, NULL);
		if (r != 0) {
			uv_fs_req_cleanup(&req);
			free(dir);
			goto fail;
		}
		result = strdup(req.path);
		uv_fs_req_cleanup(&req);
	}

	/* Parse directory and extract files */
	const uint8_t *dp = dir;
	uint64_t file_offset = data_start;

	for (uint32_t i = 0; i < file_count; i++) {
		if (dp + 2 > dir + dir_size) break;
		uint16_t name_len = read_u16(dp); dp += 2;

		if (dp + name_len + 8 + 4 > dir + dir_size) break;
		char name[1024];
		if (name_len >= sizeof(name)) break;
		memcpy(name, dp, name_len);
		name[name_len] = '\0';
		dp += name_len;

		uint64_t mtime_sec = read_u64(dp); dp += 8;
		uint32_t fsize = read_u32(dp); dp += 4;

		/* Build output path */
		char outpath[2048];
		snprintf(outpath, sizeof(outpath), "%s/%s", result, name);
		ensure_parent_dirs(outpath);

		/* Read file data */
		uint8_t *buf = malloc(fsize);
		if (!buf) break;
		uv_buf_t read_buf = uv_buf_init((char *)buf, fsize);
		r = uv_fs_read(NULL, &req, fd, &read_buf, 1, file_offset, NULL);
		uv_fs_req_cleanup(&req);
		if (r != (int)fsize) { free(buf); break; }

		/* Write file */
		int out_fd = uv_fs_open(NULL, &req, outpath,
		                        UV_FS_O_WRONLY | UV_FS_O_CREAT | UV_FS_O_TRUNC, 0600, NULL);
		uv_fs_req_cleanup(&req);
		if (out_fd >= 0) {
			uv_buf_t write_buf = uv_buf_init((char *)buf, fsize);
			uv_fs_write(NULL, &req, out_fd, &write_buf, 1, 0, NULL);
			uv_fs_req_cleanup(&req);
			uv_fs_close(NULL, &req, out_fd, NULL);
			uv_fs_req_cleanup(&req);

			/* Restore original mtime */
			if (mtime_sec > 0)
				set_mtime(outpath, (double)mtime_sec);
		}
		free(buf);
		file_offset += fsize;
	}

	/* Write stamp file so next invocation can detect cache validity */
	if (target_dir) {
		double exe_mtime = get_mtime(exe_path);
		write_stamp(result, exe_mtime);
	}

	free(dir);
	uv_fs_close(NULL, &req, fd, NULL);
	uv_fs_req_cleanup(&req);
	return result;

fail:
	uv_fs_close(NULL, &req, fd, NULL);
	uv_fs_req_cleanup(&req);
	return NULL;
}

void qnc_embed_cleanup(const char *tmpdir) {
	if (!tmpdir) return;
	/* Safety: only delete paths under /tmp/ */
	if (strncmp(tmpdir, "/tmp/", 5) != 0) return;
	rmrf(tmpdir);
}

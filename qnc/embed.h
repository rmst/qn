/*
 * qnc embedded support files
 *
 * At build time, support files (headers, static libs) are appended to the
 * qnc binary using a simple archive format. At compile time (-o mode),
 * qnc extracts them to a temp directory for use by gcc.
 *
 * Archive format (appended to binary):
 *   [file1 data][file2 data]...
 *   [directory: N entries, each = {uint16 name_len, name[], uint32 size}]
 *   [footer: uint64 data_start, uint32 count, uint32 dir_size, magic[8]]
 *
 * The footer is always the last 24 bytes of the file.
 */
#ifndef QNC_EMBED_H
#define QNC_EMBED_H

#include <stdint.h>

#define QNC_PACK_MAGIC "QNCPAK\0"
#define QNC_PACK_MAGIC_SIZE 8
#define QNC_PACK_FOOTER_SIZE 24

/*
 * Extract embedded support files to a temporary directory.
 * Returns the path to the temp directory (caller must free),
 * or NULL if no embedded files found (fall back to exe_dir).
 * The temp directory contains the same layout as bin/<platform>/
 * (headers at top level, subdirs for module_resolution/ and libuv/).
 */
char *qnc_embed_extract(const char *exe_path);

/*
 * Clean up the temp directory created by qnc_embed_extract.
 */
void qnc_embed_cleanup(const char *tmpdir);

#endif /* QNC_EMBED_H */

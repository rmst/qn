/*
 * QJSX Module Resolution System
 *
 * Shared module resolution functions for QJSXPATH support and Node.js-style
 * module resolution. Used by both qjsx (interpreter) and qjsxc (compiler).
 *
 * Features:
 * - QJSXPATH environment variable support (like NODE_PATH)
 * - Node.js-style index.js resolution
 * - Colon-to-slash translation (e.g., "node:fs" -> "node/fs")
 */

#ifndef QJSX_MODULE_RESOLUTION_H
#define QJSX_MODULE_RESOLUTION_H

#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "quickjs/cutils.h"
#include "quickjs/quickjs-libc.h"

/* ========================================================================
 * CROSS-PLATFORM PATH SEPARATORS
 * ======================================================================== */

/*
 * Windows uses semicolons to separate paths in environment variables (like PATH)
 * and backslashes for directory separators.
 * Unix-like systems use colons and forward slashes.
 */
#ifdef _WIN32
#define PATH_SEP ";"     // Windows: PATH=C:\dir1;C:\dir2
#define DIR_SEP "\\"     // Windows: C:\dir\file.txt
#else
#define PATH_SEP ":"     // Unix: PATH=/usr/bin:/bin
#define DIR_SEP "/"      // Unix: /home/user/file.txt
#endif

/* ========================================================================
 * FILE SYSTEM UTILITIES
 * ======================================================================== */

/**
 * Check if a file exists and is readable
 *
 * @param path - The file path to check
 * @return 1 if file exists and is readable, 0 otherwise
 *
 * This function uses POSIX system calls:
 * - stat(): Gets file information (exists, type, permissions)
 * - S_ISREG(): Macro to check if it's a regular file (not directory/device)
 * - access(): Checks if we have read permission
 */
static int file_exists(const char *path) {
    struct stat st;  // Structure to hold file information

    // stat() returns 0 on success, -1 on failure
    // S_ISREG() checks if it's a regular file
    // access() with R_OK checks read permission
    return stat(path, &st) == 0 && S_ISREG(st.st_mode) && access(path, R_OK) == 0;
}

/* ========================================================================
 * MODULE RESOLUTION FUNCTIONS
 * ======================================================================== */

/**
 * Resolve a bare module name using QJSXPATH environment variable
 *
 * @param ctx - QuickJS context (used for memory allocation)
 * @param name - The bare module name (e.g., "lodash", "react")
 * @return Resolved file path, or NULL if not found
 *
 * Example:
 *   QJSXPATH="./my_modules:./lib"
 *   resolve_qjsxpath(ctx, "utils") might return "./my_modules/utils.js"
 *
 * This is the heart of our Node.js-style module resolution.
 */
static char *resolve_qjsxpath(JSContext *ctx, const char *name) {
    // Get the QJSXPATH environment variable (like NODE_PATH in Node.js)
    const char *paths = getenv("QJSXPATH");
    if (!paths) return NULL;  // No QJSXPATH set, can't resolve

    // Make a working copy since strtok() modifies the string
    // js_strdup() is QuickJS's memory-managed version of strdup()
    char *copy = js_strdup(ctx, paths);
    if (!copy) return NULL;  // Memory allocation failed

    char *result = NULL;  // Will hold the final resolved path

    /*
     * Parse the QJSXPATH using strtok() to split on PATH_SEP
     *
     * Example: "./my_modules:./lib" becomes ["./my_modules", "./lib"]
     *
     * strtok() works by:
     * 1. First call: strtok(string, delimiter) returns first token
     * 2. Subsequent calls: strtok(NULL, delimiter) returns next tokens
     * 3. Returns NULL when no more tokens
     */
    for (char *path = strtok(copy, PATH_SEP); path && !result; path = strtok(NULL, PATH_SEP)) {

        // Clean up the path by removing trailing slashes
        size_t len = strlen(path);
        if (len > 0 && strchr("/\\", path[len-1])) {
            path[len-1] = 0;  // Null-terminate to remove trailing slash
        }

        // Allocate buffer for constructing candidate paths
        // +20 gives us room for "/index.js" plus null terminator
        size_t buflen = len + strlen(name) + 20;
        char *buf = js_malloc(ctx, buflen);  // QuickJS memory management
        if (!buf) continue;  // Skip this path if allocation failed

        /*
         * Try the three Node.js resolution strategies in order:
         *
         * 1. path/name/index.js (package with index file)
         * 2. path/name.js (direct file with .js extension)
         * 3. path/name (direct file without extension)
         */

        // Strategy 1: path/name/index.js
        snprintf(buf, buflen, "%s" DIR_SEP "%s" DIR_SEP "index.js", path, name);
        if (file_exists(buf)) {
            result = buf;  // Found it!
            break;
        }

        // Strategy 2: path/name.js
        snprintf(buf, buflen, "%s" DIR_SEP "%s.js", path, name);
        if (file_exists(buf)) {
            result = buf;  // Found it!
            break;
        }

        // Strategy 3: path/name (exact filename)
        snprintf(buf, buflen, "%s" DIR_SEP "%s", path, name);
        if (file_exists(buf)) {
            result = buf;  // Found it!
            break;
        }

        // None of the strategies worked for this path, clean up and try next
        js_free(ctx, buf);
    }

    // Clean up the working copy
    js_free(ctx, copy);

    // Return the resolved path (or NULL if nothing was found)
    return result;
}

/**
 * Try to resolve a path with Node.js-style index.js fallback
 *
 * @param ctx - QuickJS context (for memory allocation)
 * @param name - The import path to resolve
 * @return Resolved file path, or NULL if not found
 *
 * This implements Node.js module resolution for relative/absolute paths:
 *   1. Try the exact path
 *   2. Try path.js
 *   3. Try path/index.js
 */
static char *resolve_with_index(JSContext *ctx, const char *name) {
    size_t name_len = strlen(name);

    // Strategy 1: Try exact path first
    if (file_exists(name)) {
        return js_strdup(ctx, name);
    }

    // Strategy 2: Try with .js extension
    size_t buflen = name_len + 20;  // Extra room for ".js", "/index.js" + null terminator
    char *buf = js_malloc(ctx, buflen);
    if (!buf) return NULL;

    snprintf(buf, buflen, "%s.js", name);
    if (file_exists(buf)) {
        return buf;  // Return the allocated buffer
    }

    // Strategy 3: Try path/index.js
    snprintf(buf, buflen, "%s" DIR_SEP "index.js", name);
    if (file_exists(buf)) {
        return buf;  // Return the allocated buffer
    }

    // Nothing found, clean up and return NULL
    js_free(ctx, buf);
    return NULL;
}

/**
 * Translate colons to forward slashes in module names
 *
 * @param ctx - QuickJS context (for memory allocation)
 * @param name - The original module name (e.g., "node:fs")
 * @return Translated module name (e.g., "node/fs"), or NULL on allocation failure
 *
 * This allows imports like "node:fs" to be resolved as "node/fs.js" in QJSXPATH,
 * making the filesystem structure more conventional.
 */
static char *translate_colons_to_slashes(JSContext *ctx, const char *name) {
    if (!strchr(name, ':')) {
        return NULL;  // No colons to translate
    }

    char *translated = js_strdup(ctx, name);
    if (!translated) return NULL;

    // Replace all colons with forward slashes
    for (char *p = translated; *p; p++) {
        if (*p == ':') {
            *p = '/';
        }
    }

    return translated;
}

/* ========================================================================
 * MODULE NAME NORMALIZATION
 * ======================================================================== */

/**
 * Check if Node.js strict resolution mode is enabled.
 *
 * Node mode (QJSX_MODULE_RESOLUTION=node):
 *   - Matches Node.js ESM behavior exactly
 *   - Explicit extensions required (no .js fallback)
 *   - No automatic index.js resolution
 *   - QJSXPATH and colon-to-slash still work
 *
 * Bundler mode (default):
 *   - "./foo" resolves to "./foo.js" if it exists
 *   - "./dir" resolves to "./dir/index.js" if it exists
 *   - Normalizer strips .js and /index.js for canonical names
 */
static int is_node_resolution(void) {
    const char *mode = getenv("QJSX_MODULE_RESOLUTION");
    return mode && strcmp(mode, "node") == 0;
}

/**
 * Normalize a module name by resolving relative path components.
 *
 * This is the core path normalization logic (based on QuickJS's default).
 * It handles:
 *   - Bare imports: returned unchanged
 *   - Relative paths: "./foo" and "../bar" resolved against base_name
 *
 * @param ctx - QuickJS context (for memory allocation)
 * @param base_name - The name of the importing module
 * @param name - The import specifier to normalize
 * @return Normalized module name, or NULL on allocation failure
 */
static char *normalize_module_name(JSContext *ctx, const char *base_name,
                                   const char *name) {
    char *filename, *p;
    const char *r;
    int cap;
    int len;

    if (name[0] != '.') {
        // Bare import (no leading dot) - return unchanged
        return js_strdup(ctx, name);
    }

    // Find the directory part of base_name
    p = strrchr(base_name, '/');
    if (p)
        len = p - base_name;
    else
        len = 0;

    // Allocate buffer for result
    cap = len + strlen(name) + 1 + 1;
    filename = js_malloc(ctx, cap);
    if (!filename)
        return NULL;
    memcpy(filename, base_name, len);
    filename[len] = '\0';

    // Resolve leading './' and '../' sequences
    r = name;
    for (;;) {
        if (r[0] == '.' && r[1] == '/') {
            // "./" - just skip it
            r += 2;
        } else if (r[0] == '.' && r[1] == '.' && r[2] == '/') {
            // "../" - go up one directory
            if (filename[0] == '\0')
                break;
            p = strrchr(filename, '/');
            if (!p)
                p = filename;
            else
                p++;
            if (!strcmp(p, ".") || !strcmp(p, ".."))
                break;
            if (p > filename)
                p--;
            *p = '\0';
            r += 3;
        } else {
            break;
        }
    }

    // Append the remaining path
    if (filename[0] != '\0')
        pstrcat(filename, cap, "/");
    pstrcat(filename, cap, r);

    return filename;
}

/**
 * Strip "/index.js" suffix from a path (in place).
 */
static void strip_index_js_suffix(char *path) {
    size_t len = strlen(path);
    if (len > 9 && strcmp(path + len - 9, "/index.js") == 0) {
        path[len - 9] = '\0';
    }
}

/**
 * Strip ".js" suffix from a path (in place).
 */
static void strip_js_suffix(char *path) {
    size_t len = strlen(path);
    if (len > 3 && strcmp(path + len - 3, ".js") == 0) {
        path[len - 3] = '\0';
    }
}

/**
 * QJSX module normalizer - produces canonical module names.
 *
 * This normalizer is used by both qjsx (interpreter) and compiled binaries.
 * It ensures that different import specifiers for the same logical module
 * produce the same canonical name, enabling embedded module lookup.
 *
 * Processing steps:
 *   1. Colon-to-slash translation (e.g., "node:fs" -> "node/fs")
 *   2. Resolve relative paths (handle "./" and "../")
 *   3. In bundler mode: strip ".js" and "/index.js" for canonical form
 *
 * @param ctx - QuickJS context
 * @param base_name - The name of the importing module
 * @param name - The import specifier to normalize
 * @param opaque - Unused (for API compatibility)
 * @return Canonical module name, or NULL on error
 */
static char *qjsx_module_normalizer(JSContext *ctx, const char *base_name,
                                    const char *name, void *opaque) {
    // Step 1: Colon-to-slash translation
    char *translated = translate_colons_to_slashes(ctx, name);
    const char *work_name = translated ? translated : name;

    // Step 2: Resolve relative paths
    char *result = normalize_module_name(ctx, base_name, work_name);

    // Clean up translated name if allocated
    if (translated)
        js_free(ctx, translated);

    if (!result)
        return NULL;

    // Step 3: Strip .js and /index.js for canonical form (except in node mode)
    if (!is_node_resolution()) {
        strip_index_js_suffix(result);
        strip_js_suffix(result);
    }

    return result;
}

#endif /* QJSX_MODULE_RESOLUTION_H */

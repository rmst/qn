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
 * - Symlink resolution via realpath() for filesystem paths
 *
 * Environment variables:
 * - QJSXPATH: Colon-separated list of directories to search for bare imports
 * - QJSX_MODULE_RESOLUTION: Set to "node" for strict Node.js ESM mode
 * - QJSX_MODULE_DEBUG: Set to "1" to enable debug output
 */

#ifndef QJSX_MODULE_RESOLUTION_H
#define QJSX_MODULE_RESOLUTION_H

#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <limits.h>
#include "quickjs/cutils.h"
#include "quickjs/quickjs-libc.h"

/* ========================================================================
 * DEBUG OUTPUT
 * ======================================================================== */

static int module_debug_enabled(void) {
    static int cached = -1;
    if (cached == -1) {
        const char *v = getenv("QJSX_MODULE_DEBUG");
        cached = (v && v[0] == '1');
    }
    return cached;
}

#define MODULE_DEBUG(fmt, ...) do { \
    if (module_debug_enabled()) \
        fprintf(stderr, "[module] " fmt "\n", ##__VA_ARGS__); \
} while(0)

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
 */
static int is_node_resolution(void) {
    const char *mode = getenv("QJSX_MODULE_RESOLUTION");
    return mode && strcmp(mode, "node") == 0;
}

/**
 * Context for module resolution, passed via opaque parameter.
 * For interpreter: embedded_modules is NULL (uses filesystem)
 * For compiled binary: embedded_modules contains list of embedded module names
 */
typedef struct {
    const char **embedded_modules;
} QJSXModuleResolverContext;

/**
 * Check if a module name exists in the embedded modules list.
 */
static int embedded_module_exists(const char **modules, const char *name) {
    if (!modules) return 0;
    for (int i = 0; modules[i]; i++) {
        if (strcmp(modules[i], name) == 0) return 1;
    }
    return 0;
}

/**
 * Resolve a bare module name to its canonical internal path via QJSXPATH.
 *
 * This returns the canonical name with extension (e.g., "node/child_process/index.js")
 * NOT the filesystem path (e.g., "./node/node/child_process/index.js").
 *
 * For embedded modules, probes the embedded list.
 * For filesystem, probes QJSXPATH directories.
 *
 * @param ctx - QuickJS context (for memory allocation)
 * @param name - The bare module name (e.g., "node/child_process")
 * @param embedded_modules - List of embedded module names, or NULL for filesystem
 * @return Canonical name with extension, or NULL if not found
 */
static char *resolve_qjsxpath_canonical(JSContext *ctx, const char *name,
                                        const char **embedded_modules) {
    size_t name_len = strlen(name);
    size_t buflen = name_len + 20;
    char *buf = js_malloc(ctx, buflen);
    if (!buf) return NULL;

    if (embedded_modules) {
        // For embedded modules: probe the list with extensions
        if (embedded_module_exists(embedded_modules, name)) {
            js_free(ctx, buf);
            return js_strdup(ctx, name);
        }
        snprintf(buf, buflen, "%s/index.js", name);
        if (embedded_module_exists(embedded_modules, buf)) {
            return buf;
        }
        snprintf(buf, buflen, "%s.js", name);
        if (embedded_module_exists(embedded_modules, buf)) {
            return buf;
        }
    } else {
        // For filesystem: probe QJSXPATH directories
        const char *paths = getenv("QJSXPATH");
        if (!paths) {
            js_free(ctx, buf);
            return NULL;
        }

        char *copy = js_strdup(ctx, paths);
        if (!copy) {
            js_free(ctx, buf);
            return NULL;
        }

        char *result = NULL;
        for (char *path = strtok(copy, PATH_SEP); path && !result; path = strtok(NULL, PATH_SEP)) {
            size_t path_len = strlen(path);
            if (path_len > 0 && strchr("/\\", path[path_len-1])) {
                path[path_len-1] = 0;
                path_len--;
            }

            size_t full_buflen = path_len + name_len + 20;
            char *full_path = js_malloc(ctx, full_buflen);
            if (!full_path) continue;

            // Strategy 1: path/name/index.js -> return "name/index.js"
            snprintf(full_path, full_buflen, "%s" DIR_SEP "%s" DIR_SEP "index.js", path, name);
            if (file_exists(full_path)) {
                snprintf(buf, buflen, "%s/index.js", name);
                result = buf;
                js_free(ctx, full_path);
                break;
            }

            // Strategy 2: path/name.js -> return "name.js"
            snprintf(full_path, full_buflen, "%s" DIR_SEP "%s.js", path, name);
            if (file_exists(full_path)) {
                snprintf(buf, buflen, "%s.js", name);
                result = buf;
                js_free(ctx, full_path);
                break;
            }

            // Strategy 3: path/name -> return "name"
            snprintf(full_path, full_buflen, "%s" DIR_SEP "%s", path, name);
            if (file_exists(full_path)) {
                js_free(ctx, buf);
                result = js_strdup(ctx, name);
                js_free(ctx, full_path);
                break;
            }

            js_free(ctx, full_path);
        }

        js_free(ctx, copy);
        if (result) return result;
    }

    js_free(ctx, buf);
    return NULL;
}

/**
 * Probe for module existence with extension fallbacks.
 * Returns the resolved name (with extension) or NULL if not found.
 *
 * For embedded modules: probes the embedded list
 * For interpreter: probes the filesystem
 */
static char *probe_module_with_extensions(JSContext *ctx, const char *name,
                                          const char **embedded_modules) {
    size_t name_len = strlen(name);
    size_t buflen = name_len + 20;
    char *buf = js_malloc(ctx, buflen);
    if (!buf) return NULL;

    if (embedded_modules) {
        if (embedded_module_exists(embedded_modules, name)) {
            js_free(ctx, buf);
            return js_strdup(ctx, name);
        }
        snprintf(buf, buflen, "%s.js", name);
        if (embedded_module_exists(embedded_modules, buf)) {
            return buf;
        }
        snprintf(buf, buflen, "%s/index.js", name);
        if (embedded_module_exists(embedded_modules, buf)) {
            return buf;
        }
    } else {
        if (file_exists(name)) {
            js_free(ctx, buf);
            return js_strdup(ctx, name);
        }
        snprintf(buf, buflen, "%s.js", name);
        if (file_exists(buf)) {
            return buf;
        }
        snprintf(buf, buflen, "%s/index.js", name);
        if (file_exists(buf)) {
            return buf;
        }
    }

    js_free(ctx, buf);
    return NULL;
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
            if (filename[0] == 0)
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
            *p = 0;
            r += 3;
        } else {
            break;
        }
    }

    // Append the remaining path
    if (filename[0] != 0)
        pstrcat(filename, cap, "/");
    pstrcat(filename, cap, r);

    return filename;
}

/**
 * Check if a path is a filesystem path (relative or absolute).
 * Filesystem paths start with '/', './', or '../'
 */
static int is_filesystem_path(const char *name) {
    if (name[0] == '/') return 1;
    if (name[0] == '.' && (name[1] == '/' || name[1] == '\0')) return 1;
    if (name[0] == '.' && name[1] == '.' && (name[2] == '/' || name[2] == '\0')) return 1;
    return 0;
}

/**
 * Resolve a filesystem path to its canonical absolute path using realpath().
 * Returns a newly allocated string, or NULL if realpath fails.
 * Falls back to the original path if realpath fails (e.g., file doesn't exist yet).
 */
static char *resolve_realpath(JSContext *ctx, const char *path) {
    char resolved[PATH_MAX];
    if (realpath(path, resolved)) {
        return js_strdup(ctx, resolved);
    }
    return NULL;
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
 *   2. For filesystem paths: resolve base_name via realpath for symlink handling
 *   3. Resolve relative paths (handle "./" and "../")
 *   4. For filesystem paths: resolve result via realpath
 *   5. In bundler mode: probe for existence to find full path with extension
 *
 * @param ctx - QuickJS context
 * @param base_name - The name of the importing module
 * @param name - The import specifier to normalize
 * @param opaque - QJSXModuleResolverContext* with embedded modules list (or NULL)
 * @return Canonical module name, or NULL on error
 */
static char *qjsx_module_normalizer(JSContext *ctx, const char *base_name,
                                    const char *name, void *opaque) {
    QJSXModuleResolverContext *resolver_ctx = (QJSXModuleResolverContext *)opaque;
    const char **embedded_modules = resolver_ctx ? resolver_ctx->embedded_modules : NULL;

    MODULE_DEBUG("normalize: base='%s' name='%s'", base_name, name);

    // Step 1: Colon-to-slash translation
    char *translated = translate_colons_to_slashes(ctx, name);
    const char *work_name = translated ? translated : name;

    // Determine if this is a filesystem path (relative or absolute)
    int is_fs_path = is_filesystem_path(work_name);

    // Step 2: For filesystem paths, resolve base_name via realpath
    // This ensures relative imports resolve against the real file location,
    // not a symlink's location. Skip for embedded modules (files don't exist on disk).
    char *real_base = NULL;
    const char *effective_base = base_name;

    if (is_fs_path && is_filesystem_path(base_name)) {
        int base_is_embedded = embedded_modules && embedded_module_exists(embedded_modules, base_name);
        if (!base_is_embedded) {
            real_base = resolve_realpath(ctx, base_name);
            if (real_base) {
                MODULE_DEBUG("realpath base: '%s' -> '%s'", base_name, real_base);
                effective_base = real_base;
            }
        }
    }

    // Step 3: Resolve relative paths (handle "./" and "../")
    char *resolved = normalize_module_name(ctx, effective_base, work_name);

    // Clean up
    if (translated)
        js_free(ctx, translated);
    if (real_base)
        js_free(ctx, real_base);

    if (!resolved)
        return NULL;

    MODULE_DEBUG("after normalize: '%s'", resolved);

    // Bare imports (no leading dot or slash) - resolve via QJSXPATH to get canonical name
    if (!is_filesystem_path(name)) {
        if (!is_node_resolution()) {
            char *canonical = resolve_qjsxpath_canonical(ctx, resolved, embedded_modules);
            if (canonical) {
                MODULE_DEBUG("QJSXPATH resolved: '%s' -> '%s'", resolved, canonical);
                js_free(ctx, resolved);
                return canonical;
            }
        }
        // Not found in QJSXPATH or node mode - return as-is, loader will handle/fail
        MODULE_DEBUG("result (bare): '%s'", resolved);
        return resolved;
    }

    // Step 4: For filesystem paths, resolve the result via realpath
    // Skip for embedded modules or if file doesn't exist yet
    if (!embedded_modules) {
        // First probe for extensions in bundler mode
        char *probed = NULL;
        if (!is_node_resolution()) {
            probed = probe_module_with_extensions(ctx, resolved, NULL);
            if (probed) {
                MODULE_DEBUG("extension probe: '%s' -> '%s'", resolved, probed);
                js_free(ctx, resolved);
                resolved = probed;
            }
        }

        // Now realpath the result
        char *real_result = resolve_realpath(ctx, resolved);
        if (real_result) {
            MODULE_DEBUG("realpath result: '%s' -> '%s'", resolved, real_result);
            js_free(ctx, resolved);
            MODULE_DEBUG("result (filesystem): '%s'", real_result);
            return real_result;
        }
    } else {
        // For embedded modules, just probe for extensions in bundler mode
        if (!is_node_resolution()) {
            char *probed = probe_module_with_extensions(ctx, resolved, embedded_modules);
            if (probed) {
                MODULE_DEBUG("extension probe (embedded): '%s' -> '%s'", resolved, probed);
                js_free(ctx, resolved);
                MODULE_DEBUG("result (embedded): '%s'", probed);
                return probed;
            }
        }
    }

    // Return resolved path (node mode or probe/realpath failed - let loader handle it)
    MODULE_DEBUG("result: '%s'", resolved);
    return resolved;
}

#endif /* QJSX_MODULE_RESOLUTION_H */

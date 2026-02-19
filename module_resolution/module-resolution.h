/*
 * QJSX Module Resolution System
 *
 * Shared module resolution functions for Node.js-style module resolution.
 * Used by both qjsx (interpreter) and qnc (compiler).
 *
 * Features:
 * - NODE_PATH environment variable support (colon-separated search directories)
 * - node_modules directory walking (Node.js-style package resolution)
 * - package.json "exports" and "main" field resolution
 * - Node.js-style index.js resolution
 * - Colon-to-slash translation (e.g., "node:fs" -> "node/fs")
 * - Symlink resolution via realpath() for filesystem paths
 *
 * Environment variables:
 * - NODE_PATH: Colon-separated list of directories to search for bare imports
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
 * Get search paths from the NODE_PATH environment variable.
 */
static const char *get_search_paths(void) {
    return getenv("NODE_PATH");
}

/**
 * Resolve a bare module name using NODE_PATH search directories.
 *
 * @param ctx - QuickJS context (used for memory allocation)
 * @param name - The bare module name (e.g., "lodash", "react")
 * @return Resolved file path, or NULL if not found
 *
 * Example:
 *   NODE_PATH="./my_modules:./lib"
 *   resolve_node_path(ctx, "utils") might return "./my_modules/utils.js"
 */
static char *resolve_node_path(JSContext *ctx, const char *name) {
    const char *paths = get_search_paths();
    if (!paths) return NULL;

    char *copy = js_strdup(ctx, paths);
    if (!copy) return NULL;

    char *result = NULL;
    for (char *path = strtok(copy, PATH_SEP); path && !result; path = strtok(NULL, PATH_SEP)) {
        size_t len = strlen(path);
        if (len > 0 && strchr("/\\", path[len-1])) {
            path[len-1] = 0;
        }

        size_t buflen = len + strlen(name) + 20;
        char *buf = js_malloc(ctx, buflen);
        if (!buf) continue;

        /* Try: path/name/index.js, path/name.js, path/name */
        snprintf(buf, buflen, "%s" DIR_SEP "%s" DIR_SEP "index.js", path, name);
        if (file_exists(buf)) { result = buf; break; }

        snprintf(buf, buflen, "%s" DIR_SEP "%s.js", path, name);
        if (file_exists(buf)) { result = buf; break; }

        snprintf(buf, buflen, "%s" DIR_SEP "%s", path, name);
        if (file_exists(buf)) { result = buf; break; }

        js_free(ctx, buf);
    }

    js_free(ctx, copy);
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
 * This allows imports like "node:fs" to be resolved as "node/fs.js" in NODE_PATH,
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
 *   - NODE_PATH and colon-to-slash still work
 *
 * Bundler mode (default):
 *   - "./foo" resolves to "./foo.js" if it exists
 *   - "./dir" resolves to "./dir/index.js" if it exists
 */
static int is_node_resolution(void) {
    const char *mode = getenv("QJSX_MODULE_RESOLUTION");
    return mode && strcmp(mode, "node") == 0;
}

/* ========================================================================
 * EMBEDDED MODULE PREFIX
 * ========================================================================
 *
 * All embedded modules use an "embedded://" prefix in cache keys.
 * Disk modules use plain absolute paths (starting with '/').
 * These two namespaces can never collide in QuickJS's single module cache.
 *
 * The "file://" protocol is a one-shot signal in import specifiers
 * to force disk loading, even from embedded code.
 */

#define EMBEDDED_PREFIX "embedded://"
#define EMBEDDED_PREFIX_LEN 11
#define FILE_PREFIX "file://"
#define FILE_PREFIX_LEN 7

static int has_embedded_prefix(const char *name) {
    return strncmp(name, EMBEDDED_PREFIX, EMBEDDED_PREFIX_LEN) == 0;
}

static int has_file_prefix(const char *name) {
    return strncmp(name, FILE_PREFIX, FILE_PREFIX_LEN) == 0;
}

/**
 * Import map entry: records how a (base_name, specifier) pair resolves.
 * Built at compile time, used at runtime for standalone binaries.
 */
typedef struct {
    const char *base_name;   /* importing module (embedded:// prefixed) */
    const char *specifier;   /* original import specifier */
    const char *resolved;    /* resolved name (embedded:// prefixed) */
} QJSXImportMapEntry;

/**
 * Callback for recording import map entries at compile time.
 */
typedef void (*QJSXImportRecordFn)(const char *base, const char *specifier, const char *resolved);

/**
 * Context for module resolution, passed via opaque parameter.
 *
 * Interpreter (qjsx):     embedded_modules=NULL, compile_mode=0
 * Compiler (qnc):       compile_mode=1, record_import set
 * Runtime standalone:      embedded_modules set, import_map set
 */
typedef struct {
    const char **embedded_modules;
    const QJSXImportMapEntry *import_map;
    int import_map_count;
    int compile_mode;           /* 1 = compiler, prefix all with embedded:// */
    QJSXImportRecordFn record_import;  /* compile-time: record (base, spec, resolved) */
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
 * Look up a (base_name, specifier) pair in the import map.
 * Returns the resolved name (embedded:// prefixed) or NULL.
 */
static const char *import_map_lookup(const QJSXImportMapEntry *map, int count,
                                     const char *base_name, const char *specifier) {
    if (!map) return NULL;
    for (int i = 0; i < count; i++) {
        if (strcmp(map[i].base_name, base_name) == 0 &&
            strcmp(map[i].specifier, specifier) == 0) {
            return map[i].resolved;
        }
    }
    return NULL;
}

/**
 * Resolve a bare module name to its canonical internal path via NODE_PATH.
 *
 * Returns the canonical name with extension (e.g., "node/child_process/index.js")
 * NOT the filesystem path (e.g., "./node/node/child_process/index.js").
 *
 * For embedded modules, probes the embedded list.
 * For filesystem, probes NODE_PATH directories.
 */
static char *resolve_node_path_canonical(JSContext *ctx, const char *name,
                                        const char **embedded_modules) {
    size_t name_len = strlen(name);
    size_t buflen = name_len + 20;
    char *buf = js_malloc(ctx, buflen);
    if (!buf) return NULL;

    // Check embedded list first (early return for embedded modules)
    if (embedded_modules) {
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
    }

    // Probe filesystem via NODE_PATH
    {
        const char *paths = get_search_paths();
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

/* ========================================================================
 * NODE_MODULES AND PACKAGE.JSON RESOLUTION
 * ======================================================================== */

/**
 * Get the length of the package name portion of a bare import specifier.
 * Scoped packages (@scope/name) include both segments.
 *
 * "hono"           -> 4       "hono/cookie"    -> 4
 * "@hono/node"     -> 10      "@hono/node/foo" -> 10
 */
static size_t package_name_length(const char *name) {
    if (name[0] == '@') {
        const char *first_slash = strchr(name, '/');
        if (!first_slash) return strlen(name);
        const char *second_slash = strchr(first_slash + 1, '/');
        if (!second_slash) return strlen(name);
        return second_slash - name;
    }
    const char *slash = strchr(name, '/');
    return slash ? (size_t)(slash - name) : strlen(name);
}

/**
 * Resolve a single exports target value. Handles both plain strings
 * ("./dist/index.js") and conditional objects ({"import": "...", "default": "..."}).
 * Returns an allocated absolute path, or NULL.
 */
static char *resolve_export_target(JSContext *ctx, JSValue target, const char *pkg_dir) {
    if (JS_IsString(target)) {
        const char *str = JS_ToCString(ctx, target);
        if (!str) return NULL;
        /* Skip leading "./" from relative export paths */
        const char *rel = str;
        if (rel[0] == '.' && rel[1] == '/') rel += 2;
        size_t len = strlen(pkg_dir) + strlen(rel) + 2;
        char *result = js_malloc(ctx, len);
        if (result) snprintf(result, len, "%s/%s", pkg_dir, rel);
        JS_FreeCString(ctx, str);
        return result;
    }
    if (JS_IsObject(target)) {
        /* Conditional exports: try "import" then "default" */
        const char *conditions[] = { "import", "default", NULL };
        for (int i = 0; conditions[i]; i++) {
            JSValue val = JS_GetPropertyStr(ctx, target, conditions[i]);
            if (!JS_IsUndefined(val) && !JS_IsException(val)) {
                char *result = resolve_export_target(ctx, val, pkg_dir);
                JS_FreeValue(ctx, val);
                if (result) return result;
            } else {
                JS_FreeValue(ctx, val);
            }
        }
    }
    return NULL;
}

/**
 * Resolve a bare import via a package's package.json file.
 * Tries the "exports" field first (with subpath matching), then "main",
 * then falls back to index.js resolution.
 *
 * @param pkg_dir - Package directory (e.g., "/path/node_modules/hono")
 * @param subpath - "." for root import, or subpath like "cookie"
 */
static char *resolve_package_json(JSContext *ctx, const char *pkg_dir, const char *subpath) {
    char pkg_json_path[PATH_MAX];
    snprintf(pkg_json_path, sizeof(pkg_json_path), "%s/package.json", pkg_dir);

    size_t buf_len;
    uint8_t *buf = js_load_file(ctx, &buf_len, pkg_json_path);
    if (!buf) return NULL;

    JSValue pkg = JS_ParseJSON(ctx, (char *)buf, buf_len, pkg_json_path);
    js_free(ctx, buf);
    if (JS_IsException(pkg)) {
        JSValue ex = JS_GetException(ctx);
        JS_FreeValue(ctx, ex);
        return NULL;
    }

    char *result = NULL;

    /* Try "exports" field */
    JSValue exports_val = JS_GetPropertyStr(ctx, pkg, "exports");
    if (!JS_IsUndefined(exports_val) && !JS_IsException(exports_val)) {
        char subpath_key[256];
        if (strcmp(subpath, ".") == 0) {
            strcpy(subpath_key, ".");
        } else {
            snprintf(subpath_key, sizeof(subpath_key), "./%s", subpath);
        }

        if (JS_IsString(exports_val) && strcmp(subpath, ".") == 0) {
            result = resolve_export_target(ctx, exports_val, pkg_dir);
        } else if (JS_IsObject(exports_val)) {
            JSValue entry = JS_GetPropertyStr(ctx, exports_val, subpath_key);
            if (!JS_IsUndefined(entry) && !JS_IsException(entry)) {
                result = resolve_export_target(ctx, entry, pkg_dir);
            }
            JS_FreeValue(ctx, entry);

            /* If root import not found as ".", exports might be conditional directly */
            if (!result && strcmp(subpath, ".") == 0) {
                result = resolve_export_target(ctx, exports_val, pkg_dir);
            }
        }
    }
    JS_FreeValue(ctx, exports_val);

    /* Fallback: "main" field (only for root import) */
    if (!result && strcmp(subpath, ".") == 0) {
        JSValue main_val = JS_GetPropertyStr(ctx, pkg, "main");
        if (JS_IsString(main_val)) {
            result = resolve_export_target(ctx, main_val, pkg_dir);
        }
        JS_FreeValue(ctx, main_val);
    }

    JS_FreeValue(ctx, pkg);
    return result;
}

/**
 * Resolve a bare import by walking up the directory tree from the importing
 * file's location, looking for node_modules directories containing the package.
 *
 * @param base_name - Absolute path of the importing file
 * @param name - Bare import specifier (e.g., "hono", "hono/cookie")
 */
static char *resolve_node_modules(JSContext *ctx, const char *base_name, const char *name) {
    size_t pkg_len = package_name_length(name);
    char pkg_name[256];
    if (pkg_len >= sizeof(pkg_name)) return NULL;
    memcpy(pkg_name, name, pkg_len);
    pkg_name[pkg_len] = '\0';

    const char *subpath = (name[pkg_len] == '/') ? name + pkg_len + 1 : ".";

    /* Get directory of the importing file */
    char base_dir[PATH_MAX];
    size_t base_len = strlen(base_name);
    if (base_len >= sizeof(base_dir)) return NULL;
    memcpy(base_dir, base_name, base_len + 1);
    char *slash = strrchr(base_dir, '/');
    if (slash && slash != base_dir) {
        *slash = '\0';
    } else if (slash) {
        base_dir[1] = '\0';
    } else {
        strcpy(base_dir, ".");
    }

    /* Walk up the directory tree */
    for (;;) {
        char pkg_dir[PATH_MAX];
        snprintf(pkg_dir, sizeof(pkg_dir), "%s/node_modules/%s", base_dir, pkg_name);

        struct stat st;
        if (stat(pkg_dir, &st) == 0 && S_ISDIR(st.st_mode)) {
            MODULE_DEBUG("found package dir: %s", pkg_dir);

            /* Try package.json resolution first */
            char *result = resolve_package_json(ctx, pkg_dir, subpath);
            if (result && file_exists(result)) return result;
            if (result) js_free(ctx, result);

            /* Fallback: direct file resolution */
            if (strcmp(subpath, ".") == 0) {
                result = resolve_with_index(ctx, pkg_dir);
            } else {
                char full_path[PATH_MAX];
                snprintf(full_path, sizeof(full_path), "%s/%s", pkg_dir, subpath);
                result = resolve_with_index(ctx, full_path);
            }
            if (result) return result;
        }

        /* Move up one directory */
        if (strcmp(base_dir, "/") == 0 || strcmp(base_dir, ".") == 0) break;
        slash = strrchr(base_dir, '/');
        if (!slash) break;
        if (slash == base_dir) {
            base_dir[1] = '\0'; /* try root once */
        } else {
            *slash = '\0';
        }
    }

    return NULL;
}

/**
 * Helper: prepend embedded:// prefix to a name.
 */
static char *make_embedded_name(JSContext *ctx, const char *name) {
    size_t len = EMBEDDED_PREFIX_LEN + strlen(name) + 1;
    char *result = js_malloc(ctx, len);
    if (result) {
        memcpy(result, EMBEDDED_PREFIX, EMBEDDED_PREFIX_LEN);
        strcpy(result + EMBEDDED_PREFIX_LEN, name);
    }
    return result;
}

/**
 * Get the canonical CWD path (cached).
 */
static const char *get_cached_cwd(void) {
    static char cwd_cache[PATH_MAX];
    static int initialized = 0;
    if (!initialized) {
        if (!getcwd(cwd_cache, sizeof(cwd_cache)))
            cwd_cache[0] = '\0';
        initialized = 1;
    }
    return cwd_cache[0] ? cwd_cache : NULL;
}

/**
 * Resolve a path via realpath, then strip the CWD prefix to avoid
 * leaking build machine absolute paths into compiled output.
 * Falls back to the absolute realpath if the path is outside CWD.
 * Returns NULL if realpath fails.
 */
static char *resolve_compile_realpath(JSContext *ctx, const char *path) {
    char *real = resolve_realpath(ctx, path);
    if (!real) return NULL;

    const char *cwd = get_cached_cwd();
    if (cwd && real[0] == '/') {
        size_t cwd_len = strlen(cwd);
        if (strncmp(real, cwd, cwd_len) == 0 && real[cwd_len] == '/') {
            char *rel = js_strdup(ctx, real + cwd_len + 1);
            js_free(ctx, real);
            return rel;
        }
    }

    return real;
}

/**
 * Resolve a bare import for embedded modules.
 * Checks NODE_PATH canonical resolution first, then node_modules walking.
 * Returns the resolved disk path or NULL.
 */
static char *resolve_bare_to_disk(JSContext *ctx, const char *resolved,
                                  const char *effective_base) {
    if (!is_node_resolution()) {
        char *canonical = resolve_node_path_canonical(ctx, resolved, NULL);
        if (canonical) {
            char *full_path = resolve_node_path(ctx, resolved);
            if (full_path) {
                char *real = resolve_realpath(ctx, full_path);
                js_free(ctx, full_path);
                if (real) {
                    js_free(ctx, canonical);
                    return real;
                }
            }
            js_free(ctx, canonical);
        }
    }

    if (is_filesystem_path(effective_base)) {
        char *nm_resolved = resolve_node_modules(ctx, effective_base, resolved);
        if (nm_resolved) {
            char *real = resolve_realpath(ctx, nm_resolved);
            if (real) {
                js_free(ctx, nm_resolved);
                return real;
            }
            return nm_resolved;
        }
    }

    return NULL;
}

/**
 * Compile-mode normalizer: resolve everything on the filesystem,
 * then prefix the result with embedded://.
 * Records import map entries for runtime replay.
 */
static char *compile_mode_normalize(JSContext *ctx, const char *base_name,
                                    const char *name,
                                    QJSXModuleResolverContext *resolver_ctx) {
    const char *raw_base = has_embedded_prefix(base_name)
        ? base_name + EMBEDDED_PREFIX_LEN : base_name;

    char *translated = translate_colons_to_slashes(ctx, name);
    const char *work_name = translated ? translated : name;

    char *real_base = NULL;
    const char *effective_base = raw_base;
    if (is_filesystem_path(raw_base)) {
        real_base = resolve_realpath(ctx, raw_base);
        if (real_base) effective_base = real_base;
    }

    char *resolved = normalize_module_name(ctx, effective_base, work_name);
    if (translated) js_free(ctx, translated);
    if (!resolved) { if (real_base) js_free(ctx, real_base); return NULL; }

    char *result = NULL;
    int found_on_disk = 0;

    if (!is_filesystem_path(name)) {
        /* Bare import: try NODE_PATH (real filesystem path), then node_modules */
        if (!is_node_resolution()) {
            char *full_path = resolve_node_path(ctx, resolved);
            if (full_path) {
                char *real = resolve_compile_realpath(ctx, full_path);
                if (real) {
                    result = make_embedded_name(ctx, real);
                    js_free(ctx, real);
                } else {
                    result = make_embedded_name(ctx, full_path);
                }
                js_free(ctx, full_path);
                found_on_disk = 1;
            }
        }
        if (!result && is_filesystem_path(effective_base)) {
            char *nm_resolved = resolve_node_modules(ctx, effective_base, resolved);
            if (nm_resolved) {
                char *real = resolve_compile_realpath(ctx, nm_resolved);
                if (real) {
                    result = make_embedded_name(ctx, real);
                    js_free(ctx, real);
                } else {
                    result = make_embedded_name(ctx, nm_resolved);
                }
                js_free(ctx, nm_resolved);
                found_on_disk = 1;
            }
        }
        /* Try resolve_with_index as fallback (matches loader behavior).
           Handles bare imports like "qx/core" → "qx/core.js". */
        if (!result && !is_node_resolution()) {
            char *with_ext = resolve_with_index(ctx, resolved);
            if (with_ext) {
                char *real = resolve_compile_realpath(ctx, with_ext);
                if (real) {
                    result = make_embedded_name(ctx, real);
                    js_free(ctx, real);
                } else {
                    result = make_embedded_name(ctx, with_ext);
                }
                js_free(ctx, with_ext);
                found_on_disk = 1;
            }
        }
        if (!result) {
            /* Not found on disk — likely a C module (std, os, etc.).
               Don't prefix with embedded:// so it keeps its original name. */
            result = js_strdup(ctx, resolved);
        }
    } else {
        /* Relative/absolute path: probe extensions, resolve realpath */
        if (!is_node_resolution()) {
            char *probed = probe_module_with_extensions(ctx, resolved, NULL);
            if (probed) {
                js_free(ctx, resolved);
                resolved = probed;
            }
        }
        char *real = resolve_compile_realpath(ctx, resolved);
        if (real) {
            result = make_embedded_name(ctx, real);
            js_free(ctx, real);
        } else {
            result = make_embedded_name(ctx, resolved);
        }
        found_on_disk = 1;
    }

    /* Record import map for resolutions the runtime can't reproduce:
       bare imports (NODE_PATH, extension probing) and absolute path imports
       (CWD-relativization). Relative imports (./  ../) don't need recording
       since runtime resolves them via path arithmetic on the embedded base. */
    if (found_on_disk && (!is_filesystem_path(name) || name[0] == '/') &&
        resolver_ctx->record_import && result) {
        resolver_ctx->record_import(base_name, name, result);
    }

    if (real_base) js_free(ctx, real_base);
    js_free(ctx, resolved);
    MODULE_DEBUG("compile: (%s, %s) -> %s", base_name, name, result);
    return result;
}

/**
 * QJSX module normalizer - produces canonical module names.
 *
 * Three modes of operation:
 *   1. Interpreter (qjsx): filesystem-only resolution
 *   2. Compiler (qnc): filesystem resolution + embedded:// prefix
 *   3. Runtime standalone: import map + embedded list + disk fallback
 *
 * Embedded modules are prefixed with "embedded://" to separate them from disk
 * modules in QuickJS's single module cache.
 *
 * The "file://" protocol forces disk loading from embedded code.
 */
static char *qjsx_module_normalizer(JSContext *ctx, const char *base_name,
                                    const char *name, void *opaque) {
    QJSXModuleResolverContext *resolver_ctx = (QJSXModuleResolverContext *)opaque;
    const char **embedded_modules = resolver_ctx ? resolver_ctx->embedded_modules : NULL;
    int base_is_embedded = has_embedded_prefix(base_name);

    MODULE_DEBUG("normalize: base='%s' name='%s'", base_name, name);

    /* file:// protocol: strip prefix and force disk resolution */
    if (has_file_prefix(name)) {
        const char *disk_path = name + FILE_PREFIX_LEN;
        MODULE_DEBUG("file:// protocol, disk path: '%s'", disk_path);
        char *real = resolve_realpath(ctx, disk_path);
        if (real) return real;
        return js_strdup(ctx, disk_path);
    }

    /* Compile mode: resolve on filesystem, prefix with embedded:// */
    if (resolver_ctx && resolver_ctx->compile_mode) {
        return compile_mode_normalize(ctx, base_name, name, resolver_ctx);
    }

    /* Runtime import map lookup (standalone binaries):
       if base is embedded and we have a map, check for a recorded resolution */
    if (base_is_embedded && resolver_ctx && resolver_ctx->import_map) {
        const char *mapped = import_map_lookup(
            resolver_ctx->import_map, resolver_ctx->import_map_count,
            base_name, name);
        if (mapped) {
            MODULE_DEBUG("import map hit: (%s, %s) -> %s", base_name, name, mapped);
            return js_strdup(ctx, mapped);
        }
    }

    /* Colon-to-slash translation (e.g., "node:fs" -> "node/fs") */
    char *translated = translate_colons_to_slashes(ctx, name);
    const char *work_name = translated ? translated : name;

    /* For embedded base: strip the prefix for path resolution */
    const char *raw_base = base_is_embedded ? base_name + EMBEDDED_PREFIX_LEN : base_name;

    /* Resolve base_name via realpath for symlink handling.
       Skip for embedded modules (files may not exist on disk at runtime). */
    char *real_base = NULL;
    const char *effective_base = raw_base;

    if (!base_is_embedded && is_filesystem_path(raw_base)) {
        real_base = resolve_realpath(ctx, raw_base);
        if (real_base) {
            MODULE_DEBUG("realpath base: '%s' -> '%s'", raw_base, real_base);
            effective_base = real_base;
        }
    }

    /* Resolve relative paths (handle "./" and "../") */
    char *resolved = normalize_module_name(ctx, effective_base, work_name);

    if (translated)
        js_free(ctx, translated);

    if (!resolved) {
        if (real_base) js_free(ctx, real_base);
        return NULL;
    }

    MODULE_DEBUG("after normalize: '%s'", resolved);

    /* ---- BARE IMPORTS (no leading dot or slash) ---- */
    if (!is_filesystem_path(name)) {
        if (base_is_embedded) {
            /* Embedded importer: check import map with embedded://<input> base
               (handles -D entries and dynamically discovered bare imports) */
            if (resolver_ctx && resolver_ctx->import_map) {
                const char *mapped = import_map_lookup(
                    resolver_ctx->import_map, resolver_ctx->import_map_count,
                    EMBEDDED_PREFIX "<input>", name);
                if (mapped) {
                    if (real_base) js_free(ctx, real_base);
                    js_free(ctx, resolved);
                    MODULE_DEBUG("result (embedded bare via input map): '%s'", mapped);
                    return js_strdup(ctx, mapped);
                }
            }

            /* Bare import not found in embedded — try disk */
            char *disk = resolve_bare_to_disk(ctx, resolved, effective_base);
            if (disk) {
                if (real_base) js_free(ctx, real_base);
                js_free(ctx, resolved);
                MODULE_DEBUG("result (embedded->disk bare): '%s'", disk);
                return disk;
            }

            /* Not found anywhere — return as-is.
               This handles C modules (std, os) which are registered
               at runtime with their plain names. */
            if (real_base) js_free(ctx, real_base);
            MODULE_DEBUG("result (bare, not found): '%s'", resolved);
            return resolved;
        }

        /* Non-embedded importer: check import map with embedded://<input> base
           (allows disk scripts to import embedded modules by bare name) */
        if (resolver_ctx && resolver_ctx->import_map) {
            const char *mapped = import_map_lookup(
                resolver_ctx->import_map, resolver_ctx->import_map_count,
                EMBEDDED_PREFIX "<input>", name);
            if (mapped) {
                if (real_base) js_free(ctx, real_base);
                js_free(ctx, resolved);
                MODULE_DEBUG("result (disk->embedded bare via input map): '%s'", mapped);
                return js_strdup(ctx, mapped);
            }
        }

        /* Disk resolution for bare imports */
        if (!is_node_resolution()) {
            char *canonical = resolve_node_path_canonical(ctx, resolved, NULL);
            if (canonical) {
                char *full_path = resolve_node_path(ctx, resolved);
                if (full_path) {
                    char *real = resolve_realpath(ctx, full_path);
                    if (real) {
                        MODULE_DEBUG("NODE_PATH resolved: '%s' -> '%s'", resolved, real);
                        js_free(ctx, full_path);
                        js_free(ctx, canonical);
                        if (real_base) js_free(ctx, real_base);
                        js_free(ctx, resolved);
                        return real;
                    }
                    js_free(ctx, full_path);
                }
                MODULE_DEBUG("NODE_PATH resolved: '%s' -> '%s'", resolved, canonical);
                if (real_base) js_free(ctx, real_base);
                js_free(ctx, resolved);
                return canonical;
            }
        }

        /* Try node_modules walking */
        if (is_filesystem_path(effective_base)) {
            char *nm_resolved = resolve_node_modules(ctx, effective_base, resolved);
            if (nm_resolved) {
                MODULE_DEBUG("node_modules resolved: '%s' -> '%s'", resolved, nm_resolved);
                if (real_base) js_free(ctx, real_base);
                js_free(ctx, resolved);
                char *real = resolve_realpath(ctx, nm_resolved);
                if (real) {
                    js_free(ctx, nm_resolved);
                    return real;
                }
                return nm_resolved;
            }
        }

        /* Bare import not found — try realpath if it exists on disk */
        if (resolver_ctx && file_exists(resolved)) {
            char *real = resolve_realpath(ctx, resolved);
            if (real) {
                if (real_base) js_free(ctx, real_base);
                js_free(ctx, resolved);
                MODULE_DEBUG("result (bare, realpath): '%s'", real);
                return real;
            }
        }

        if (real_base) js_free(ctx, real_base);
        MODULE_DEBUG("result (bare): '%s'", resolved);
        return resolved;
    }

    /* ---- FILESYSTEM PATHS (relative or absolute) ---- */
    if (real_base) js_free(ctx, real_base);

    if (base_is_embedded) {
        /* Embedded importer with relative/absolute path: check embedded namespace */
        if (!is_node_resolution()) {
            char *probed = probe_module_with_extensions(ctx, resolved, embedded_modules);
            if (probed) {
                MODULE_DEBUG("extension probe (embedded): '%s' -> '%s'", resolved, probed);
                js_free(ctx, resolved);
                resolved = probed;
            }
        }
        if (embedded_modules && embedded_module_exists(embedded_modules, resolved)) {
            char *result = make_embedded_name(ctx, resolved);
            js_free(ctx, resolved);
            MODULE_DEBUG("result (embedded path): '%s'", result);
            return result;
        }
        /* Not found in embedded — fall through to disk resolution */
    }

    /* Disk resolution: probe extensions and resolve via realpath */
    if (!is_node_resolution()) {
        char *probed = probe_module_with_extensions(ctx, resolved, NULL);
        if (probed) {
            MODULE_DEBUG("extension probe: '%s' -> '%s'", resolved, probed);
            js_free(ctx, resolved);
            resolved = probed;
        }
    }

    char *real_result = resolve_realpath(ctx, resolved);
    if (real_result) {
        MODULE_DEBUG("realpath result: '%s' -> '%s'", resolved, real_result);
        js_free(ctx, resolved);
        MODULE_DEBUG("result (filesystem): '%s'", real_result);
        return real_result;
    }

    MODULE_DEBUG("result: '%s'", resolved);
    return resolved;
}

#endif /* QJSX_MODULE_RESOLUTION_H */

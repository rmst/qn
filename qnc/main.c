/*
 * qnc - Qn Compiler
 *
 * Compiles JavaScript modules into standalone C executables with embedded
 * bytecode. Based on QuickJS qjsc by Fabrice Bellard, extended with
 * NODE_PATH module resolution, embedded:// namespace separation, and
 * libuv event loop integration.
 *
 * Copyright (c) 2018-2021 Fabrice Bellard
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
#include <stdlib.h>
#include <stdio.h>
#include <stdarg.h>
#include <inttypes.h>
#include <string.h>
#include <assert.h>
#include <unistd.h>
#include <errno.h>
#include <dirent.h>
#include <sys/stat.h>
#if !defined(_WIN32)
#include <sys/wait.h>
#endif

#include <uv.h>

#include "cutils.h"
#include "quickjs-libc.h"
#include "module_resolution/module-resolution.h"
#include "qnc/embed.h"

/* --- TypeScript transform (isolated runtime) --- */

static JSRuntime *ts_rt;
static JSContext *ts_ctx;
static JSValue ts_fn;
static BOOL ts_available;

static void ts_init(void)
{
    ts_available = FALSE;
    ts_rt = JS_NewRuntime();
    js_std_init_handlers(ts_rt);
    ts_ctx = JS_NewContext(ts_rt);

    static QJSXModuleResolverContext resolver_ctx = {
        .embedded_modules = NULL,
        .import_map = NULL,
        .import_map_count = 0,
        .compile_mode = 0,
        .record_import = NULL,
    };
    JS_SetModuleLoaderFunc2(ts_rt, qjsx_module_normalizer, js_module_loader,
                            NULL, &resolver_ctx);

    static const char script[] =
        "import { stripTypeScriptTypes } from 'node:module'\n"
        "globalThis.__tsTransform = (source, filename) => {\n"
        "  if (!filename.endsWith('.ts')) return source\n"
        "  try { return stripTypeScriptTypes(source) }\n"
        "  catch { return stripTypeScriptTypes(source, { mode: 'transform' }) }\n"
        "}\n";
    JSValue val = JS_Eval(ts_ctx, script, sizeof(script) - 1,
                          "<ts-init>", JS_EVAL_TYPE_MODULE);
    if (!JS_IsException(val)) {
        JS_FreeValue(ts_ctx, val);
        JSContext *ctx1;
        while (JS_ExecutePendingJob(ts_rt, &ctx1) > 0) {}
        JSValue global = JS_GetGlobalObject(ts_ctx);
        ts_fn = JS_GetPropertyStr(ts_ctx, global, "__tsTransform");
        JS_FreeValue(ts_ctx, global);
        if (JS_IsFunction(ts_ctx, ts_fn)) {
            ts_available = TRUE;
        } else {
            JS_FreeValue(ts_ctx, ts_fn);
        }
    } else {
        JS_FreeValue(ts_ctx, JS_GetException(ts_ctx));
    }
}

/* Transform source via the isolated TS runtime.
   Returns a new buffer (allocated with js_malloc on compile_ctx) or the
   original buf unchanged.  On error returns NULL. */
static uint8_t *ts_transform(JSContext *compile_ctx, uint8_t *buf,
                              size_t buf_len, const char *filename,
                              size_t *out_len)
{
    *out_len = buf_len;
    if (!ts_available)
        return buf;

    /* Call transform function in the isolated ts_ctx */
    JSValue args[2];
    args[0] = JS_NewStringLen(ts_ctx, (char *)buf, buf_len);
    args[1] = JS_NewString(ts_ctx, filename);
    JSValue result = JS_Call(ts_ctx, ts_fn, JS_UNDEFINED, 2, args);
    JS_FreeValue(ts_ctx, args[0]);
    JS_FreeValue(ts_ctx, args[1]);
    if (JS_IsException(result)) {
        js_std_dump_error(ts_ctx);
        return NULL;
    }

    /* Extract result string and copy into compile_ctx's allocator */
    size_t new_len;
    const char *str = JS_ToCStringLen(ts_ctx, &new_len, result);
    JS_FreeValue(ts_ctx, result);
    if (!str)
        return NULL;

    uint8_t *new_buf = js_malloc(compile_ctx, new_len + 1);
    if (!new_buf) {
        JS_FreeCString(ts_ctx, str);
        return NULL;
    }
    memcpy(new_buf, str, new_len + 1);
    JS_FreeCString(ts_ctx, str);
    js_free(compile_ctx, buf);
    *out_len = new_len;
    return new_buf;
}

static void ts_free(void)
{
    if (!ts_rt) return;
    if (ts_available)
        JS_FreeValue(ts_ctx, ts_fn);
    js_std_free_handlers(ts_rt);
    JS_FreeContext(ts_ctx);
    JS_FreeRuntime(ts_rt);
    ts_rt = NULL;
    ts_ctx = NULL;
    ts_available = FALSE;
}

/* --- End TypeScript transform --- */

typedef struct {
    char *name;
    char *short_name;
    int flags;
} namelist_entry_t;

typedef struct namelist_t {
    namelist_entry_t *array;
    int count;
    int size;
} namelist_t;

typedef struct {
    const char *option_name;
    const char *init_name;
} FeatureEntry;

static namelist_t cname_list;
static namelist_t cmodule_list;
static namelist_t init_module_list;
static namelist_t embedded_module_names;  /* tracks actual module names for probing (unprefixed) */
static uint64_t feature_bitmap;
static FILE *outfile;
static BOOL byte_swap;

/* Import map recording for compile-time resolution replay at runtime */
typedef struct {
    char *base;
    char *specifier;
    char *resolved;
} ImportMapRecord;

static ImportMapRecord *import_map_records = NULL;
static int import_map_count = 0;
static int import_map_cap = 0;

/* --- Native module embedding via package.json "qnc" field --- */

typedef struct {
    char *target_name;    /* e.g. "sqlite_native" */
    char *init_name;      /* C init function name: "js_init_module_<target_name>" */
    char *reg_name;       /* module registration name (embedded:// prefixed) */
    char **sources;       /* absolute paths to C source files */
    int source_count;
    char **include_dirs;  /* absolute paths to include directories */
    int include_dir_count;
    char **defines;       /* preprocessor definitions */
    int define_count;
    char **cflags;        /* additional compiler flags */
    int cflag_count;
    char **obj_files;     /* paths to compiled .o files (filled during compile step) */
    int obj_count;
} NativeModule;

static NativeModule *native_modules = NULL;
static int native_module_count = 0;
static int native_module_cap = 0;

/* Extra files to pass to the linker (--link flag) */
static namelist_t extra_link_files;

static NativeModule *native_module_add(void) {
    if (native_module_count >= native_module_cap) {
        int new_cap = native_module_cap ? native_module_cap * 2 : 4;
        NativeModule *p = realloc(native_modules, sizeof(NativeModule) * new_cap);
        if (!p) {
            fprintf(stderr, "qnc: out of memory\n");
            exit(1);
        }
        native_modules = p;
        native_module_cap = new_cap;
    }
    NativeModule *nm = &native_modules[native_module_count++];
    memset(nm, 0, sizeof(*nm));
    return nm;
}

/* Helper: parse a JSON string array into a C string array.
   If make_absolute is true, paths are resolved relative to base_dir. */
static int parse_json_string_array(JSContext *ctx, JSValue arr,
                                   const char *base_dir, int make_absolute,
                                   char ***out, int *out_count) {
    if (!JS_IsArray(ctx, arr)) return 0;
    JSValue len_val = JS_GetPropertyStr(ctx, arr, "length");
    int len;
    JS_ToInt32(ctx, &len, len_val);
    JS_FreeValue(ctx, len_val);
    *out = calloc(len, sizeof(char *));
    *out_count = 0;
    for (int i = 0; i < len; i++) {
        JSValue v = JS_GetPropertyUint32(ctx, arr, i);
        const char *s = JS_ToCString(ctx, v);
        if (s) {
            if (make_absolute && base_dir) {
                char abs_path[PATH_MAX];
                snprintf(abs_path, sizeof(abs_path), "%s/%s", base_dir, s);
                (*out)[(*out_count)++] = strdup(abs_path);
            } else {
                (*out)[(*out_count)++] = strdup(s);
            }
            JS_FreeCString(ctx, s);
        }
        JS_FreeValue(ctx, v);
    }
    return len;
}

/* Recursively collect all .c files from a directory into an existing source list.
   Grows the sources array as needed. */
static void collect_c_sources(const char *dir, char ***sources,
                              int *count, int *cap) {
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        if (ent->d_name[0] == '.') continue;
        char path[PATH_MAX];
        snprintf(path, sizeof(path), "%s/%s", dir, ent->d_name);
        struct stat st;
        if (stat(path, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            collect_c_sources(path, sources, count, cap);
        } else if (has_suffix(ent->d_name, ".c")) {
            if (*count >= *cap) {
                *cap = *cap ? *cap * 2 : 64;
                *sources = realloc(*sources, *cap * sizeof(char *));
            }
            (*sources)[(*count)++] = strdup(path);
        }
    }
    closedir(d);
}

/* Parse the "qnc" field from a package.json file.
   Returns 1 on success, 0 if no package.json or no "qnc" field, -1 on error.
   If target_name_match is non-NULL, only succeeds if target_name matches. */
static int parse_native_package(JSContext *ctx, const char *pkg_dir,
                                const char *target_name_match,
                                NativeModule *nm) {
    char pkg_path[PATH_MAX];
    snprintf(pkg_path, sizeof(pkg_path), "%s/package.json", pkg_dir);

    size_t buf_len;
    uint8_t *buf = js_load_file(ctx, &buf_len, pkg_path);
    if (!buf) return 0;

    JSValue pkg = JS_ParseJSON(ctx, (char *)buf, buf_len, pkg_path);
    js_free(ctx, buf);
    if (JS_IsException(pkg)) {
        JSValue ex = JS_GetException(ctx);
        JS_FreeValue(ctx, ex);
        fprintf(stderr, "qnc: failed to parse %s\n", pkg_path);
        return -1;
    }

    JSValue qnc_val = JS_GetPropertyStr(ctx, pkg, "qnc");
    if (JS_IsUndefined(qnc_val) || JS_IsNull(qnc_val)) {
        JS_FreeValue(ctx, qnc_val);
        JS_FreeValue(ctx, pkg);
        return 0;
    }

    /* Read target_name */
    JSValue tn_val = JS_GetPropertyStr(ctx, qnc_val, "target_name");
    const char *tn = JS_ToCString(ctx, tn_val);
    if (!tn) {
        JS_FreeValue(ctx, tn_val);
        JS_FreeValue(ctx, qnc_val);
        JS_FreeValue(ctx, pkg);
        fprintf(stderr, "qnc: package.json \"qnc\" missing \"target_name\" in %s\n", pkg_path);
        return -1;
    }
    if (target_name_match && strcmp(tn, target_name_match) != 0) {
        JS_FreeCString(ctx, tn);
        JS_FreeValue(ctx, tn_val);
        JS_FreeValue(ctx, qnc_val);
        JS_FreeValue(ctx, pkg);
        return 0;
    }

    nm->target_name = strdup(tn);
    JS_FreeCString(ctx, tn);
    JS_FreeValue(ctx, tn_val);

    /* Build init function name */
    char init_name[256];
    snprintf(init_name, sizeof(init_name), "js_init_module_%s", nm->target_name);
    nm->init_name = strdup(init_name);

    /* Parse arrays */
    JSValue srcs = JS_GetPropertyStr(ctx, qnc_val, "sources");
    parse_json_string_array(ctx, srcs, pkg_dir, 1, &nm->sources, &nm->source_count);
    JS_FreeValue(ctx, srcs);

    /* Parse source_dirs: walk directories recursively, collect all .c files */
    JSValue sdirs = JS_GetPropertyStr(ctx, qnc_val, "source_dirs");
    if (JS_IsArray(ctx, sdirs)) {
        JSValue sdlen_val = JS_GetPropertyStr(ctx, sdirs, "length");
        int sdlen;
        JS_ToInt32(ctx, &sdlen, sdlen_val);
        JS_FreeValue(ctx, sdlen_val);
        int cap = nm->source_count ? nm->source_count * 2 : 64;
        if (nm->sources)
            nm->sources = realloc(nm->sources, cap * sizeof(char *));
        else
            nm->sources = calloc(cap, sizeof(char *));
        for (int i = 0; i < sdlen; i++) {
            JSValue sv = JS_GetPropertyUint32(ctx, sdirs, i);
            const char *s = JS_ToCString(ctx, sv);
            if (s) {
                char abs_dir[PATH_MAX];
                snprintf(abs_dir, sizeof(abs_dir), "%s/%s", pkg_dir, s);
                collect_c_sources(abs_dir, &nm->sources, &nm->source_count, &cap);
                JS_FreeCString(ctx, s);
            }
            JS_FreeValue(ctx, sv);
        }
    }
    JS_FreeValue(ctx, sdirs);

    JSValue incs = JS_GetPropertyStr(ctx, qnc_val, "include_dirs");
    parse_json_string_array(ctx, incs, pkg_dir, 1, &nm->include_dirs, &nm->include_dir_count);
    JS_FreeValue(ctx, incs);

    JSValue defs = JS_GetPropertyStr(ctx, qnc_val, "defines");
    parse_json_string_array(ctx, defs, NULL, 0, &nm->defines, &nm->define_count);
    JS_FreeValue(ctx, defs);

    JSValue cfs = JS_GetPropertyStr(ctx, qnc_val, "cflags");
    parse_json_string_array(ctx, cfs, NULL, 0, &nm->cflags, &nm->cflag_count);
    JS_FreeValue(ctx, cfs);

    JS_FreeValue(ctx, qnc_val);
    JS_FreeValue(ctx, pkg);
    return 1;
}

#if defined(CONFIG_CC) && !defined(_WIN32)
/* Forward declaration (defined later) */
int exec_cmd(char **argv);

/*
 * Resolve the support directory containing headers and libraries.
 * Tries in order:
 *   1. Directory containing the qnc executable (quickjs.h next to binary)
 *   2. Embedded files appended to the qnc binary (extracted to tmpdir)
 *   3. System prefix ($PREFIX/include/quickjs)
 *
 * Sets inc_dir and lib_dir. If embedded files were extracted, returns
 * the tmpdir path (caller must clean up). Otherwise returns NULL.
 */
static char *resolve_support_dir(const char *exename,
                                 char *inc_dir, size_t inc_size,
                                 char *lib_dir, size_t lib_size) {
    char exe_dir[1024], buf[1024], *p;

    /* Get the directory of the executable */
    pstrcpy(exe_dir, sizeof(exe_dir), exename);
    p = strrchr(exe_dir, '/');
    if (p) *p = '\0';
    else pstrcpy(exe_dir, sizeof(exe_dir), ".");

    /* Try 1: files next to the executable */
    snprintf(buf, sizeof(buf), "%s/quickjs.h", exe_dir);
    if (access(buf, R_OK) == 0) {
        pstrcpy(inc_dir, inc_size, exe_dir);
        pstrcpy(lib_dir, lib_size, exe_dir);
        return NULL;
    }

    /* Try 2: embedded files in the binary itself */
    char exe_path[4096];
    size_t exe_path_size = sizeof(exe_path);
    if (uv_exepath(exe_path, &exe_path_size) == 0) {
        char *tmpdir = qnc_embed_extract(exe_path);
        if (tmpdir) {
            snprintf(buf, sizeof(buf), "%s/quickjs.h", tmpdir);
            if (access(buf, R_OK) == 0) {
                pstrcpy(inc_dir, inc_size, tmpdir);
                pstrcpy(lib_dir, lib_size, tmpdir);
                return tmpdir;
            }
            qnc_embed_cleanup(tmpdir);
            free(tmpdir);
        }
    }

    /* Try 3: system prefix */
    snprintf(inc_dir, inc_size, "%s/include/quickjs", CONFIG_PREFIX);
    snprintf(lib_dir, lib_size, "%s/lib/quickjs", CONFIG_PREFIX);
    return NULL;
}

/* Compile native module C sources to .o files.
   Returns 0 on success, non-zero on error. */
static int compile_native_modules(const char *inc_dir, BOOL verbose) {

    for (int mi = 0; mi < native_module_count; mi++) {
        NativeModule *nm = &native_modules[mi];
        nm->obj_files = calloc(nm->source_count, sizeof(char *));
        nm->obj_count = 0;

        for (int si = 0; si < nm->source_count; si++) {
            /* Generate unique .o filename in /tmp */
            char obj_path[PATH_MAX];
            snprintf(obj_path, sizeof(obj_path), "/tmp/qnc_%d_%s_%d.o",
                     getpid(), nm->target_name, si);

            /* Build gcc command */
            const char *argv[128];
            const char **arg = argv;
            *arg++ = CONFIG_CC;
            *arg++ = "-O2";
            *arg++ = "-D_GNU_SOURCE";
            *arg++ = "-I";
            *arg++ = inc_dir;

            /* Rename js_init_module to unique name */
            char rename_def[512];
            snprintf(rename_def, sizeof(rename_def),
                     "js_init_module=%s", nm->init_name);
            *arg++ = "-D";
            *arg++ = rename_def;

            /* Add package-specific include dirs */
            for (int ii = 0; ii < nm->include_dir_count; ii++) {
                *arg++ = "-I";
                *arg++ = nm->include_dirs[ii];
            }

            /* Add package-specific defines (reuse define strings with -D prefix) */
            char def_bufs[32][256];
            for (int di = 0; di < nm->define_count && di < 32; di++) {
                snprintf(def_bufs[di], sizeof(def_bufs[di]), "-D%s", nm->defines[di]);
                *arg++ = def_bufs[di];
            }

            /* Add package-specific cflags */
            for (int ci = 0; ci < nm->cflag_count; ci++) {
                *arg++ = nm->cflags[ci];
            }

            *arg++ = "-c";
            *arg++ = "-o";
            *arg++ = obj_path;
            *arg++ = nm->sources[si];
            *arg = NULL;

            if (verbose) {
                for (const char **a = argv; *a; a++)
                    printf("%s ", *a);
                printf("\n");
            }

            int ret = exec_cmd((char **)argv);
            if (ret != 0) {
                fprintf(stderr, "qnc: failed to compile native module source '%s'\n",
                        nm->sources[si]);
                return ret;
            }

            nm->obj_files[nm->obj_count++] = strdup(obj_path);
        }
    }
    return 0;
}
#endif /* CONFIG_CC */

static void record_import(const char *base, const char *specifier, const char *resolved) {
    if (import_map_count >= import_map_cap) {
        int new_cap = import_map_cap ? import_map_cap * 2 : 64;
        ImportMapRecord *p = realloc(import_map_records,
                                     sizeof(ImportMapRecord) * new_cap);
        if (!p) {
            fprintf(stderr, "qnc: out of memory recording imports\n");
            exit(1);
        }
        import_map_records = p;
        import_map_cap = new_cap;
    }
    import_map_records[import_map_count].base = strdup(base);
    import_map_records[import_map_count].specifier = strdup(specifier);
    import_map_records[import_map_count].resolved = strdup(resolved);
    import_map_count++;
}

static QJSXModuleResolverContext compile_resolver_ctx = {
    .embedded_modules = NULL,
    .import_map = NULL,
    .import_map_count = 0,
    .compile_mode = 1,
    .record_import = record_import,
};
static const char *c_ident_prefix = "qjsc_";

#define FE_ALL (-1)

static const FeatureEntry feature_list[] = {
    { "date", "Date" },
    { "eval", "Eval" },
    { "string-normalize", "StringNormalize" },
    { "regexp", "RegExp" },
    { "json", "JSON" },
    { "proxy", "Proxy" },
    { "map", "MapSet" },
    { "typedarray", "TypedArrays" },
    { "promise", "Promise" },
#define FE_MODULE_LOADER 9
    { "module-loader", NULL },
    { "weakref", "WeakRef" },
};

void namelist_add(namelist_t *lp, const char *name, const char *short_name,
                  int flags)
{
    namelist_entry_t *e;
    if (lp->count == lp->size) {
        size_t newsize = lp->size + (lp->size >> 1) + 4;
        namelist_entry_t *a =
            realloc(lp->array, sizeof(lp->array[0]) * newsize);
        if (!a) {
            fprintf(stderr, "qnc: out of memory\n");
            exit(1);
        }
        lp->array = a;
        lp->size = newsize;
    }
    e =  &lp->array[lp->count++];
    e->name = strdup(name);
    if (short_name)
        e->short_name = strdup(short_name);
    else
        e->short_name = NULL;
    e->flags = flags;
}

void namelist_free(namelist_t *lp)
{
    while (lp->count > 0) {
        namelist_entry_t *e = &lp->array[--lp->count];
        free(e->name);
        free(e->short_name);
    }
    free(lp->array);
    lp->array = NULL;
    lp->size = 0;
}

namelist_entry_t *namelist_find(namelist_t *lp, const char *name)
{
    int i;
    for(i = 0; i < lp->count; i++) {
        namelist_entry_t *e = &lp->array[i];
        if (!strcmp(e->name, name))
            return e;
    }
    return NULL;
}

static void get_c_name(char *buf, size_t buf_size, const char *file)
{
    const char *p, *r;
    size_t len, i;
    int c;
    char *q;

    p = strrchr(file, '/');
    if (!p)
        p = file;
    else
        p++;
    r = strrchr(p, '.');
    if (!r)
        len = strlen(p);
    else
        len = r - p;
    pstrcpy(buf, buf_size, c_ident_prefix);
    q = buf + strlen(buf);
    for(i = 0; i < len; i++) {
        c = p[i];
        if (!((c >= '0' && c <= '9') ||
              (c >= 'A' && c <= 'Z') ||
              (c >= 'a' && c <= 'z'))) {
            c = '_';
        }
        if ((q - buf) < buf_size - 1)
            *q++ = c;
    }
    *q = '\0';
}

static void dump_hex(FILE *f, const uint8_t *buf, size_t len)
{
    size_t i, col;
    col = 0;
    for(i = 0; i < len; i++) {
        fprintf(f, " 0x%02x,", buf[i]);
        if (++col == 8) {
            fprintf(f, "\n");
            col = 0;
        }
    }
    if (col != 0)
        fprintf(f, "\n");
}

typedef enum {
    CNAME_TYPE_SCRIPT,
    CNAME_TYPE_MODULE,
    CNAME_TYPE_JSON_MODULE,
} CNameTypeEnum;

static void output_object_code(JSContext *ctx,
                               FILE *fo, JSValueConst obj, const char *c_name,
                               CNameTypeEnum c_name_type)
{
    uint8_t *out_buf;
    size_t out_buf_len;
    int flags;

    if (c_name_type == CNAME_TYPE_JSON_MODULE)
        flags = 0;
    else
        flags = JS_WRITE_OBJ_BYTECODE;
    if (byte_swap)
        flags |= JS_WRITE_OBJ_BSWAP;
    out_buf = JS_WriteObject(ctx, &out_buf_len, obj, flags);
    if (!out_buf) {
        js_std_dump_error(ctx);
        exit(1);
    }

    namelist_add(&cname_list, c_name, NULL, c_name_type);

    fprintf(fo, "const uint32_t %s_size = %u;\n\n",
            c_name, (unsigned int)out_buf_len);
    fprintf(fo, "const uint8_t %s[%u] = {\n",
            c_name, (unsigned int)out_buf_len);
    dump_hex(fo, out_buf, out_buf_len);
    fprintf(fo, "};\n\n");

    js_free(ctx, out_buf);
}

static int js_module_dummy_init(JSContext *ctx, JSModuleDef *m)
{
    /* should never be called when compiling JS code */
    abort();
}

static void find_unique_cname(char *cname, size_t cname_size)
{
    char cname1[1024];
    int suffix_num;
    size_t len, max_len;
    assert(cname_size >= 32);
    /* find a C name not matching an existing module C name by
       adding a numeric suffix */
    len = strlen(cname);
    max_len = cname_size - 16;
    if (len > max_len)
        cname[max_len] = '\0';
    suffix_num = 1;
    for(;;) {
        snprintf(cname1, sizeof(cname1), "%s_%d", cname, suffix_num);
        if (!namelist_find(&cname_list, cname1))
            break;
        suffix_num++;
    }
    pstrcpy(cname, cname_size, cname1);
}

JSModuleDef *jsc_module_loader(JSContext *ctx,
                               const char *module_name, void *opaque,
                               JSValueConst attributes)
{
    JSModuleDef *m;
    namelist_entry_t *e;

    /* module_name is already normalized by qjsx_module_normalizer (called by QuickJS).
       In compile mode, it will have an embedded:// prefix for file modules. */
    const char *reg_name = module_name;
    /* Strip embedded:// for disk file loading; keep prefix for module registration */
    const char *disk_name = has_embedded_prefix(reg_name)
        ? reg_name + EMBEDDED_PREFIX_LEN : reg_name;

    /* check if it is a declared C or system module */
    e = namelist_find(&cmodule_list, disk_name);
    if (e) {
        /* add in the static init module list */
        namelist_add(&init_module_list, e->name, e->short_name, 0);
        /* create a dummy module */
        m = JS_NewCModule(ctx, reg_name, js_module_dummy_init);
    } else if (has_suffix(disk_name, ".so")) {
        /* Native module: try to find package.json with "qnc" field for static embedding */
        char so_dir[PATH_MAX];
        pstrcpy(so_dir, sizeof(so_dir), disk_name);
        char *slash = strrchr(so_dir, '/');
        if (slash) *slash = '\0';
        else pstrcpy(so_dir, sizeof(so_dir), ".");

        /* Extract target name from .so filename (e.g. "sqlite_native" from "sqlite_native.so") */
        const char *so_basename = slash ? slash + 1 : disk_name;
        char so_target[256];
        pstrcpy(so_target, sizeof(so_target), so_basename);
        char *dot = strrchr(so_target, '.');
        if (dot) *dot = '\0';

        NativeModule *nm = native_module_add();
        int pkg_ret = parse_native_package(ctx, so_dir, so_target, nm);
        if (pkg_ret > 0) {
            /* Found package.json with matching "qnc" config */
            nm->reg_name = strdup(reg_name);

            /* Register like -M: add to init_module_list for codegen.
               short_name is the target_name since the codegen template
               already prepends "js_init_module_" */
            namelist_add(&init_module_list, reg_name, nm->target_name, 0);

            /* Track as embedded module */
            if (!namelist_find(&embedded_module_names, disk_name)) {
                namelist_add(&embedded_module_names, disk_name, NULL, 0);
            }

            m = JS_NewCModule(ctx, reg_name, js_module_dummy_init);
        } else {
            /* No package.json "qnc" field — fall back to dynamic loading warning */
            native_module_count--;  /* undo the add */
            fprintf(stderr, "Warning: binary module '%s' will be dynamically loaded\n", disk_name);
            m = JS_NewCModule(ctx, reg_name, js_module_dummy_init);
        }
    } else {
        size_t buf_len;
        uint8_t *buf;
        char cname[1024];
        int res;
        /* Use disk_name (no embedded:// prefix) for file loading */
        const char *resolved_name = disk_name;
        char *qjsxpath_resolved = NULL;
        char *index_resolved = NULL;

        if (disk_name[0] != '.' && disk_name[0] != '/') {
            qjsxpath_resolved = resolve_node_path(ctx, disk_name);
            if (qjsxpath_resolved) {
                resolved_name = qjsxpath_resolved;
            }
        }

        if (!qjsxpath_resolved) {
            index_resolved = resolve_with_index(ctx, disk_name);
            if (index_resolved) {
                resolved_name = index_resolved;
            }
        }

        buf = js_load_file(ctx, &buf_len, resolved_name);
        if (!buf) {
            if (qjsxpath_resolved) js_free(ctx, qjsxpath_resolved);
            if (index_resolved) js_free(ctx, index_resolved);
            JS_ThrowReferenceError(ctx, "could not load module filename '%s'",
                                   module_name);
            return NULL;
        }

        /* Apply source transform (e.g. TypeScript stripping) */
        buf = ts_transform(ctx, buf, buf_len, resolved_name, &buf_len);
        if (!buf) {
            if (qjsxpath_resolved) js_free(ctx, qjsxpath_resolved);
            if (index_resolved) js_free(ctx, index_resolved);
            return NULL;
        }

        res = js_module_test_json(ctx, attributes);
        if (has_suffix(disk_name, ".json") || res > 0) {
            /* compile as JSON or JSON5 depending on "type" */
            JSValue val;
            int flags;

            if (res == 2)
                flags = JS_PARSE_JSON_EXT;
            else
                flags = 0;
            val = JS_ParseJSON2(ctx, (char *)buf, buf_len, reg_name, flags);
            js_free(ctx, buf);
            if (JS_IsException(val)) {
                if (qjsxpath_resolved) js_free(ctx, qjsxpath_resolved);
                if (index_resolved) js_free(ctx, index_resolved);
                return NULL;
            }
            m = JS_NewCModule(ctx, reg_name, js_module_dummy_init);
            if (!m) {
                JS_FreeValue(ctx, val);
                if (qjsxpath_resolved) js_free(ctx, qjsxpath_resolved);
                if (index_resolved) js_free(ctx, index_resolved);
                return NULL;
            }

            get_c_name(cname, sizeof(cname), disk_name);
            if (namelist_find(&cname_list, cname)) {
                find_unique_cname(cname, sizeof(cname));
            }

            /* output the module name */
            fprintf(outfile, "static const uint8_t %s_module_name[] = {\n",
                    cname);
            dump_hex(outfile, (const uint8_t *)reg_name, strlen(reg_name) + 1);
            fprintf(outfile, "};\n\n");

            output_object_code(ctx, outfile, val, cname, CNAME_TYPE_JSON_MODULE);
            /* Track module name WITHOUT prefix (for runtime embedded list) */
            if (!namelist_find(&embedded_module_names, disk_name)) {
                namelist_add(&embedded_module_names, disk_name, NULL, 0);
            }
            JS_FreeValue(ctx, val);
        } else {
            JSValue func_val;

            /* Compile the module. reg_name (with embedded:// prefix) becomes
               the module name stored in bytecode. */
            func_val = JS_Eval(ctx, (char *)buf, buf_len, reg_name,
                               JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
            js_free(ctx, buf);
            if (JS_IsException(func_val)) {
                if (qjsxpath_resolved) js_free(ctx, qjsxpath_resolved);
                if (index_resolved) js_free(ctx, index_resolved);
                return NULL;
            }
            get_c_name(cname, sizeof(cname), disk_name);
            if (namelist_find(&cname_list, cname)) {
                find_unique_cname(cname, sizeof(cname));
            }
            output_object_code(ctx, outfile, func_val, cname, CNAME_TYPE_MODULE);
            /* Track module name WITHOUT prefix (for runtime embedded list) */
            if (!namelist_find(&embedded_module_names, disk_name)) {
                namelist_add(&embedded_module_names, disk_name, NULL, 0);
            }

            m = JS_VALUE_GET_PTR(func_val);
            JS_FreeValue(ctx, func_val);
        }
        if (qjsxpath_resolved) js_free(ctx, qjsxpath_resolved);
        if (index_resolved) js_free(ctx, index_resolved);
    }
    return m;
}

static void compile_file(JSContext *ctx, FILE *fo,
                         const char *filename,
                         const char *c_name1,
                         int module)
{
    uint8_t *buf;
    char c_name[1024];
    int eval_flags;
    JSValue obj;
    size_t buf_len;

    buf = js_load_file(ctx, &buf_len, filename);
    if (!buf) {
        fprintf(stderr, "Could not load '%s'\n", filename);
        exit(1);
    }
    /* Apply source transform (e.g. TypeScript stripping) */
    buf = ts_transform(ctx, buf, buf_len, filename, &buf_len);
    if (!buf) {
        js_std_dump_error(ctx);
        exit(1);
    }
    eval_flags = JS_EVAL_FLAG_COMPILE_ONLY;
    if (module < 0) {
        module = (has_suffix(filename, ".mjs") ||
                  has_suffix(filename, ".ts") ||
                  JS_DetectModule((const char *)buf, buf_len));
    }
    if (module)
        eval_flags |= JS_EVAL_TYPE_MODULE;
    else
        eval_flags |= JS_EVAL_TYPE_GLOBAL;
    /* For modules, resolve symlinks and prefix with embedded:// so the module
       name in bytecode uses the canonical path (matching runtime resolution). */
    char embedded_filename[PATH_MAX + EMBEDDED_PREFIX_LEN + 1];
    char real_filename[PATH_MAX];
    const char *eval_name = filename;
    if (module) {
        const char *canonical = filename;
        if (realpath(filename, real_filename)) {
            canonical = real_filename;
            const char *cwd = get_cached_cwd();
            if (cwd) {
                size_t cwd_len = strlen(cwd);
                if (strncmp(real_filename, cwd, cwd_len) == 0 &&
                    real_filename[cwd_len] == '/')
                    canonical = real_filename + cwd_len + 1;
            }
        }
        snprintf(embedded_filename, sizeof(embedded_filename),
                 EMBEDDED_PREFIX "%s", canonical);
        eval_name = embedded_filename;
    }

    obj = JS_Eval(ctx, (const char *)buf, buf_len, eval_name, eval_flags);
    if (JS_IsException(obj)) {
        js_std_dump_error(ctx);
        exit(1);
    }
    js_free(ctx, buf);
    if (c_name1) {
        pstrcpy(c_name, sizeof(c_name), c_name1);
    } else {
        get_c_name(c_name, sizeof(c_name), filename);
        if (namelist_find(&cname_list, c_name)) {
            find_unique_cname(c_name, sizeof(c_name));
        }
    }
    output_object_code(ctx, fo, obj, c_name, CNAME_TYPE_SCRIPT);
    JS_FreeValue(ctx, obj);
}

static const char main_c_template1[] =
    "int main(int argc, char **argv)\n"
    "{\n"
    "  JSRuntime *rt;\n"
    "  JSContext *ctx;\n"
    "  rt = JS_NewRuntime();\n"
    "  js_std_set_worker_new_context_func(JS_NewCustomContext);\n"
    "  js_std_init_handlers(rt);\n"
    ;

#define PROG_NAME "qnc"

void help(void)
{
    printf("QuickJS Compiler version " CONFIG_VERSION "\n"
           "usage: " PROG_NAME " [options] [files]\n"
           "\n"
           "options are:\n"
           "-c          only output bytecode to a C file\n"
           "-e          output main() and bytecode to a C file (default = executable output)\n"
           "-o output   set the output filename\n"
           "-N cname    set the C name of the generated data\n"
           "-m          compile as Javascript module (default=autodetect)\n"
           "-D module_name         compile a dynamically loaded module or worker\n"
           "-M module_name[,cname] add initialization code for an external C module\n"
           "-x          byte swapped output\n"
           "-p prefix   set the prefix of the generated C names\n"
           "-S n        set the maximum stack size to 'n' bytes (default=%d)\n"
           "-s            strip all the debug info\n"
           "--keep-source keep the source code\n"
           "--link file   pass file (.o/.a) to the linker\n",
           JS_DEFAULT_STACK_SIZE);
#ifdef CONFIG_LTO
    {
        int i;
        printf("-flto       use link time optimization\n");
        printf("-fno-[");
        for(i = 0; i < countof(feature_list); i++) {
            if (i != 0)
                printf("|");
            printf("%s", feature_list[i].option_name);
        }
        printf("]\n"
               "            disable selected language features (smaller code size)\n");
    }
#endif
    exit(1);
}

#if defined(CONFIG_CC) && !defined(_WIN32)

int exec_cmd(char **argv)
{
    int pid, status, ret;

    pid = fork();
    if (pid == 0) {
        execvp(argv[0], argv);
        exit(1);
    }

    for(;;) {
        ret = waitpid(pid, &status, 0);
        if (ret == pid && WIFEXITED(status))
            break;
    }
    return WEXITSTATUS(status);
}

static int output_executable(const char *out_filename, const char *cfilename,
                             BOOL use_lto, BOOL verbose, const char *exename)
{
    /* Resolve support directory (headers + libraries) */
    char inc_dir[1024], lib_dir[1024];
    char *embed_tmpdir = resolve_support_dir(exename, inc_dir, sizeof(inc_dir),
                                             lib_dir, sizeof(lib_dir));

    /* Max argv slots: base args + native module .o files + extra link files */
    int total_sources = 0;
    for (int mi = 0; mi < native_module_count; mi++)
        total_sources += native_modules[mi].source_count;
    int max_argv = 64 + total_sources + extra_link_files.count;
    const char **argv = malloc(sizeof(const char *) * max_argv);
    const char **arg, *bn_suffix, *lto_suffix;
    char libjsname[1024];
    char libuvname[1024];
    int ret;

    /* Compile native module C sources to .o files */
    if (native_module_count > 0) {
        ret = compile_native_modules(inc_dir, verbose);
        if (ret != 0) {
            free(argv);
            qnc_embed_cleanup(embed_tmpdir);
            free(embed_tmpdir);
            return ret;
        }
    }

    lto_suffix = "";
    bn_suffix = "";

    arg = argv;
    *arg++ = CONFIG_CC;
    *arg++ = "-O2";
#ifdef CONFIG_LTO
    if (use_lto) {
        *arg++ = "-flto";
        lto_suffix = ".lto";
    }
#endif
    *arg++ = "-D";
    *arg++ = "_GNU_SOURCE";
    *arg++ = "-I";
    *arg++ = inc_dir;
    *arg++ = "-o";
    *arg++ = out_filename;
    /* Export symbols so dlopen'd .so modules can resolve QuickJS/libuv symbols
       back from the host binary at runtime */
    *arg++ = "-rdynamic";
    *arg++ = cfilename;

    /* Add native module .o files */
    for (int mi = 0; mi < native_module_count; mi++) {
        NativeModule *nm = &native_modules[mi];
        for (int oi = 0; oi < nm->obj_count; oi++) {
            *arg++ = nm->obj_files[oi];
        }
    }

    /* Add extra link files (--link flag) */
    for (int li = 0; li < extra_link_files.count; li++) {
        *arg++ = extra_link_files.array[li].name;
    }

    snprintf(libjsname, sizeof(libjsname), "%s/libquickjs%s%s.a",
             lib_dir, bn_suffix, lto_suffix);
    *arg++ = libjsname;
    snprintf(libuvname, sizeof(libuvname), "%s/libuv.a", lib_dir);
    *arg++ = libuvname;
    *arg++ = "-lm";
    *arg++ = "-ldl";
    *arg++ = "-lpthread";
#ifdef __linux__
    *arg++ = "-lrt";
#endif
    *arg = NULL;

    if (verbose) {
        for(arg = argv; *arg != NULL; arg++)
            printf("%s ", *arg);
        printf("\n");
    }

    ret = exec_cmd((char **)argv);
    unlink(cfilename);

    /* Clean up native module .o files */
    for (int mi = 0; mi < native_module_count; mi++) {
        NativeModule *nm = &native_modules[mi];
        for (int oi = 0; oi < nm->obj_count; oi++) {
            unlink(nm->obj_files[oi]);
        }
    }

    /* Clean up embedded tmpdir if we extracted one */
    qnc_embed_cleanup(embed_tmpdir);
    free(embed_tmpdir);

    free(argv);
    return ret;
}
#else
static int output_executable(const char *out_filename, const char *cfilename,
                             BOOL use_lto, BOOL verbose, const char *exename)
{
    fprintf(stderr, "Executable output is not supported for this target\n");
    exit(1);
    return 0;
}
#endif

static size_t get_suffixed_size(const char *str)
{
    char *p;
    size_t v;
    v = (size_t)strtod(str, &p);
    switch(*p) {
    case 'G':
        v <<= 30;
        break;
    case 'M':
        v <<= 20;
        break;
    case 'k':
    case 'K':
        v <<= 10;
        break;
    default:
        if (*p != '\0') {
            fprintf(stderr, "qjs: invalid suffix: %s\n", p);
            exit(1);
        }
        break;
    }
    return v;
}

typedef enum {
    OUTPUT_C,
    OUTPUT_C_MAIN,
    OUTPUT_EXECUTABLE,
} OutputTypeEnum;

static const char *get_short_optarg(int *poptind, int opt,
                                    const char *arg, int argc, char **argv)
{
    const char *optarg;
    if (*arg) {
        optarg = arg;
    } else if (*poptind < argc) {
        optarg = argv[(*poptind)++];
    } else {
        fprintf(stderr, "qjsc: expecting parameter for -%c\n", opt);
        exit(1);
    }
    return optarg;
}

int main(int argc, char **argv)
{
    int i, verbose, strip_flags;
    const char *out_filename, *cname;
    char cfilename[1024];
    FILE *fo;
    JSRuntime *rt;
    JSContext *ctx;
    BOOL use_lto;
    int module;
    OutputTypeEnum output_type;
    size_t stack_size;
    namelist_t dynamic_module_list;

    out_filename = NULL;
    output_type = OUTPUT_EXECUTABLE;
    cname = NULL;
    feature_bitmap = FE_ALL;
    module = -1;
    byte_swap = FALSE;
    verbose = 0;
    strip_flags = JS_STRIP_SOURCE;
    use_lto = FALSE;
    stack_size = 0;
    memset(&dynamic_module_list, 0, sizeof(dynamic_module_list));
    memset(&extra_link_files, 0, sizeof(extra_link_files));

    /* add system modules */
    namelist_add(&cmodule_list, "std", "std", 0);
    namelist_add(&cmodule_list, "os", "os", 0);

    optind = 1;
    while (optind < argc && *argv[optind] == '-') {
        char *arg = argv[optind] + 1;
        const char *longopt = "";
        const char *optarg;
        /* a single - is not an option, it also stops argument scanning */
        if (!*arg)
            break;
        optind++;
        if (*arg == '-') {
            longopt = arg + 1;
            arg += strlen(arg);
            /* -- stops argument scanning */
            if (!*longopt)
                break;
        }
        for (; *arg || *longopt; longopt = "") {
            char opt = *arg;
            if (opt)
                arg++;
            if (opt == 'h' || opt == '?' || !strcmp(longopt, "help")) {
                help();
                continue;
            }
            if (opt == 'o') {
                out_filename = get_short_optarg(&optind, opt, arg, argc, argv);
                break;
            }
            if (opt == 'c') {
                output_type = OUTPUT_C;
                continue;
            }
            if (opt == 'e') {
                output_type = OUTPUT_C_MAIN;
                continue;
            }
            if (opt == 'N') {
                cname = get_short_optarg(&optind, opt, arg, argc, argv);
                break;
            }
            if (opt == 'f') {
                const char *p;
                optarg = get_short_optarg(&optind, opt, arg, argc, argv);
                p = optarg;
                if (!strcmp(p, "lto")) {
                    use_lto = TRUE;
                } else if (strstart(p, "no-", &p)) {
                    use_lto = TRUE;
                    for(i = 0; i < countof(feature_list); i++) {
                        if (!strcmp(p, feature_list[i].option_name)) {
                            feature_bitmap &= ~((uint64_t)1 << i);
                            break;
                        }
                    }
                    if (i == countof(feature_list))
                        goto bad_feature;
                } else {
                bad_feature:
                    fprintf(stderr, "unsupported feature: %s\n", optarg);
                    exit(1);
                }
                break;
            }
            if (opt == 'm') {
                module = 1;
                continue;
            }
            if (opt == 'M') {
                char *p;
                char path[1024];
                char cname[1024];

                optarg = get_short_optarg(&optind, opt, arg, argc, argv);
                pstrcpy(path, sizeof(path), optarg);
                p = strchr(path, ',');
                if (p) {
                    *p = '\0';
                    pstrcpy(cname, sizeof(cname), p + 1);
                } else {
                    get_c_name(cname, sizeof(cname), path);
                }
                namelist_add(&cmodule_list, path, cname, 0);
                break;
            }
            if (opt == 'D') {
                optarg = get_short_optarg(&optind, opt, arg, argc, argv);
                namelist_add(&dynamic_module_list, optarg, NULL, 0);
                break;
            }
            if (opt == 'x') {
                byte_swap = 1;
                continue;
            }
            if (opt == 'v') {
                verbose++;
                continue;
            }
            if (opt == 'p') {
                c_ident_prefix = get_short_optarg(&optind, opt, arg, argc, argv);
                break;
            }
            if (opt == 'S') {
                optarg = get_short_optarg(&optind, opt, arg, argc, argv);
                stack_size = get_suffixed_size(optarg);
                break;
            }
            if (opt == 's') {
                strip_flags = JS_STRIP_DEBUG;
                continue;
            }
            if (!strcmp(longopt, "keep-source")) {
                strip_flags = 0;
                continue;
            }
            if (!strcmp(longopt, "link")) {
                const char *link_file = get_short_optarg(&optind, 0, "", argc, argv);
                namelist_add(&extra_link_files, link_file, NULL, 0);
                break;
            }
            if (opt) {
                fprintf(stderr, "qjsc: unknown option '-%c'\n", opt);
            } else {
                fprintf(stderr, "qjsc: unknown option '--%s'\n", longopt);
            }
            help();
        }
    }

    if (optind >= argc)
        help();

    if (!out_filename) {
        if (output_type == OUTPUT_EXECUTABLE) {
            out_filename = "a.out";
        } else {
            out_filename = "out.c";
        }
    }

    if (output_type == OUTPUT_EXECUTABLE) {
#if defined(_WIN32) || defined(__ANDROID__)
        /* XXX: find a /tmp directory ? */
        snprintf(cfilename, sizeof(cfilename), "out%d.c", getpid());
#else
        snprintf(cfilename, sizeof(cfilename), "/tmp/out%d.c", getpid());
#endif
    } else {
        pstrcpy(cfilename, sizeof(cfilename), out_filename);
    }

    fo = fopen(cfilename, "w");
    if (!fo) {
        perror(cfilename);
        exit(1);
    }
    outfile = fo;

    rt = JS_NewRuntime();
    ctx = JS_NewContext(rt);

    JS_SetStripInfo(rt, strip_flags);

    /* TypeScript transform in an isolated runtime (no interference with compile tracking) */
    ts_init();

    /* loader for ES6 modules (compile_mode context for embedded:// prefixing) */
    JS_SetModuleLoaderFunc2(rt, qjsx_module_normalizer, jsc_module_loader, NULL, &compile_resolver_ctx);

    fprintf(fo, "/* File generated automatically by the QuickJS compiler. */\n"
            "\n"
            );

    if (output_type != OUTPUT_C) {
        fprintf(fo, "#include \"quickjs-libc.h\"\n"
                "#include \"cutils.h\"\n"
                "#include <sys/stat.h>\n"
                "#include <unistd.h>\n"
                "\n"
                );

        fprintf(fo, "#include \"module_resolution/module-resolution.h\"\n");
        fprintf(fo, "#include \"exit-handler.h\"\n");
        fprintf(fo, "#include \"libuv/qn-vm.h\"\n\n");

        fprintf(fo,
                "static JSModuleDef *qjsx_loader(JSContext *ctx, const char *name, void *opaque, JSValueConst attributes) {\n"
                "    // embedded:// modules are preloaded by js_std_eval_binary.\n"
                "    // If the loader is called, the module wasn't found in cache.\n"
                "    if (has_embedded_prefix(name)) {\n"
                "        JS_ThrowReferenceError(ctx, \"could not load embedded module '%%s'\", name + EMBEDDED_PREFIX_LEN);\n"
                "        return NULL;\n"
                "    }\n"
                "    // Disk loading: bare imports via NODE_PATH\n"
                "    if (name[0] != '.' && name[0] != '/') {\n"
                "        char *path = resolve_node_path(ctx, name);\n"
                "        if (path) {\n"
                "            JSModuleDef *mod = js_module_loader(ctx, path, opaque, attributes);\n"
                "            js_free(ctx, path);\n"
                "            return mod;\n"
                "        }\n"
                "    }\n"
                "    // File paths: try with .js extension and /index.js (skip in node mode)\n"
                "    if (!is_node_resolution()) {\n"
                "        char *resolved_path = resolve_with_index(ctx, name);\n"
                "        if (resolved_path) {\n"
                "            JSModuleDef *mod = js_module_loader(ctx, resolved_path, opaque, attributes);\n"
                "            js_free(ctx, resolved_path);\n"
                "            return mod;\n"
                "        }\n"
                "    }\n"
                "    // Fallback: try exact name\n"
                "    return js_module_loader(ctx, name, opaque, attributes);\n"
                "}\n"
                "\n");
    } else {
        fprintf(fo, "#include <inttypes.h>\n"
                "\n"
                );
    }

    for(i = optind; i < argc; i++) {
        const char *filename = argv[i];
        compile_file(ctx, fo, filename, cname, module);
        cname = NULL;
    }

    for(i = 0; i < dynamic_module_list.count; i++) {
        const char *dyn_name = dynamic_module_list.array[i].name;
        /* Normalize the -D module name with compile context (adds embedded:// prefix) */
        char *normalized = qjsx_module_normalizer(ctx, EMBEDDED_PREFIX "<input>", dyn_name, &compile_resolver_ctx);
        if (!normalized) {
            fprintf(stderr, "Could not normalize dynamic module '%s'\n", dyn_name);
            exit(1);
        }
        if (!jsc_module_loader(ctx, normalized, NULL, JS_UNDEFINED)) {
            fprintf(stderr, "Could not load dynamic module '%s'\n", dyn_name);
            js_free(ctx, normalized);
            exit(1);
        }
        js_free(ctx, normalized);
    }

    if (output_type != OUTPUT_C) {
        /* Output the embedded module names array for runtime probing */
        fprintf(fo, "/* Embedded module names for runtime resolution */\n");
        fprintf(fo, "static const char *qjsx_embedded_modules[] = {\n");
        for(i = 0; i < embedded_module_names.count; i++) {
            namelist_entry_t *e = &embedded_module_names.array[i];
            fprintf(fo, "    \"%s\",\n", e->name);
        }
        fprintf(fo, "    NULL\n};\n\n");

        /* Output the import map for runtime bare import resolution */
        fprintf(fo, "/* Import map: (base, specifier) -> resolved name */\n");
        fprintf(fo, "static const QJSXImportMapEntry qjsx_import_map[] = {\n");
        for(i = 0; i < import_map_count; i++) {
            fprintf(fo, "    { \"%s\", \"%s\", \"%s\" },\n",
                    import_map_records[i].base,
                    import_map_records[i].specifier,
                    import_map_records[i].resolved);
        }
        fprintf(fo, "};\n\n");

        fprintf(fo, "static QJSXModuleResolverContext qjsx_resolver_ctx = {\n");
        fprintf(fo, "    .embedded_modules = qjsx_embedded_modules,\n");
        fprintf(fo, "    .import_map = qjsx_import_map,\n");
        fprintf(fo, "    .import_map_count = %d,\n", import_map_count);
        fprintf(fo, "    .compile_mode = 0,\n");
        fprintf(fo, "    .record_import = NULL,\n");
        fprintf(fo, "};\n\n");

        fprintf(fo,
                "static JSContext *JS_NewCustomContext(JSRuntime *rt)\n"
                "{\n"
                "  JSContext *ctx = JS_NewContextRaw(rt);\n"
                "  if (!ctx)\n"
                "    return NULL;\n");
        /* add the basic objects */
        fprintf(fo, "  JS_AddIntrinsicBaseObjects(ctx);\n");
        for(i = 0; i < countof(feature_list); i++) {
            if ((feature_bitmap & ((uint64_t)1 << i)) &&
                feature_list[i].init_name) {
                fprintf(fo, "  JS_AddIntrinsic%s(ctx);\n",
                        feature_list[i].init_name);
            }
        }
        /* add the precompiled modules (XXX: could modify the module
           loader instead) */
        for(i = 0; i < init_module_list.count; i++) {
            namelist_entry_t *e = &init_module_list.array[i];
            /* initialize the static C modules */

            fprintf(fo,
                    "  {\n"
                    "    extern JSModuleDef *js_init_module_%s(JSContext *ctx, const char *name);\n"
                    "    js_init_module_%s(ctx, \"%s\");\n"
                    "  }\n",
                    e->short_name, e->short_name, e->name);
        }
        for(i = 0; i < cname_list.count; i++) {
            namelist_entry_t *e = &cname_list.array[i];
            if (e->flags == CNAME_TYPE_MODULE) {
                fprintf(fo, "  qn_vm_eval_binary(ctx, %s, %s_size, 1);\n",
                        e->name, e->name);
            } else if (e->flags == CNAME_TYPE_JSON_MODULE) {
                fprintf(fo, "  qn_vm_eval_binary_json_module(ctx, %s, %s_size, (const char *)%s_module_name);\n",
                        e->name, e->name, e->name);
            }
        }
        fprintf(fo,
                "  return ctx;\n"
                "}\n\n");

        fputs(main_c_template1, fo);

        if (stack_size != 0) {
            fprintf(fo, "  JS_SetMaxStackSize(rt, %u);\n",
                    (unsigned int)stack_size);
        }

        /* add the module loader if necessary */
        if (feature_bitmap & (1 << FE_MODULE_LOADER)) {
            fprintf(fo, "  JS_SetModuleLoaderFunc2(rt, qjsx_module_normalizer, qjsx_loader, js_module_check_attributes, &qjsx_resolver_ctx);\n");
        }

        fprintf(fo,
                "  ctx = JS_NewCustomContext(rt);\n"
                "  qn_vm_init(ctx);\n"
                "  js_std_add_helpers(ctx, argc, argv);\n");

        for(i = 0; i < cname_list.count; i++) {
            namelist_entry_t *e = &cname_list.array[i];
            if (e->flags == CNAME_TYPE_SCRIPT) {
                fprintf(fo, "  qn_vm_eval_binary(ctx, %s, %s_size, 0);\n",
                        e->name, e->name);
            }
        }
        fprintf(fo,
                "  qn_vm_loop(ctx);\n"
                "  int exit_code = qjsx_call_exit_handler(ctx);\n"
                "  qn_vm_free(rt);\n"
                "  js_std_free_handlers(rt);\n"
                "  JS_FreeContext(ctx);\n"
                "  JS_FreeRuntime(rt);\n"
                "  return exit_code;\n"
                "}\n");
    }

    ts_free();
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);

    fclose(fo);

    if (output_type == OUTPUT_EXECUTABLE) {
        return output_executable(out_filename, cfilename, use_lto, verbose,
                                 argv[0]);
    }
    namelist_free(&cname_list);
    namelist_free(&cmodule_list);
    namelist_free(&init_module_list);
    namelist_free(&embedded_module_names);
    for(i = 0; i < import_map_count; i++) {
        free(import_map_records[i].base);
        free(import_map_records[i].specifier);
        free(import_map_records[i].resolved);
    }
    free(import_map_records);
    return 0;
}

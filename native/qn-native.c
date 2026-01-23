/*
 * qn-native.c - Native extensions for qn
 *
 * Provides low-level OS functions not available in QuickJS's os module.
 */

#include <errno.h>
#include <sys/stat.h>
#include "quickjs.h"

#define countof(x) (sizeof(x) / sizeof((x)[0]))

static int js_get_errno(int ret) {
    if (ret == -1)
        return -errno;
    return ret;
}

static JSValue js_qn_chmod(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    const char *path;
    int mode, ret;

    path = JS_ToCString(ctx, argv[0]);
    if (!path)
        return JS_EXCEPTION;

    if (JS_ToInt32(ctx, &mode, argv[1])) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

#if defined(_WIN32)
    ret = js_get_errno(_chmod(path, mode));
#else
    ret = js_get_errno(chmod(path, mode));
#endif

    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, ret);
}

static const JSCFunctionListEntry js_qn_native_funcs[] = {
    JS_CFUNC_DEF("chmod", 2, js_qn_chmod),
};

static int js_qn_native_init(JSContext *ctx, JSModuleDef *m)
{
    return JS_SetModuleExportList(ctx, m, js_qn_native_funcs,
                                  countof(js_qn_native_funcs));
}

JSModuleDef *js_init_module_qn_native(JSContext *ctx, const char *module_name)
{
    JSModuleDef *m;
    m = JS_NewCModule(ctx, module_name, js_qn_native_init);
    if (!m)
        return NULL;
    JS_AddModuleExportList(ctx, m, js_qn_native_funcs,
                           countof(js_qn_native_funcs));
    return m;
}

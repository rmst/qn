/*
 * Introspect - Function introspection for QuickJS
 *
 * Provides std.getClosureVars() for inspecting closure variables of functions.
 */

#include "quickjs.h"
#include "introspect.h"

static JSValue js_std_getClosureVars(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_UNDEFINED;
    return JS_GetClosureVars(ctx, argv[0]);
}

static const JSCFunctionListEntry js_introspect_funcs[] = {
    JS_CFUNC_DEF("getClosureVars", 1, js_std_getClosureVars),
};

const JSCFunctionListEntry *js_introspect_get_funcs(void)
{
    return js_introspect_funcs;
}

int js_introspect_get_funcs_count(void)
{
    return sizeof(js_introspect_funcs) / sizeof(js_introspect_funcs[0]);
}

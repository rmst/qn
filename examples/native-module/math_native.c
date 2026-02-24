/* A minimal QuickJS native module exporting add() and multiply(). */
#include "quickjs.h"

#define countof(x) (sizeof(x) / sizeof((x)[0]))

static JSValue js_add(JSContext *ctx, JSValueConst this_val,
                      int argc, JSValueConst *argv) {
	double a, b;
	if (JS_ToFloat64(ctx, &a, argv[0]) || JS_ToFloat64(ctx, &b, argv[1]))
		return JS_EXCEPTION;
	return JS_NewFloat64(ctx, a + b);
}

static JSValue js_multiply(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	double a, b;
	if (JS_ToFloat64(ctx, &a, argv[0]) || JS_ToFloat64(ctx, &b, argv[1]))
		return JS_EXCEPTION;
	return JS_NewFloat64(ctx, a * b);
}

static const JSCFunctionListEntry module_funcs[] = {
	JS_CFUNC_DEF("add", 2, js_add),
	JS_CFUNC_DEF("multiply", 2, js_multiply),
};

static int js_module_init(JSContext *ctx, JSModuleDef *m) {
	return JS_SetModuleExportList(ctx, m, module_funcs, countof(module_funcs));
}

JSModuleDef *js_init_module(JSContext *ctx, const char *module_name) {
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_module_init);
	if (!m) return NULL;
	JS_AddModuleExportList(ctx, m, module_funcs, countof(module_funcs));
	return m;
}

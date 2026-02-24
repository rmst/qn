/*
 * Minimal QuickJS native module for testing qnc package.
 * Exports: add(a, b), greeting()
 */
#include "quickjs.h"

static JSValue js_add(JSContext *ctx, JSValueConst this_val,
                      int argc, JSValueConst *argv) {
	double a, b;
	if (JS_ToFloat64(ctx, &a, argv[0]) || JS_ToFloat64(ctx, &b, argv[1]))
		return JS_EXCEPTION;
	return JS_NewFloat64(ctx, a + b);
}

static JSValue js_greeting(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
	return JS_NewString(ctx, "hello from native");
}

static const JSCFunctionListEntry module_funcs[] = {
	JS_CFUNC_DEF("add", 2, js_add),
	JS_CFUNC_DEF("greeting", 0, js_greeting),
};

static int js_module_init(JSContext *ctx, JSModuleDef *m) {
	return JS_SetModuleExportList(ctx, m, module_funcs,
	                              sizeof(module_funcs) / sizeof(module_funcs[0]));
}

JSModuleDef *js_init_module(JSContext *ctx, const char *module_name) {
	JSModuleDef *m = JS_NewCModule(ctx, module_name, js_module_init);
	if (!m) return NULL;
	JS_AddModuleExportList(ctx, m, module_funcs,
	                       sizeof(module_funcs) / sizeof(module_funcs[0]));
	return m;
}

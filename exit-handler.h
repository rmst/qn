/* Qn Exit Handler - calls globalThis.__qn_exitHandler before exit */

static inline int qn_call_exit_handler(JSContext *ctx) {
    int exit_code = 0;
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue code_val = JS_GetPropertyStr(ctx, global, "__qn_exitCode");
    if (JS_IsNumber(code_val))
        JS_ToInt32(ctx, &exit_code, code_val);
    JS_FreeValue(ctx, code_val);
    JSValue handler = JS_GetPropertyStr(ctx, global, "__qn_exitHandler");
    if (JS_IsFunction(ctx, handler)) {
        JSValue arg = JS_NewInt32(ctx, exit_code);
        JSValue ret = JS_Call(ctx, handler, JS_UNDEFINED, 1, &arg);
        JS_FreeValue(ctx, ret);
        JS_FreeValue(ctx, arg);
        /* Re-read exit code in case handler modified it */
        code_val = JS_GetPropertyStr(ctx, global, "__qn_exitCode");
        if (JS_IsNumber(code_val))
            JS_ToInt32(ctx, &exit_code, code_val);
        JS_FreeValue(ctx, code_val);
    }
    JS_FreeValue(ctx, handler);
    JS_FreeValue(ctx, global);
    return exit_code;
}

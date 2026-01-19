/*
 * Introspect - Function introspection for QuickJS
 *
 * Provides std.getClosureVars() for inspecting closure variables of functions.
 */

#ifndef INTROSPECT_H
#define INTROSPECT_H

#include "quickjs.h"

/*
 * Get the introspection function list for the std module.
 * Returns a pointer to the function list entry for getClosureVars.
 */
const JSCFunctionListEntry *js_introspect_get_funcs(void);
int js_introspect_get_funcs_count(void);

#endif /* INTROSPECT_H */

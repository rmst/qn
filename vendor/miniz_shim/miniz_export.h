/*
 * Stub for miniz's CMake-generated miniz_export.h.
 *
 * Upstream miniz expects CMake to generate this header with platform-specific
 * symbol visibility macros. We compile miniz directly without CMake and link
 * statically, so MINIZ_EXPORT can simply be empty.
 *
 * Lives outside vendor/miniz/ so the miniz submodule stays unmodified.
 */
#ifndef MINIZ_EXPORT
#define MINIZ_EXPORT
#endif

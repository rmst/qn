/*
 * qn-native.c - Native extensions for qn
 *
 * Provides low-level OS functions not available in QuickJS's os module.
 */

#include <errno.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>
#include "quickjs.h"

#if !defined(_WIN32)
#include <sys/wait.h>
#include <stdlib.h>
extern char **environ;
#endif

#define countof(x) (sizeof(x) / sizeof((x)[0]))

/* execvpe is a GNU extension, not available on macOS/BSD.
 * This implementation is adapted from QuickJS quickjs-libc.c */
#ifndef __linux__
#ifndef PATH_MAX
#define PATH_MAX 4096
#endif
#ifndef TRUE
#define TRUE 1
#define FALSE 0
#define BOOL int
#endif
static int my_execvpe(const char *filename, char *const argv[], char *const envp[])
{
    char *path, *p, *p_next, *p1;
    char buf[PATH_MAX];
    size_t filename_len, path_len;
    BOOL eacces_error;

    filename_len = strlen(filename);
    if (filename_len == 0) {
        errno = ENOENT;
        return -1;
    }
    if (strchr(filename, '/'))
        return execve(filename, argv, envp);

    path = getenv("PATH");
    if (!path)
        path = (char *)"/bin:/usr/bin";
    eacces_error = FALSE;
    p = path;
    for(p = path; p != NULL; p = p_next) {
        p1 = strchr(p, ':');
        if (!p1) {
            p_next = NULL;
            path_len = strlen(p);
        } else {
            p_next = p1 + 1;
            path_len = p1 - p;
        }
        if ((path_len + 1 + filename_len + 1) > PATH_MAX)
            continue;
        memcpy(buf, p, path_len);
        buf[path_len] = '/';
        memcpy(buf + path_len + 1, filename, filename_len + 1);
        execve(buf, argv, envp);
        switch(errno) {
        case EACCES:
            eacces_error = TRUE;
            break;
        case ENOENT:
        case ENOTDIR:
            break;
        default:
            return -1;
        }
    }
    if (eacces_error)
        errno = EACCES;
    return -1;
}
#define execvpe my_execvpe
#endif

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

#if !defined(_WIN32)
/*
 * spawn_setsid(args, options) -> pid
 *
 * Like os.exec() but calls setsid() in the child to create a new session
 * and process group. This is used to implement Node's detached option.
 *
 * args: array of strings [command, arg1, arg2, ...]
 * options: { stdin: fd, stdout: fd, stderr: fd, cwd: string, env: object }
 */
static JSValue js_qn_spawn_setsid(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    JSValueConst args = argv[0];
    JSValueConst options = argc >= 2 ? argv[1] : JS_UNDEFINED;
    JSValue val;
    const char **exec_argv = NULL;
    const char *cwd = NULL;
    char **envp = environ;
    char **alloc_envp = NULL;
    uint32_t exec_argc, i;
    int ret, pid;
    int std_fds[3] = { 0, 1, 2 };

    /* Get args array length */
    val = JS_GetPropertyStr(ctx, args, "length");
    if (JS_IsException(val))
        return JS_EXCEPTION;
    ret = JS_ToUint32(ctx, &exec_argc, val);
    JS_FreeValue(ctx, val);
    if (ret)
        return JS_EXCEPTION;

    if (exec_argc < 1 || exec_argc > 65535) {
        return JS_ThrowTypeError(ctx, "invalid number of arguments");
    }

    exec_argv = js_mallocz(ctx, sizeof(exec_argv[0]) * (exec_argc + 1));
    if (!exec_argv)
        return JS_EXCEPTION;

    for (i = 0; i < exec_argc; i++) {
        val = JS_GetPropertyUint32(ctx, args, i);
        if (JS_IsException(val))
            goto exception;
        exec_argv[i] = JS_ToCString(ctx, val);
        JS_FreeValue(ctx, val);
        if (!exec_argv[i])
            goto exception;
    }
    exec_argv[exec_argc] = NULL;

    /* Parse options */
    if (!JS_IsUndefined(options)) {
        /* stdin/stdout/stderr fds */
        static const char *std_names[3] = { "stdin", "stdout", "stderr" };
        for (i = 0; i < 3; i++) {
            val = JS_GetPropertyStr(ctx, options, std_names[i]);
            if (JS_IsException(val))
                goto exception;
            if (!JS_IsUndefined(val)) {
                int fd;
                ret = JS_ToInt32(ctx, &fd, val);
                JS_FreeValue(ctx, val);
                if (ret)
                    goto exception;
                std_fds[i] = fd;
            }
        }

        /* cwd */
        val = JS_GetPropertyStr(ctx, options, "cwd");
        if (JS_IsException(val))
            goto exception;
        if (!JS_IsUndefined(val)) {
            cwd = JS_ToCString(ctx, val);
            JS_FreeValue(ctx, val);
            if (!cwd)
                goto exception;
        }

        /* env - build envp array from object */
        val = JS_GetPropertyStr(ctx, options, "env");
        if (JS_IsException(val))
            goto exception;
        if (!JS_IsUndefined(val) && !JS_IsNull(val)) {
            JSPropertyEnum *tab;
            uint32_t len, env_count = 0;

            if (JS_GetOwnPropertyNames(ctx, &tab, &len, val, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
                JS_FreeValue(ctx, val);
                goto exception;
            }

            alloc_envp = js_mallocz(ctx, sizeof(char *) * (len + 1));
            if (!alloc_envp) {
                js_free(ctx, tab);
                JS_FreeValue(ctx, val);
                goto exception;
            }

            for (i = 0; i < len; i++) {
                JSValue key = JS_AtomToString(ctx, tab[i].atom);
                JSValue value = JS_GetProperty(ctx, val, tab[i].atom);
                const char *key_str = JS_ToCString(ctx, key);
                const char *val_str = JS_ToCString(ctx, value);
                JS_FreeValue(ctx, key);
                JS_FreeValue(ctx, value);

                if (key_str && val_str) {
                    size_t key_len = strlen(key_str);
                    size_t val_len = strlen(val_str);
                    char *env_entry = js_malloc(ctx, key_len + val_len + 2);
                    if (env_entry) {
                        memcpy(env_entry, key_str, key_len);
                        env_entry[key_len] = '=';
                        memcpy(env_entry + key_len + 1, val_str, val_len + 1);
                        alloc_envp[env_count++] = env_entry;
                    }
                }
                if (key_str) JS_FreeCString(ctx, key_str);
                if (val_str) JS_FreeCString(ctx, val_str);
                JS_FreeAtom(ctx, tab[i].atom);
            }
            alloc_envp[env_count] = NULL;
            js_free(ctx, tab);
            JS_FreeValue(ctx, val);
            envp = alloc_envp;
        }
    }

    pid = fork();
    if (pid < 0) {
        JS_ThrowTypeError(ctx, "fork error");
        goto exception;
    }

    if (pid == 0) {
        /* Child process */

        /* Create new session and process group */
        setsid();

        /* Redirect stdio */
        for (i = 0; i < 3; i++) {
            if (std_fds[i] != (int)i) {
                if (dup2(std_fds[i], i) < 0)
                    _exit(127);
            }
        }

        /* Close other file descriptors */
        {
            int fd_max = sysconf(_SC_OPEN_MAX);
            if (fd_max > 1024) fd_max = 1024;
            for (i = 3; i < (uint32_t)fd_max; i++)
                close(i);
        }

        /* Change directory */
        if (cwd && chdir(cwd) < 0)
            _exit(127);

        /* Execute */
        if (alloc_envp) {
            execve(exec_argv[0], (char *const *)exec_argv, envp);
            /* If execve fails, try with PATH */
            execvpe(exec_argv[0], (char *const *)exec_argv, envp);
        } else {
            execvp(exec_argv[0], (char *const *)exec_argv);
        }
        _exit(127);
    }

    /* Parent - cleanup and return pid */
    for (i = 0; i < exec_argc; i++) {
        if (exec_argv[i])
            JS_FreeCString(ctx, exec_argv[i]);
    }
    js_free(ctx, exec_argv);
    if (cwd)
        JS_FreeCString(ctx, cwd);
    if (alloc_envp) {
        for (i = 0; alloc_envp[i]; i++)
            js_free(ctx, alloc_envp[i]);
        js_free(ctx, alloc_envp);
    }

    return JS_NewInt32(ctx, pid);

exception:
    if (exec_argv) {
        for (i = 0; i < exec_argc; i++) {
            if (exec_argv[i])
                JS_FreeCString(ctx, exec_argv[i]);
        }
        js_free(ctx, exec_argv);
    }
    if (cwd)
        JS_FreeCString(ctx, cwd);
    if (alloc_envp) {
        for (i = 0; alloc_envp[i]; i++)
            js_free(ctx, alloc_envp[i]);
        js_free(ctx, alloc_envp);
    }
    return JS_EXCEPTION;
}

/* getpgid(pid) -> pgid */
static JSValue js_qn_getpgid(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    int pid, ret;
    if (JS_ToInt32(ctx, &pid, argv[0]))
        return JS_EXCEPTION;
    ret = getpgid(pid);
    if (ret < 0)
        return JS_ThrowTypeError(ctx, "getpgid error: %s", strerror(errno));
    return JS_NewInt32(ctx, ret);
}

/* setNonBlock(fd) -> 0 on success, -errno on failure */
static JSValue js_qn_setNonBlock(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    int fd, flags;
    if (JS_ToInt32(ctx, &fd, argv[0]))
        return JS_EXCEPTION;
    flags = fcntl(fd, F_GETFL);
    if (flags < 0)
        return JS_NewInt32(ctx, -errno);
    if (fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0)
        return JS_NewInt32(ctx, -errno);
    return JS_NewInt32(ctx, 0);
}

/* chown(path, uid, gid) -> 0 on success, -errno on failure */
static JSValue js_qn_chown(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    const char *path;
    int uid, gid, ret;

    path = JS_ToCString(ctx, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &uid, argv[1])) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }
    if (JS_ToInt32(ctx, &gid, argv[2])) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    ret = js_get_errno(chown(path, uid, gid));
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, ret);
}

/* lchown(path, uid, gid) -> 0 on success, -errno on failure */
static JSValue js_qn_lchown(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *path;
    int uid, gid, ret;

    path = JS_ToCString(ctx, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &uid, argv[1])) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }
    if (JS_ToInt32(ctx, &gid, argv[2])) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    ret = js_get_errno(lchown(path, uid, gid));
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, ret);
}
#endif

static const JSCFunctionListEntry js_qn_native_funcs[] = {
    JS_CFUNC_DEF("chmod", 2, js_qn_chmod),
#if !defined(_WIN32)
    JS_CFUNC_DEF("spawn_setsid", 2, js_qn_spawn_setsid),
    JS_CFUNC_DEF("getpgid", 1, js_qn_getpgid),
    JS_CFUNC_DEF("setNonBlock", 1, js_qn_setNonBlock),
    JS_CFUNC_DEF("chown", 3, js_qn_chown),
    JS_CFUNC_DEF("lchown", 3, js_qn_lchown),
#endif
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

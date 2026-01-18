/*
 * QJSX Sandbox - Sandboxed Worker Implementation
 *
 * This file implements os.SandboxedWorker, a Worker-like API that runs
 * JavaScript code in a restricted environment without std/os modules.
 */

#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <pthread.h>
#include <stdatomic.h>
#include <unistd.h>
#include <errno.h>
#include <time.h>
#include <sys/select.h>

#include "quickjs/quickjs.h"
#include "quickjs/quickjs-libc.h"
#include "quickjs/cutils.h"
#include "quickjs/list.h"
#include "sandboxed-worker.h"

#ifdef USE_SANDBOX

/* ========================================================================
 * Message Infrastructure (self-contained)
 * ======================================================================== */

typedef struct {
    struct list_head link;
    uint8_t *data;
    size_t data_len;
    uint8_t **sab_tab;
    size_t sab_tab_len;
} SandboxMessage;

typedef struct {
    int read_fd;
    int write_fd;
} SandboxWaker;

typedef struct {
    _Atomic(int) ref_count;
    pthread_mutex_t mutex;
    struct list_head msg_queue;
    SandboxWaker waker;
} SandboxMessagePipe;

typedef struct {
    struct list_head link;
    SandboxMessagePipe *recv_pipe;
    JSValue on_message_func;
} SandboxMessageHandler;

typedef struct {
    SandboxMessagePipe *recv_pipe;
    SandboxMessagePipe *send_pipe;
    SandboxMessageHandler *msg_handler;
} SandboxedWorkerData;

typedef struct {
    SandboxMessagePipe *recv_pipe;
    SandboxMessagePipe *send_pipe;
    char *filename;
    char *basename;
    char *code;
    int allow_imports;
    size_t memory_limit;
    size_t stack_size;
    uint64_t timeout_ms;
} SandboxWorkerFuncArgs;

typedef struct {
    struct list_head port_list;
    SandboxMessagePipe *recv_pipe;
    SandboxMessagePipe *send_pipe;
    uint64_t timeout_end;
    JSValue worker_parent;
} SandboxThreadState;

/* SandboxMessageHandler is memory-compatible with JSWorkerMessageHandler. */

/* Class ID for SandboxedWorker */
static JSClassID js_sandboxed_worker_class_id;

/* Function to create new contexts (can be customized for QJSXPATH support) */
static JSContext *(*sandbox_new_context_func)(JSRuntime *rt) = NULL;

/* ========================================================================
 * Forward Declarations
 * ======================================================================== */

static void *sandboxed_worker_func(void *opaque);

/* ========================================================================
 * Waker Implementation (pipe-based notification)
 * ======================================================================== */

static int sandbox_waker_init(SandboxWaker *w)
{
    int fds[2];
    if (pipe(fds) < 0)
        return -1;
    w->read_fd = fds[0];
    w->write_fd = fds[1];
    return 0;
}

static void sandbox_waker_signal(SandboxWaker *w)
{
    int ret;
    for (;;) {
        ret = write(w->write_fd, "", 1);
        if (ret == 1)
            break;
        if (ret < 0 && (errno != EAGAIN && errno != EINTR))
            break;
    }
}

static void sandbox_waker_clear(SandboxWaker *w)
{
    uint8_t buf[16];
    int ret;
    for (;;) {
        ret = read(w->read_fd, buf, sizeof(buf));
        if (ret < (int)sizeof(buf))
            break;
    }
}

static void sandbox_waker_close(SandboxWaker *w)
{
    close(w->read_fd);
    close(w->write_fd);
    w->read_fd = -1;
    w->write_fd = -1;
}

/* ========================================================================
 * Message Pipe Implementation
 * ======================================================================== */

static SandboxMessagePipe *sandbox_new_message_pipe(void)
{
    SandboxMessagePipe *ps = malloc(sizeof(*ps));
    if (!ps)
        return NULL;
    if (sandbox_waker_init(&ps->waker)) {
        free(ps);
        return NULL;
    }
    atomic_init(&ps->ref_count, 1);
    init_list_head(&ps->msg_queue);
    pthread_mutex_init(&ps->mutex, NULL);
    return ps;
}

static SandboxMessagePipe *sandbox_dup_message_pipe(SandboxMessagePipe *ps)
{
    atomic_fetch_add(&ps->ref_count, 1);
    return ps;
}

static void sandbox_free_message(SandboxMessage *msg)
{
    if (msg) {
        free(msg->sab_tab);
        free(msg->data);
        free(msg);
    }
}

static void sandbox_free_message_pipe(SandboxMessagePipe *ps)
{
    struct list_head *el, *el1;
    SandboxMessage *msg;
    int ref_count;

    if (!ps)
        return;

    ref_count = atomic_fetch_sub(&ps->ref_count, 1) - 1;
    if (ref_count == 0) {
        list_for_each_safe(el, el1, &ps->msg_queue) {
            msg = list_entry(el, SandboxMessage, link);
            sandbox_free_message(msg);
        }
        pthread_mutex_destroy(&ps->mutex);
        sandbox_waker_close(&ps->waker);
        free(ps);
    }
}

static void sandbox_free_port(JSRuntime *rt, SandboxMessageHandler *port)
{
    if (port) {
        sandbox_free_message_pipe(port->recv_pipe);
        JS_FreeValueRT(rt, port->on_message_func);
        list_del(&port->link);
        js_free_rt(rt, port);
    }
}

/* ========================================================================
 * Simple Print Function (for sandbox console.log)
 * ======================================================================== */

static JSValue sandbox_print(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    int i;
    const char *str;

    for (i = 0; i < argc; i++) {
        if (i != 0)
            putchar(' ');
        str = JS_ToCString(ctx, argv[i]);
        if (!str)
            return JS_EXCEPTION;
        fputs(str, stdout);
        JS_FreeCString(ctx, str);
    }
    putchar('\n');
    fflush(stdout);
    return JS_UNDEFINED;
}

/* ========================================================================
 * Message Handling
 * ======================================================================== */

static int sandbox_handle_posted_message(JSRuntime *rt, JSContext *ctx,
                                         SandboxMessageHandler *port)
{
    SandboxMessagePipe *ps = port->recv_pipe;
    SandboxThreadState *ts = JS_GetRuntimeOpaque(rt);
    int ret;
    struct list_head *el;
    SandboxMessage *msg;
    JSValue obj = JS_UNDEFINED, data_obj, func = JS_UNDEFINED, retval;

    pthread_mutex_lock(&ps->mutex);
    if (!list_empty(&ps->msg_queue)) {
        el = ps->msg_queue.next;
        msg = list_entry(el, SandboxMessage, link);
        list_del(&msg->link);

        if (list_empty(&ps->msg_queue))
            sandbox_waker_clear(&ps->waker);

        pthread_mutex_unlock(&ps->mutex);

        data_obj = JS_ReadObject(ctx, msg->data, msg->data_len,
                                 JS_READ_OBJ_SAB | JS_READ_OBJ_REFERENCE);
        sandbox_free_message(msg);

        if (JS_IsException(data_obj))
            goto fail;

        obj = JS_NewObject(ctx);
        if (JS_IsException(obj)) {
            JS_FreeValue(ctx, data_obj);
            goto fail;
        }
        JS_DefinePropertyValueStr(ctx, obj, "data", data_obj, JS_PROP_C_W_E);

        /* Get onmessage handler from Worker.parent */
        func = JS_GetPropertyStr(ctx, ts->worker_parent, "onmessage");
        if (JS_IsFunction(ctx, func)) {
            retval = JS_Call(ctx, func, JS_UNDEFINED, 1, (JSValueConst *)&obj);
            if (JS_IsException(retval)) {
            fail:
                js_std_dump_error(ctx);
            } else {
                JS_FreeValue(ctx, retval);
            }
        }
        JS_FreeValue(ctx, obj);
        JS_FreeValue(ctx, func);
        ret = 1;
    } else {
        pthread_mutex_unlock(&ps->mutex);
        ret = 0;
    }
    return ret;
}

/* ========================================================================
 * Sandboxed Worker Class
 * ======================================================================== */

static void js_sandboxed_worker_finalizer(JSRuntime *rt, JSValue val)
{
    SandboxedWorkerData *worker = JS_GetOpaque(val, js_sandboxed_worker_class_id);
    if (worker) {
        sandbox_free_message_pipe(worker->recv_pipe);
        sandbox_free_message_pipe(worker->send_pipe);
        if (worker->msg_handler) {
            /* Remove from main thread's port_list */
            list_del(&worker->msg_handler->link);
            sandbox_free_message_pipe(worker->msg_handler->recv_pipe);
            JS_FreeValueRT(rt, worker->msg_handler->on_message_func);
            js_free_rt(rt, worker->msg_handler);
        }
        js_free_rt(rt, worker);
    }
}

static JSClassDef js_sandboxed_worker_class = {
    "SandboxedWorker",
    .finalizer = js_sandboxed_worker_finalizer,
};

/* ========================================================================
 * Timeout Interrupt Handler
 * ======================================================================== */

static int sandbox_interrupt_handler(JSRuntime *rt, void *opaque)
{
    SandboxThreadState *ts = opaque;
    if (ts->timeout_end == 0)
        return 0;

    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    uint64_t now_ms = (uint64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;

    return now_ms >= ts->timeout_end;
}

/* ========================================================================
 * Sandboxed Module Loader (blocks .so files)
 * ======================================================================== */

static JSModuleDef *sandbox_module_loader(JSContext *ctx, const char *module_name,
                                          void *opaque)
{
    /* Block native modules for security */
    if (has_suffix(module_name, ".so")) {
        JS_ThrowTypeError(ctx, "native modules not allowed in sandbox");
        return NULL;
    }

    /* Use the standard module loader for JS files */
    return js_module_loader(ctx, module_name, opaque, JS_UNDEFINED);
}

/* ========================================================================
 * Sandbox Event Loop (simplified, just handles messages)
 * ======================================================================== */

static int sandbox_poll(JSContext *ctx, SandboxThreadState *ts)
{
    struct list_head *el;
    fd_set rfds;
    struct timeval tv;
    int fd_max = -1;
    int ret;

    if (list_empty(&ts->port_list))
        return -1;

    FD_ZERO(&rfds);

    list_for_each(el, &ts->port_list) {
        SandboxMessageHandler *port = list_entry(el, SandboxMessageHandler, link);
        SandboxMessagePipe *ps = port->recv_pipe;
        FD_SET(ps->waker.read_fd, &rfds);
        if (ps->waker.read_fd > fd_max)
            fd_max = ps->waker.read_fd;
    }

    tv.tv_sec = 0;
    tv.tv_usec = 100000;  /* 100ms timeout */

    ret = select(fd_max + 1, &rfds, NULL, NULL, &tv);
    if (ret > 0) {
        list_for_each(el, &ts->port_list) {
            SandboxMessageHandler *port = list_entry(el, SandboxMessageHandler, link);
            SandboxMessagePipe *ps = port->recv_pipe;
            if (FD_ISSET(ps->waker.read_fd, &rfds)) {
                if (sandbox_handle_posted_message(JS_GetRuntime(ctx), ctx, port))
                    return 0;
            }
        }
    }

    return 0;
}

static void sandbox_event_loop(JSContext *ctx, SandboxThreadState *ts)
{
    int err;

    for (;;) {
        for (;;) {
            err = JS_ExecutePendingJob(JS_GetRuntime(ctx), NULL);
            if (err <= 0) {
                if (err < 0)
                    js_std_dump_error(ctx);
                break;
            }
        }

        if (sandbox_poll(ctx, ts))
            break;
    }
}

/* ========================================================================
 * Worker.parent Methods (used inside sandbox)
 * ======================================================================== */

static JSValue js_sandbox_parent_postMessage(JSContext *ctx, JSValueConst this_val,
                                             int argc, JSValueConst *argv)
{
    SandboxThreadState *ts = JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
    if (!ts || !ts->send_pipe)
        return JS_ThrowTypeError(ctx, "no send pipe available");

    SandboxMessagePipe *ps = ts->send_pipe;
    size_t data_len, sab_tab_len;
    uint8_t *data;
    SandboxMessage *msg;
    uint8_t **sab_tab;

    data = JS_WriteObject2(ctx, &data_len, argv[0],
                           JS_WRITE_OBJ_SAB | JS_WRITE_OBJ_REFERENCE,
                           &sab_tab, &sab_tab_len);
    if (!data)
        return JS_EXCEPTION;

    msg = malloc(sizeof(*msg));
    if (!msg)
        goto fail;
    msg->data = NULL;
    msg->sab_tab = NULL;

    msg->data = malloc(data_len);
    if (!msg->data)
        goto fail;
    memcpy(msg->data, data, data_len);
    msg->data_len = data_len;

    if (sab_tab_len > 0) {
        msg->sab_tab = malloc(sizeof(msg->sab_tab[0]) * sab_tab_len);
        if (!msg->sab_tab)
            goto fail;
        memcpy(msg->sab_tab, sab_tab, sizeof(msg->sab_tab[0]) * sab_tab_len);
    }
    msg->sab_tab_len = sab_tab_len;

    js_free(ctx, data);
    js_free(ctx, sab_tab);

    pthread_mutex_lock(&ps->mutex);
    if (list_empty(&ps->msg_queue))
        sandbox_waker_signal(&ps->waker);
    list_add_tail(&msg->link, &ps->msg_queue);
    pthread_mutex_unlock(&ps->mutex);

    return JS_UNDEFINED;

fail:
    if (msg) {
        free(msg->data);
        free(msg->sab_tab);
        free(msg);
    }
    js_free(ctx, data);
    js_free(ctx, sab_tab);
    return JS_EXCEPTION;
}

/* ========================================================================
 * Worker Thread Function
 * ======================================================================== */

static void *sandboxed_worker_func(void *opaque)
{
    SandboxWorkerFuncArgs *args = opaque;
    JSRuntime *rt;
    JSContext *ctx;
    JSValue val;
    SandboxThreadState ts;
    SandboxMessageHandler *port;

    /* Initialize thread state */
    memset(&ts, 0, sizeof(ts));
    init_list_head(&ts.port_list);
    ts.recv_pipe = args->recv_pipe;
    ts.send_pipe = args->send_pipe;
    ts.worker_parent = JS_UNDEFINED;

    /* Create runtime with limits */
    rt = JS_NewRuntime();
    if (!rt) {
        fprintf(stderr, "SandboxedWorker: JS_NewRuntime failure\n");
        goto cleanup_args;
    }

    /* Store thread state in runtime opaque */
    JS_SetRuntimeOpaque(rt, &ts);

    if (args->memory_limit > 0)
        JS_SetMemoryLimit(rt, args->memory_limit);
    if (args->stack_size > 0)
        JS_SetMaxStackSize(rt, args->stack_size);

    /* Set up timeout if requested */
    if (args->timeout_ms > 0) {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        ts.timeout_end = (uint64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000 + args->timeout_ms;
        JS_SetInterruptHandler(rt, sandbox_interrupt_handler, &ts);
    }

    /* Set module loader if we have a file to load OR if imports are allowed.
     * File-based workers need the module loader to load the initial file.
     * If allow_imports is false, subsequent imports will be blocked by sandbox_module_loader. */
    if (args->filename || args->allow_imports) {
        JS_SetModuleLoaderFunc(rt, NULL, sandbox_module_loader, NULL);
    }

    /* Create bare context - NO std/os modules! */
    if (sandbox_new_context_func) {
        ctx = sandbox_new_context_func(rt);
    } else {
        ctx = JS_NewContext(rt);
    }
    if (!ctx) {
        fprintf(stderr, "SandboxedWorker: JS_NewContext failure\n");
        goto cleanup_rt;
    }

    /* Add only console.log and print for debugging */
    {
        JSValue global = JS_GetGlobalObject(ctx);
        JSValue console = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, console, "log",
                          JS_NewCFunction(ctx, sandbox_print, "log", 1));
        JS_SetPropertyStr(ctx, global, "console", console);
        JS_SetPropertyStr(ctx, global, "print",
                          JS_NewCFunction(ctx, sandbox_print, "print", 1));
        JS_FreeValue(ctx, global);
    }

    /* Create message handler for receiving messages */
    port = js_mallocz(ctx, sizeof(*port));
    if (!port) {
        goto cleanup_ctx;
    }
    port->recv_pipe = sandbox_dup_message_pipe(ts.recv_pipe);
    port->on_message_func = JS_NULL;
    list_add_tail(&port->link, &ts.port_list);

    /* Set up Worker.parent for communication */
    {
        JSValue global = JS_GetGlobalObject(ctx);
        JSValue worker_parent = JS_NewObject(ctx);

        /* Add postMessage method */
        JS_SetPropertyStr(ctx, worker_parent, "postMessage",
            JS_NewCFunction(ctx, js_sandbox_parent_postMessage, "postMessage", 1));

        /* Initialize onmessage as null - user will set it directly */
        JS_SetPropertyStr(ctx, worker_parent, "onmessage", JS_NULL);

        /* Create Worker object with parent property */
        JSValue worker_class = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, worker_class, "parent", worker_parent);
        JS_SetPropertyStr(ctx, global, "Worker", worker_class);

        /* Store worker_parent reference in thread state for message handling */
        ts.worker_parent = JS_DupValue(ctx, worker_parent);

        JS_FreeValue(ctx, global);
    }

    /* Load and execute the script */
    if (args->code) {
        /* Evaluate code string */
        val = JS_Eval(ctx, args->code, strlen(args->code), "<sandbox>",
                      JS_EVAL_TYPE_MODULE);
    } else if (args->filename) {
        /* Load module from file */
        val = JS_LoadModule(ctx, args->basename, args->filename);
    } else {
        val = JS_UNDEFINED;
    }

    if (JS_IsException(val))
        js_std_dump_error(ctx);
    JS_FreeValue(ctx, val);

    /* Run event loop */
    sandbox_event_loop(ctx, &ts);

cleanup_ctx:
    /* Clean up worker_parent */
    JS_FreeValue(ctx, ts.worker_parent);

    /* Clean up port */
    if (!list_empty(&ts.port_list)) {
        struct list_head *el, *el1;
        list_for_each_safe(el, el1, &ts.port_list) {
            SandboxMessageHandler *p = list_entry(el, SandboxMessageHandler, link);
            sandbox_free_port(rt, p);
        }
    }
    JS_FreeContext(ctx);

cleanup_rt:
    JS_FreeRuntime(rt);

cleanup_args:
    sandbox_free_message_pipe(args->recv_pipe);
    sandbox_free_message_pipe(args->send_pipe);
    free(args->filename);
    free(args->basename);
    free(args->code);
    free(args);

    return NULL;
}

/* ========================================================================
 * SandboxedWorker Constructor and Methods (parent side)
 * ======================================================================== */

static JSValue js_sandboxed_worker_ctor_internal(JSContext *ctx, JSValueConst new_target,
                                                 SandboxMessagePipe *recv_pipe,
                                                 SandboxMessagePipe *send_pipe)
{
    JSValue obj = JS_UNDEFINED, proto;
    SandboxedWorkerData *s;

    if (JS_IsUndefined(new_target)) {
        proto = JS_GetClassProto(ctx, js_sandboxed_worker_class_id);
    } else {
        proto = JS_GetPropertyStr(ctx, new_target, "prototype");
        if (JS_IsException(proto))
            goto fail;
    }
    obj = JS_NewObjectProtoClass(ctx, proto, js_sandboxed_worker_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj))
        goto fail;

    s = js_mallocz(ctx, sizeof(*s));
    if (!s)
        goto fail;
    s->recv_pipe = sandbox_dup_message_pipe(recv_pipe);
    s->send_pipe = sandbox_dup_message_pipe(send_pipe);
    s->msg_handler = NULL;

    JS_SetOpaque(obj, s);
    return obj;

fail:
    JS_FreeValue(ctx, obj);
    return JS_EXCEPTION;
}

static JSValue js_sandboxed_worker_ctor(JSContext *ctx, JSValueConst new_target,
                                        int argc, JSValueConst *argv)
{
    SandboxWorkerFuncArgs *args = NULL;
    pthread_t tid;
    pthread_attr_t attr;
    JSValue obj = JS_UNDEFINED;
    int ret;
    const char *filename = NULL, *basename = NULL, *code = NULL;
    JSAtom basename_atom;
    SandboxMessagePipe *recv_pipe = NULL, *send_pipe = NULL;

    /* Parse arguments */
    int allow_imports = 0;
    size_t memory_limit = 0;
    size_t stack_size = 0;
    uint64_t timeout_ms = 0;

    if (argc < 1)
        return JS_ThrowTypeError(ctx, "SandboxedWorker requires at least one argument");

    if (JS_IsString(argv[0])) {
        /* File-based: new SandboxedWorker("script.js", options) */
        filename = JS_ToCString(ctx, argv[0]);
        if (!filename)
            return JS_EXCEPTION;

        /* Get base name for relative imports */
        basename_atom = JS_GetScriptOrModuleName(ctx, 1);
        if (basename_atom != JS_ATOM_NULL) {
            basename = JS_AtomToCString(ctx, basename_atom);
            JS_FreeAtom(ctx, basename_atom);
        }
    } else if (JS_IsObject(argv[0])) {
        /* Object-based: new SandboxedWorker({ code: "..." }) */
        JSValue code_val = JS_GetPropertyStr(ctx, argv[0], "code");
        if (!JS_IsUndefined(code_val)) {
            code = JS_ToCString(ctx, code_val);
            JS_FreeValue(ctx, code_val);
            if (!code)
                return JS_EXCEPTION;
        } else {
            JS_FreeValue(ctx, code_val);
            return JS_ThrowTypeError(ctx, "SandboxedWorker object must have 'code' property");
        }
    } else {
        return JS_ThrowTypeError(ctx, "SandboxedWorker argument must be string or object");
    }

    /* Parse options (from second argument or first if object) */
    JSValue opts = JS_UNDEFINED;
    if (JS_IsObject(argv[0]) && !JS_IsString(argv[0])) {
        opts = argv[0];
    } else if (argc >= 2 && JS_IsObject(argv[1])) {
        opts = argv[1];
    }

    if (!JS_IsUndefined(opts)) {
        JSValue v;

        v = JS_GetPropertyStr(ctx, opts, "allowImports");
        if (!JS_IsUndefined(v)) {
            allow_imports = JS_ToBool(ctx, v);
            JS_FreeValue(ctx, v);
        }

        v = JS_GetPropertyStr(ctx, opts, "memoryLimit");
        if (!JS_IsUndefined(v)) {
            int64_t ml;
            if (JS_ToInt64(ctx, &ml, v) == 0)
                memory_limit = ml;
            JS_FreeValue(ctx, v);
        }

        v = JS_GetPropertyStr(ctx, opts, "stackSize");
        if (!JS_IsUndefined(v)) {
            int64_t ss;
            if (JS_ToInt64(ctx, &ss, v) == 0)
                stack_size = ss;
            JS_FreeValue(ctx, v);
        }

        v = JS_GetPropertyStr(ctx, opts, "timeout");
        if (!JS_IsUndefined(v)) {
            int64_t t;
            if (JS_ToInt64(ctx, &t, v) == 0)
                timeout_ms = t;
            JS_FreeValue(ctx, v);
        }
    }

    /* Create message pipes */
    recv_pipe = sandbox_new_message_pipe();
    send_pipe = sandbox_new_message_pipe();
    if (!recv_pipe || !send_pipe)
        goto fail;

    /* Prepare worker arguments */
    args = malloc(sizeof(*args));
    if (!args)
        goto fail;
    memset(args, 0, sizeof(*args));

    args->recv_pipe = sandbox_dup_message_pipe(send_pipe);  /* child recv = parent send */
    args->send_pipe = sandbox_dup_message_pipe(recv_pipe);  /* child send = parent recv */
    args->filename = filename ? strdup(filename) : NULL;
    args->basename = basename ? strdup(basename) : NULL;
    args->code = code ? strdup(code) : NULL;
    args->allow_imports = allow_imports;
    args->memory_limit = memory_limit;
    args->stack_size = stack_size;
    args->timeout_ms = timeout_ms;

    /* Spawn worker thread */
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    ret = pthread_create(&tid, &attr, sandboxed_worker_func, args);
    pthread_attr_destroy(&attr);

    if (ret != 0) {
        JS_ThrowTypeError(ctx, "could not create worker thread");
        goto fail;
    }
    args = NULL;  /* Worker thread owns args now */

    /* Create JS object for parent */
    obj = js_sandboxed_worker_ctor_internal(ctx, new_target, recv_pipe, send_pipe);

    if (filename) JS_FreeCString(ctx, filename);
    if (basename) JS_FreeCString(ctx, basename);
    if (code) JS_FreeCString(ctx, code);
    sandbox_free_message_pipe(recv_pipe);
    sandbox_free_message_pipe(send_pipe);

    return obj;

fail:
    if (filename) JS_FreeCString(ctx, filename);
    if (basename) JS_FreeCString(ctx, basename);
    if (code) JS_FreeCString(ctx, code);
    sandbox_free_message_pipe(recv_pipe);
    sandbox_free_message_pipe(send_pipe);
    if (args) {
        sandbox_free_message_pipe(args->recv_pipe);
        sandbox_free_message_pipe(args->send_pipe);
        free(args->filename);
        free(args->basename);
        free(args->code);
        free(args);
    }
    JS_FreeValue(ctx, obj);
    return JS_EXCEPTION;
}

static JSValue js_sandboxed_worker_postMessage(JSContext *ctx, JSValueConst this_val,
                                               int argc, JSValueConst *argv)
{
    SandboxedWorkerData *worker = JS_GetOpaque2(ctx, this_val, js_sandboxed_worker_class_id);
    SandboxMessagePipe *ps;
    size_t data_len, sab_tab_len;
    uint8_t *data;
    SandboxMessage *msg;
    uint8_t **sab_tab;

    if (!worker)
        return JS_EXCEPTION;

    data = JS_WriteObject2(ctx, &data_len, argv[0],
                           JS_WRITE_OBJ_SAB | JS_WRITE_OBJ_REFERENCE,
                           &sab_tab, &sab_tab_len);
    if (!data)
        return JS_EXCEPTION;

    msg = malloc(sizeof(*msg));
    if (!msg)
        goto fail;
    msg->data = NULL;
    msg->sab_tab = NULL;

    msg->data = malloc(data_len);
    if (!msg->data)
        goto fail;
    memcpy(msg->data, data, data_len);
    msg->data_len = data_len;

    if (sab_tab_len > 0) {
        msg->sab_tab = malloc(sizeof(msg->sab_tab[0]) * sab_tab_len);
        if (!msg->sab_tab)
            goto fail;
        memcpy(msg->sab_tab, sab_tab, sizeof(msg->sab_tab[0]) * sab_tab_len);
    }
    msg->sab_tab_len = sab_tab_len;

    js_free(ctx, data);
    js_free(ctx, sab_tab);

    ps = worker->send_pipe;
    pthread_mutex_lock(&ps->mutex);
    if (list_empty(&ps->msg_queue))
        sandbox_waker_signal(&ps->waker);
    list_add_tail(&msg->link, &ps->msg_queue);
    pthread_mutex_unlock(&ps->mutex);

    return JS_UNDEFINED;

fail:
    if (msg) {
        free(msg->data);
        free(msg->sab_tab);
        free(msg);
    }
    js_free(ctx, data);
    js_free(ctx, sab_tab);
    return JS_EXCEPTION;
}

static JSValue js_sandboxed_worker_set_onmessage(JSContext *ctx, JSValueConst this_val,
                                                 JSValueConst func)
{
    SandboxedWorkerData *worker = JS_GetOpaque2(ctx, this_val, js_sandboxed_worker_class_id);
    SandboxMessageHandler *port;
    struct list_head *port_list;

    if (!worker)
        return JS_EXCEPTION;

    /* Get the port_list for event loop integration via accessor */
    port_list = js_std_get_port_list(JS_GetRuntime(ctx));
    if (!port_list)
        return JS_ThrowInternalError(ctx, "Thread state not initialized");

    port = worker->msg_handler;
    if (JS_IsNull(func)) {
        if (port) {
            /* Remove from main thread's port_list */
            list_del(&port->link);
            sandbox_free_message_pipe(port->recv_pipe);
            JS_FreeValue(ctx, port->on_message_func);
            js_free(ctx, port);
            worker->msg_handler = NULL;
        }
    } else {
        if (!JS_IsFunction(ctx, func))
            return JS_ThrowTypeError(ctx, "not a function");
        if (!port) {
            port = js_mallocz(ctx, sizeof(*port));
            if (!port)
                return JS_EXCEPTION;
            port->recv_pipe = sandbox_dup_message_pipe(worker->recv_pipe);
            port->on_message_func = JS_NULL;
            /* Add to main thread's port_list for event loop polling */
            list_add_tail(&port->link, port_list);
            worker->msg_handler = port;
        }
        JS_FreeValue(ctx, port->on_message_func);
        port->on_message_func = JS_DupValue(ctx, func);
    }
    return JS_UNDEFINED;
}

static JSValue js_sandboxed_worker_get_onmessage(JSContext *ctx, JSValueConst this_val)
{
    SandboxedWorkerData *worker = JS_GetOpaque2(ctx, this_val, js_sandboxed_worker_class_id);
    SandboxMessageHandler *port;
    if (!worker)
        return JS_EXCEPTION;
    port = worker->msg_handler;
    if (port)
        return JS_DupValue(ctx, port->on_message_func);
    else
        return JS_NULL;
}

static const JSCFunctionListEntry js_sandboxed_worker_proto_funcs[] = {
    JS_CFUNC_DEF("postMessage", 1, js_sandboxed_worker_postMessage),
    JS_CGETSET_DEF("onmessage", js_sandboxed_worker_get_onmessage, js_sandboxed_worker_set_onmessage),
};

/* ========================================================================
 * Public API
 * ======================================================================== */

void js_sandbox_set_context_func(JSContext *(*func)(JSRuntime *rt))
{
    sandbox_new_context_func = func;
}

void js_sandbox_init(JSContext *ctx, JSModuleDef *m)
{
    JSValue proto, obj;

    JS_NewClassID(&js_sandboxed_worker_class_id);
    JS_NewClass(JS_GetRuntime(ctx), js_sandboxed_worker_class_id, &js_sandboxed_worker_class);

    proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, js_sandboxed_worker_proto_funcs,
                               sizeof(js_sandboxed_worker_proto_funcs) / sizeof(js_sandboxed_worker_proto_funcs[0]));

    obj = JS_NewCFunction2(ctx, js_sandboxed_worker_ctor, "SandboxedWorker", 1,
                           JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, obj, proto);
    JS_SetClassProto(ctx, js_sandboxed_worker_class_id, proto);

    JS_SetModuleExport(ctx, m, "SandboxedWorker", obj);
}

void js_sandbox_add_export(JSContext *ctx, JSModuleDef *m)
{
    JS_AddModuleExport(ctx, m, "SandboxedWorker");
}

#endif /* USE_SANDBOX */

import * as std from 'std';
import * as os from 'os';

// Create stream-like objects for stdin, stdout, stderr
const createStream = (fd) => {
  const stream = {
    fd,
    get isTTY() {
      return os.isatty(fd);
    }
  };

  // Add write method for stdout and stderr
  if (fd === 1 || fd === 2) {
    stream.write = function(data, encoding, callback) {
      // Handle optional encoding parameter
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = 'utf8';
      }
      encoding = encoding || 'utf8';

      try {
        const file = fd === 1 ? std.out : std.err;
        file.puts(String(data));
        file.flush();
        if (callback) callback();
        return true;
      } catch (err) {
        if (callback) callback(err);
        return false;
      }
    };
  }

  return stream;
};

// Event handlers storage
const eventHandlers = new Map();

// Signal name to number mapping
const signalMap = {
  'SIGINT': os.SIGINT,
  'SIGTERM': os.SIGTERM,
  'SIGABRT': os.SIGABRT,
  'SIGFPE': os.SIGFPE,
  'SIGILL': os.SIGILL,
  'SIGSEGV': os.SIGSEGV
};

// Exit code to use when process exits
let _exitCode = 0;

// Process object that mimics Node.js process module
const process = {
  // Command line arguments
  argv: [...scriptArgs],  // TODO: maybe we have to unwrap these

  // Exit code property
  get exitCode() {
    return _exitCode;
  },
  set exitCode(code) {
    _exitCode = code;
  },

  // Environment variables - using Proxy to allow dynamic read/write
  env: new Proxy({}, {
    get: (_, p) => typeof p === 'string' ? std.getenv(p) : undefined,
    set: (_, p, v) => typeof p === 'string' ? (v == null ? std.unsetenv(p) : std.setenv(p, String(v)), true) : false,
    has: (_, p) => typeof p === 'string' && std.getenv(p) !== undefined,
    deleteProperty: (_, p) => typeof p === 'string' ? (std.unsetenv(p), true) : false,
    ownKeys: () => Object.keys(std.getenviron()),
    getOwnPropertyDescriptor: (_, p) => typeof p === 'string' && std.getenv(p) !== undefined ?
      { configurable: true, enumerable: true, value: std.getenv(p) } : undefined
  }),

  // Process control
  exit(code) {
    if (code !== undefined) {
      _exitCode = code;
    }
    std.exit(_exitCode);
  },

  // Current working directory
  cwd: () => {
    let [dir, error] = os.getcwd()
    if(error != 0)
      throw Error(`Couldn't get working directory`)

    return dir
  },

  // Change working directory
  chdir: (directory) => {
    const errno = os.chdir(directory)
    if (errno !== 0) {
      const err = new Error(`ENOENT: no such file or directory, chdir '${directory}'`)
      err.code = 'ENOENT'
      err.syscall = 'chdir'
      err.path = directory
      throw err
    }
  },

  // Standard streams
  stdin: createStream(0),
  stdout: createStream(1),
  stderr: createStream(2),

  // Process ID
  get pid() {
    return os.getpid();
  },

  // Platform
  platform: os.platform || 'quickjs',

  // Node version (return QuickJS version as placeholder)
  version: 'v1.0.0-quickjs',

  // Versions object
  versions: {
    node: '1.0.0-quickjs',
    quickjs: '1.0.0'
  },

  // Event emitter methods for signal handling
  on(event, handler) {
    if (!eventHandlers.has(event)) {
      eventHandlers.set(event, []);
    }
    eventHandlers.get(event).push(handler);

    // Register signal handler with os.signal if it's a signal event
    const signum = signalMap[event];
    if (signum !== undefined) {
      // Only register if this is the first handler for this signal
      if (eventHandlers.get(event).length === 1) {
        os.signal(signum, () => {
          const handlers = eventHandlers.get(event);
          if (handlers) {
            handlers.forEach(h => h());
          }
        });
      }
    }

    return this;
  },

  removeAllListeners(event) {
    if (event) {
      eventHandlers.delete(event);
      // Restore default signal handler
      const signum = signalMap[event];
      if (signum !== undefined) {
        os.signal(signum, null);
      }
    } else {
      // Remove all event handlers
      for (const [evt] of eventHandlers) {
        this.removeAllListeners(evt);
      }
    }
    return this;
  },

  // Internal: get handlers for an event (used by bootstrap)
  _getHandlers(event) {
    return eventHandlers.get(event) || [];
  },

  // Internal: emit exit event (used by bootstrap)
  _emitExit(code) {
    const handlers = eventHandlers.get('exit');
    if (handlers) {
      handlers.forEach(h => {
        try {
          h(code);
        } catch (e) {
          // Ignore errors in exit handlers
        }
      });
    }
  },

  // Internal: run a script with proper exit/exception handling (used by bootstraps)
  async _runScript(scriptPath) {
    try {
      await import(scriptPath);
    } catch (e) {
      const handlers = eventHandlers.get('uncaughtException');
      if (handlers && handlers.length) {
        handlers.forEach(h => h(e));
      } else {
        std.err.puts("Error loading script: " + e.message + "\n");
        if (e.stack) {
          std.err.puts(e.stack + "\n");
        }
        std.err.flush();
        _exitCode = 1;
      }
    } finally {
      this._emitExit(_exitCode);
      std.exit(_exitCode);
    }
  }
};

// Export as default for `import process from 'node:process'`
export default process;

// Also export individual properties for named imports
export const { argv, exit, cwd, chdir, pid, platform, version, versions, stdin, stdout, stderr, on, removeAllListeners, _getHandlers, _emitExit } = process;
export const env = process.env;  // Export env separately to preserve the Proxy
### Core Goals
Qn is supposed to be Node.js-semi-compatible runtime. More specifically: not every Node.js program will run on qn but every qn program using only the Node.js (shim) API should run on Node.js without modification. The goal is not to depend on any system libraries other than libc. Qn's main targets are POSIX systems (mainly Linux and Macos) but Windows compatibility is a plus and potential long term goal.

#### Building
Qn needs to vender all dependencies (directly or via git submodules) and be buildable using just make and a basic C compiler. It should have no build dependencies except (a posix shell, GNU make, a C compiler, ar, patch). It should never fetch anything during build, nor should it rely on files outside of the qn repository.

NOTE: We'd like to get rid of ar, patch and GNU make as requirements and just depend on POSIX make and a generic C compiler instead.

### Important documents
- @Readme.md
- @Makefile
- Read @architecture.md for an overview of the codebase structure and vendored dependencies.
- Read quickjs/doc/quickjs.texi to see what features are available in vanilla quickjs.



### Patch files
Never edit a patch file directly. Instead update the resulting code file and then regenerate the patch file from that.


### Architecture docs
When committing changes that affect the project structure (new modules, dependencies, etc.), check if `architecture.md` needs updating.


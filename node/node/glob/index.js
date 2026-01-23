/**
 * Picomatch - glob pattern matching
 *
 * Ported from micromatch/picomatch (MIT License)
 * https://github.com/micromatch/picomatch
 * Copyright (c) Jon Schlinkert
 *
 * This is a simplified port for Qn with the following changes:
 * - Converted from CommonJS to ES modules
 */

import pico from './picomatch.js';
import * as utils from './utils.js';

function picomatch(glob, options, returnState = false) {
  // default to os.platform()
  if (options && (options.windows === null || options.windows === undefined)) {
    // don't mutate the original options object
    options = { ...options, windows: utils.isWindows() };
  }

  return pico(glob, options, returnState);
}

// Copy all static methods from pico to picomatch
picomatch.test = pico.test;
picomatch.matchBase = pico.matchBase;
picomatch.isMatch = pico.isMatch;
picomatch.parse = pico.parse;
picomatch.scan = pico.scan;
picomatch.compileRe = pico.compileRe;
picomatch.makeRe = pico.makeRe;
picomatch.toRegex = pico.toRegex;
picomatch.constants = pico.constants;

export default picomatch;
export { picomatch };

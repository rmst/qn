# Picomatch - Glob Pattern Matching

This is a port of the picomatch glob matching library for Qn.

## Source

This code is ported from:

- **Repository:** https://github.com/micromatch/picomatch
- **Version:** 4.0.3
- **Commit:** `eec6f0bab6a05de4ffb6cf65357f4b5226a58dd9`
- **License:** MIT (Copyright Jon Schlinkert)

## Modifications

The following changes were made for Qn compatibility:

1. **ES Modules:** Converted from CommonJS (`require`/`module.exports`) to ES modules (`import`/`export`)

## Usage

```javascript
import picomatch from './glob/index.js';

// Create a matcher
const isMatch = picomatch('*.js');
console.log(isMatch('foo.js'));  // true
console.log(isMatch('foo.txt')); // false

// Direct match check
console.log(picomatch.isMatch('foo.js', '*.js')); // true

// Globstar patterns
const matcher = picomatch('**/*.js');
console.log(matcher('src/utils/helper.js')); // true
```

## Features

- `*` matches any characters except `/`
- `**` matches any characters including `/` (globstar)
- `?` matches a single character except `/`
- `[abc]` matches any character in the set
- `{a,b,c}` matches any of the alternatives
- `!(pattern)` negation
- `@(pattern)` match exactly one
- `+(pattern)` match one or more
- `*(pattern)` match zero or more

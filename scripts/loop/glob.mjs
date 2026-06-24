// glob.mjs - a tiny, dependency-free glob matcher for file paths.
//
// Supports the subset of glob needed by the policy's dangerous-edge patterns:
//   **   matches any number of path segments (including zero), crossing '/'
//   *    matches any run of characters within a single segment (not '/')
//   ?    matches a single character within a segment (not '/')
// Everything else is matched literally. Patterns are anchored to the whole path.

// Normalize a path or pattern: backslashes to slashes, strip a leading './'.
function normalize(p) {
  let s = String(p).replace(/\\/g, '/');
  if (s.startsWith('./')) s = s.slice(2);
  return s;
}

// Characters that are special in a RegExp and must be escaped when literal.
const REGEX_SPECIAL = /[.+^${}()|[\]\\]/;

export function globToRegExp(pattern) {
  const glob = normalize(pattern);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**' - consume both stars.
        i++;
        if (glob[i + 1] === '/') {
          // '**/' - zero or more leading segments.
          i++;
          re += '(?:.*/)?';
        } else {
          // '**' at end or mid-segment - match anything, including '/'.
          re += '.*';
        }
      } else {
        // single '*' - anything but a path separator.
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (REGEX_SPECIAL.test(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

// matchGlob(path, pattern) -> boolean
export function matchGlob(path, pattern) {
  return globToRegExp(pattern).test(normalize(path));
}

// matchAny(path, patterns) -> the first matching pattern, or null.
export function matchAny(path, patterns) {
  for (const pattern of patterns) {
    if (matchGlob(path, pattern)) return pattern;
  }
  return null;
}

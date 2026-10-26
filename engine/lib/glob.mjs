// Minimal glob matcher. `*` = within one path segment, `?` = one non-slash char,
// `**` (as a whole segment) = zero or more segments. A leading `*/` therefore
// matches exactly one top-level directory.

function segmentRegex(seg) {
  let re = '';
  for (const ch of seg) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function matchSegments(p, pi, g, gi) {
  while (gi < g.length) {
    if (g[gi] === '**') {
      while (g[gi + 1] === '**') gi++;
      if (gi === g.length - 1) return true;
      for (let k = pi; k <= p.length; k++) {
        if (matchSegments(p, k, g, gi + 1)) return true;
      }
      return false;
    }
    if (pi >= p.length || !segmentRegex(g[gi]).test(p[pi])) return false;
    pi++;
    gi++;
  }
  return pi === p.length;
}

export function matches(path, pattern) {
  return matchSegments(path.split('/'), 0, pattern.split('/'), 0);
}

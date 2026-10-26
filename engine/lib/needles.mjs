// Security-file "needles": the full paths of every current security finding's
// locations. Any public text that mentions one is withheld, because it would
// point at the security finding. A mention is the full path anywhere, or a
// path-like token that names it in any form (names(): ./src/index.ts,
// /abs/repo/<path>, src//index.ts, a bare index.ts), but never a different file
// sharing its basename (other/index.ts, index.tsx, index.ts.bak).
// Matching ignores case and treats '\' as '/', after undoing the cheap
// disguises: zero-width characters, HTML entities and percent-escapes for '.',
// '/' and '\'.
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const PATH_CHARS = { 46: '.', 47: '/', 92: '\\' };
const NAMED = { period: '.', sol: '/', bsol: '\\' };

function decodeOnce(s) {
  return s
    .replace(ZERO_WIDTH, '')
    .replace(/&#(\d{1,7});?/g, (m, d) => PATH_CHARS[Number(d)] ?? m)
    .replace(/&#x([0-9a-f]{1,6});?/gi, (m, h) => PATH_CHARS[parseInt(h, 16)] ?? m)
    .replace(/&(period|sol|bsol);/gi, (m, n) => NAMED[n.toLowerCase()])
    .replace(/%(2e|2f|5c)/gi, (m, h) => PATH_CHARS[parseInt(h, 16)]);
}

// Repeats a few times so double-encoding (%252E, &amp;#46;) does not help either.
export function normalise(s) {
  let t = String(s ?? '').replace(/&amp;/gi, '&');
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(t).replace(/%25/g, '%').replace(/&amp;/gi, '&');
    if (next === t) break;
    t = next;
  }
  return t.replace(/\\/g, '/').toLowerCase();
}

// One path-like string, canonical: normalised and trimmed; a line (:N, :N:N),
// anchor (#...) or query (?...) suffix and a trailing '~' backup marker
// dropped; '//' collapsed; '.' and '..' segments resolved (posix, never above
// the start); a leading '/', '~/', file:// scheme or drive letter stripped;
// trailing sentence dots removed. unanchored: it was absolute, home-relative
// or climbed above its start, so where it begins in the repo is unknown.
function parseNormalised(t) {
  let s = t.trim().replace(/^file:\/\//, '').replace(/[#?].*$/, '').replace(/:\d+(:\d+)?$/, '').replace(/~+$/, '');
  const absolute = s.startsWith('/') || s.startsWith('~/') || /^[a-z]:\//.test(s);
  s = s.replace(/^~\//, '/').replace(/^[a-z]:\//, '/');
  const parts = [];
  let up = false;
  for (const x of s.split('/')) {
    if (x === '' || x === '.') continue;
    if (x !== '..') parts.push(x);
    else if (parts.length) parts.pop();
    else up = true;
  }
  if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/\.+$/, '');
  return { parts: parts.filter(Boolean), unanchored: absolute || up };
}

export const parsePath = (p) => parseNormalised(normalise(p));

// A repo path as needles compare it.
export const pathKey = (p) => parsePath(p).parts.join('/');

// The path and each shorter suffix of it at a '/' boundary.
export const suffixPaths = (parts) => parts.map((_, k) => parts.slice(k).join('/'));

// Path-like tokens of a text (holding a '.' or '/'), parsed. Tokens stop at
// whitespace, quotes, ':', '#', '@', brackets, parentheses, '+', '$' and '~',
// so [index.ts](u), index.ts:12, `src/index.ts` and ~/src/index.ts all yield
// the path itself (a '~/' start counts as absolute, like '/').
const TOKEN_RE = /[a-z0-9_.\-/%]+/g;
export function pathTokens(text) {
  return (normalise(text).match(TOKEN_RE) ?? []).filter((t) => /[./]/.test(t)).map(parseNormalised);
}

export function securityNeedles(findings) {
  const out = new Set();
  for (const f of (findings ?? []).filter((x) => x && x.security)) {
    for (const l of f.locations ?? []) out.add(pathKey(l.file));
  }
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
}

function commonSuffix(a, b) {
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  return k;
}

// Whether a parsed path names the security file n (canonical parts): one is a
// '/'-boundary suffix of the other (src/index.ts, /repo/<path>), or an
// unanchored path shares at least its last two segments (/x/src/index.ts).
// other/index.ts or index.tsx never names src/index.ts.
// A root-level file (one segment) is named only by itself: a relative nested
// path sharing its basename (regroup/firebase.json) is a different file.
function names(p, n) {
  if (!p.parts.length || !n.length) return false;
  const k = commonSuffix(p.parts, n);
  if (n.length === 1 && !p.unanchored) return k === 1 && p.parts.length === 1;
  return k === n.length || k === p.parts.length || (p.unanchored && k >= 2);
}

const WORD = /[a-z0-9_]/;

// The full path anywhere (even inside text the tokens split), unless continued
// on the right: a word character next, or '.'/'-' then one (index.ts.bak). A
// root-level (one-segment) path must also not continue a longer path on the left.
const PATH_CHAR = /[a-z0-9_.\-/]/;
function occurs(t, n) {
  const root = !n.includes('/');
  for (let i = t.indexOf(n); i !== -1; i = t.indexOf(n, i + 1)) {
    if (root && i > 0 && PATH_CHAR.test(t[i - 1])) continue;
    const c = t[i + n.length] ?? '';
    if (!WORD.test(c) && !((c === '.' || c === '-') && WORD.test(t[i + n.length + 1] ?? ''))) return true;
  }
  return false;
}

export function mentions(text, needles) {
  if (!needles?.length) return false;
  const t = normalise(text);
  if (needles.some((n) => occurs(t, n))) return true;
  const ns = needles.map((n) => n.split('/'));
  return pathTokens(t).some((p) => ns.some((n) => names(p, n)));
}

const slugFile = (slug) => String(slug ?? '').split(':')[1] ?? '';
const slugAnchor = (slug) => String(slug ?? '').split(':').slice(2).join(':');

// A non-security finding that names a security file anywhere it would be
// published. Its locations and its slug's file part count when they name the
// security file in any form (names()); a different file sharing its basename
// does not count.
export function touchesSecurityFile(f, needles) {
  if (!f || f.security || !needles?.length) return false;
  const ns = needles.map((n) => n.split('/'));
  const files = [slugFile(f.slug), ...(f.locations ?? []).map((l) => l.file)];
  if (files.some((file) => ns.some((n) => names(parsePath(file), n)))) return true;
  return [slugAnchor(f.slug), f.title, f.why, f.fix, f.feature].some((t) => mentions(t, needles));
}

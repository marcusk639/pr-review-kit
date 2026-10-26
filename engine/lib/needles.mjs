// Security-file "needles": the paths and basenames of every current security
// finding's locations. Any public text that mentions one is withheld, because
// it would point at the security finding. Matching ignores case and treats '\'
// as '/', after undoing the cheap disguises: zero-width characters, HTML
// entities and percent-escapes for '.', '/' and '\'.
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

export function securityNeedles(findings) {
  const out = new Set();
  for (const f of (findings ?? []).filter((x) => x && x.security)) {
    for (const l of f.locations ?? []) {
      const file = normalise(l.file);
      out.add(file);
      out.add(file.split('/').pop());
    }
  }
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
}

export function mentions(text, needles) {
  if (!needles?.length) return false;
  const t = normalise(text);
  return needles.some((n) => t.includes(n));
}

// A non-security finding that names a security file anywhere it would be published.
export function touchesSecurityFile(f, needles) {
  if (!f || f.security || !needles?.length) return false;
  const texts = [f.slug, f.title, f.why, f.fix, f.feature, ...(f.locations ?? []).map((l) => l.file)];
  return texts.some((t) => mentions(t, needles));
}

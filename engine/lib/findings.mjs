// findings.json contract validation and the public security pointer.
import { SEVERITIES } from './ledger.mjs';
import { activeProject, classIds, securityClasses } from './config.mjs';

const CONFIDENCES = ['high', 'medium', 'low'];
const SIDES = ['changed', 'counterpart'];
const STRING_FIELDS = ['slug', 'package', 'area', 'title', 'feature', 'why', 'fix'];
export const SLUG_RE = /^c[1-9]\d{0,2}:[^\s>]+:[^\s>]+$/;
const PACKAGE_RE = /^[A-Za-z0-9_-]{1,40}(?:\/[A-Za-z0-9_-]{1,40})?$/;
const AREA_WORD = /^[a-z0-9-]{1,20}$/;
// Checklist classes that are security-relevant by definition (config.classes
// with security: true); the model's own flag cannot clear them. A verified
// private channel (publish checked the repo's readers) withholds nothing.
export function withheldClasses(project = activeProject()) {
  return project.privateVerified ? new Set() : securityClasses(project.config);
}
const SLUG_CLASS_RE = /^c(\d{1,3}):/;

// Forced security: the finding's class OR its slug's class prefix (`c<n>:`) is
// a security class. capFinding and the inline guard share this predicate.
export function isForcedSecurity(cls, slug, classes = withheldClasses()) {
  return classes.has(cls) || classes.has(Number(SLUG_CLASS_RE.exec(String(slug ?? ''))?.[1]));
}
// Bounds keep rendering, truncation and the ledger marker cheap whatever the model wrote.
export const MAX_FINDINGS = 200;
const MAX_LOCATIONS = 10;
const FIELD_CAPS = { package: 100, area: 100, title: 300, feature: 300, why: 2000, fix: 2000 };

function capFinding(f) {
  const out = { ...f, security: f.security || isForcedSecurity(f.class, f.slug), locations: f.locations.slice(0, MAX_LOCATIONS).map((l) => ({ ...l, file: l.file.slice(0, 300) })) };
  for (const [k, n] of Object.entries(FIELD_CAPS)) out[k] = f[k].slice(0, n);
  return out;
}

// Keeps at most MAX_FINDINGS, dropping the lowest severities first (stable within a severity).
function capFindings(list) {
  if (list.length <= MAX_FINDINGS) return list.map(capFinding);
  const ranked = list.map((f, i) => [SEVERITIES.indexOf(f.severity), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const keep = new Set(ranked.slice(0, MAX_FINDINGS).map(([, i]) => i));
  return list.filter((_, i) => keep.has(i)).map(capFinding);
}

function findingError(f, i) {
  const at = `findings[${i}]`;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return `${at} is not an object`;
  for (const k of STRING_FIELDS) if (typeof f[k] !== 'string' || !f[k].trim()) return `${at}.${k} missing`;
  if (f.slug.length > 300 || !SLUG_RE.test(f.slug)) return `${at}.slug malformed`;
  if (!Number.isInteger(f.class) || !classIds(activeProject().config).has(f.class)) return `${at}.class is not a configured class`;
  if (!SEVERITIES.includes(f.severity)) return `${at}.severity invalid`;
  if (!CONFIDENCES.includes(f.confidence)) return `${at}.confidence invalid`;
  // inlinePosted is optional and ignored: publish sets it from what it posted.
  if (typeof f.security !== 'boolean' || (f.inlinePosted !== undefined && typeof f.inlinePosted !== 'boolean')) return `${at} flags invalid`;
  if (f.reraise !== undefined && (typeof f.reraise !== 'string' || !f.reraise.trim() || f.reraise.length > 300)) return `${at}.reraise invalid`;
  if (!Array.isArray(f.locations) || f.locations.length === 0) return `${at}.locations empty`;
  for (const l of f.locations) {
    if (!l || typeof l.file !== 'string' || !l.file || !Number.isInteger(l.line) || l.line < 0 || !SIDES.includes(l.side)) {
      return `${at}.locations invalid`;
    }
  }
  return null;
}

// Accepts the raw file text or an already-parsed value.
export function validateFindings(json) {
  let v = json;
  if (typeof json === 'string') {
    try {
      v = JSON.parse(json);
    } catch {
      return { ok: false, error: 'not valid JSON' };
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'not an object' };
  if (typeof v.reviewedSha !== 'string') return { ok: false, error: 'reviewedSha missing' };
  if (!Array.isArray(v.findings)) return { ok: false, error: 'findings not an array' };
  if (!Array.isArray(v.resolvedSlugs) || v.resolvedSlugs.some((s) => typeof s !== 'string' || s.length > 300)) {
    return { ok: false, error: 'resolvedSlugs invalid' };
  }
  for (let i = 0; i < v.findings.length; i++) {
    const error = findingError(v.findings[i], i);
    if (error) return { ok: false, error };
  }
  // complete: the model's last write (REVIEW.md); a run cut off before it is not a completed review.
  return { ok: true, value: { reviewedSha: v.reviewedSha, findings: capFindings(v.findings), resolvedSlugs: v.resolvedSlugs.slice(0, MAX_FINDINGS), complete: v.complete === true } };
}

// The only public text a security finding ever gets. Package and area are
// whitelisted so a file name, line or mechanism cannot ride along in them.
export function safePackage(pkg) {
  return typeof pkg === 'string' && PACKAGE_RE.test(pkg.trim()) ? pkg.trim() : null;
}

// At most two short plain words; anything richer (a symbol, a file, a
// mechanism) becomes "general".
export function safeArea(area) {
  const words = String(area ?? '').trim().toLowerCase().split(/\s+/);
  return words.length <= 2 && words.every((w) => AREA_WORD.test(w)) ? words.join(' ') : 'general';
}

export function securityPointer({ severity, package: pkg, area }, clause = 'details sent privately') {
  const sev = SEVERITIES.includes(severity) ? severity : 'High';
  return `Security-relevant issue (${sev}) in ${safePackage(pkg) ?? 'an unnamed package'} ${safeArea(area)}; ${clause}`;
}

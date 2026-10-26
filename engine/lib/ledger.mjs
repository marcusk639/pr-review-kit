// Findings ledger entries carried in the summary comment's hidden marker (public).
// Security and withheld entries hold only an opaque id, severity, status (and,
// for security, keyed fileIds): never a slug, title, file or mechanism. Their
// ids are keyed (HMAC with PR_REVIEW_ID_KEY, held only by the publish step):
// slugs are guessable from the public diff, so a plain hash of one could be
// brute-forced back to the finding's file and symbol. Without the key no
// security or withheld entry is ever created; existing ones are carried
// unchanged. Public entries already show their slug, so their id is an unkeyed
// hash and they are matched by slug: a run before the key exists, or after it
// is rotated, still matches them.
import { redact } from './redact.mjs';
import { touchesSecurityFile } from './needles.mjs';
import { ID_RE, opaqueId } from './ids.mjs';
import { cleanFileIds, fileIdsOf } from './fileids.mjs';

export { opaqueId };

// The id a public (non-security, non-withheld) entry gets: never keyed.
export const publicId = (slug) => opaqueId(slug, null);

// A slug as a public entry stores it. Every slug comparison against the
// ledger goes through this, so a long slug (or one redaction changes) still
// matches its own entry.
export const ledgerSlug = (slug) => redact(slug).slice(0, MAX_SLUG);

// Which ledger entries this run's findings re-report: by keyed id (security
// and withheld entries) or by stored slug (public entries, whatever key made their id).
export function reportedBy(findings, key) {
  const ids = new Set((findings ?? []).map((f) => opaqueId(f.slug, key)));
  const slugs = new Set((findings ?? []).map((f) => ledgerSlug(f.slug)));
  return (e) => ids.has(e.id) || (typeof e.slug === 'string' && slugs.has(e.slug));
}

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const STATUSES = ['open', 'resolved', 'superseded'];
const MAX_TITLE = 120;
const MAX_SLUG = 200;

// fileIds: keyed hashes of the security finding's files, so later runs can
// withhold non-security findings on those files without the path being public.
function securityEntry(id, severity, status, runsSinceResolved, fileIds = []) {
  return { id, severity, status, security: true, runsSinceResolved, fileIds: cleanFileIds(fileIds) };
}

// A non-security finding that names a security file: no slug or title in public.
function withheldEntry(id, severity, status, runsSinceResolved) {
  return { id, severity, status, security: false, runsSinceResolved, withheld: true };
}

// Without a key, security findings get no ledger entry at all (never an unkeyed id).
export function toLedgerEntry(finding, key) {
  if (finding.security) return key ? securityEntry(opaqueId(finding.slug, key), finding.severity, 'open', 0, fileIdsOf([finding], key)) : null;
  return {
    id: publicId(finding.slug),
    slug: ledgerSlug(finding.slug),
    title: redact(finding.title).slice(0, MAX_TITLE),
    severity: finding.severity,
    status: 'open',
    security: false,
    runsSinceResolved: 0,
  };
}

// Normalises one prior entry read from state.json (which came from a public,
// editable comment). Returns null for anything that does not fit the contract.
export function sanitizeEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return null;
  if (!SEVERITIES.includes(e.severity) || !STATUSES.includes(e.status)) return null;
  const runs = Number.isInteger(e.runsSinceResolved) && e.runsSinceResolved >= 0 ? e.runsSinceResolved : 0;
  if (e.security === true) return securityEntry(e.id, e.severity, e.status, runs, e.fileIds);
  if (e.security === false && e.withheld === true) return withheldEntry(e.id, e.severity, e.status, runs);
  if (e.security !== false || typeof e.slug !== 'string' || typeof e.title !== 'string') return null;
  return {
    id: e.id,
    slug: redact(e.slug).slice(0, MAX_SLUG),
    title: redact(e.title).slice(0, MAX_TITLE),
    severity: e.severity,
    status: e.status,
    security: false,
    runsSinceResolved: runs,
  };
}

export function sanitizeLedger(list, key) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const e = sanitizeEntry(raw);
    // Security and withheld entries pass through even without the key: they are
    // already opaque, and dropping them would erase them from the ledger.
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

export const VISIBLE_RUNS = 5;

// What the summary may show: open entries, and resolved ones for VISIBLE_RUNS reviews.
export function visibleEntries(ledger) {
  return (ledger ?? []).filter((e) => e.status !== 'resolved' || e.runsSinceResolved < VISIBLE_RUNS);
}

const closed = (e) => e.status !== 'open';
const RANK = (e) => (e.status === 'open' ? 0 : 4) + SEVERITIES.indexOf(e.severity);

// Keeps the encoded marker under maxLen: first drops closed entries (oldest
// resolved first), then non-security titles, then the lowest-priority entries.
export function fitMarker(payload, encode, maxLen) {
  const fits = (ledger) => encode({ ...payload, ledger }).length <= maxLen;
  if (fits(payload.ledger)) return payload;
  let kept = [...payload.ledger];
  const byAge = kept.filter(closed).sort((a, b) => b.runsSinceResolved - a.runsSinceResolved);
  for (const e of byAge) {
    if (fits(kept)) return { ...payload, ledger: kept };
    kept = kept.filter((k) => k !== e);
  }
  if (fits(kept)) return { ...payload, ledger: kept };
  kept = kept.map((e) => ('title' in e ? { ...e, title: '' } : e)).sort((a, b) => RANK(a) - RANK(b));
  while (kept.length && !fits(kept)) kept.pop();
  return { ...payload, ledger: kept };
}

function withStatus(e, status, runsSinceResolved) {
  return { ...e, status, runsSinceResolved };
}

// An entry not re-reported this run: resolvedSlugs resolve it (age 0), an
// already-resolved one ages by a run, anything else keeps its status. Security
// and withheld entries are resolved only via the private channel, so the public
// resolved count cannot be used to test guesses at their slugs. Without the key
// they are frozen: carried fully untouched, not even aged.
function age(e, resolvedSlugs, key) {
  if (!key && (e.security || e.withheld)) return e;
  if (e.status === 'resolved') return withStatus(e, 'resolved', e.runsSinceResolved + 1);
  const resolvable = !e.security && !e.withheld && resolvedSlugs.has(e.slug);
  return resolvable ? withStatus(e, 'resolved', 0) : e;
}

// Prior entries plus this run's findings, matched by keyed id (security and
// withheld entries) or by slug (public entries). Tier "none" ran no model, so the ledger is returned as it was. Findings
// are grouped by slug: if any finding in a group, or the prior entry with that
// id, is security, the entry is security (not created when there is no key). A
// new non-security entry that names a security file anywhere is written
// withheld, with no slug or title. A prior entry that is already public stays
// public (rewriting it withheld would point at the file through the comment's
// edit history), keeping its public slug and title when re-reported. A finding
// reported this run is open even if its slug is also listed as resolved.
export function mergeLedger(prior, findings, resolvedSlugs, tier, { key = null, needles = [] } = {}) {
  if (tier === 'none') return sanitizeLedger(prior, key);
  const groups = new Map();
  for (const f of findings) {
    const g = groups.get(f.slug) ?? { f, security: false, withheld: false, all: [] };
    g.all.push(f);
    // A security finding wins the slug; among several, the most severe one.
    const graver = !g.security || SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(g.f.severity);
    if (f.security && graver) Object.assign(g, { f, security: true });
    if (touchesSecurityFile(f, needles)) g.withheld = true;
    groups.set(f.slug, g);
  }
  const old = sanitizeLedger(prior, key);
  const wasSecurity = new Map(old.filter((e) => e.security).map((e) => [e.id, e]));
  const wasPublic = new Map(old.filter((e) => !e.security && !e.withheld).map((e) => [e.slug, e]));
  const resolved = new Set((resolvedSlugs ?? []).map(ledgerSlug));
  const reported = reportedBy(findings, key);
  const current = [];
  for (const { f, security, withheld, all } of groups.values()) {
    const id = opaqueId(f.slug, key);
    const pub = wasPublic.get(ledgerSlug(f.slug));
    if (security || wasSecurity.has(id)) {
      const fileIds = [...fileIdsOf(all, key), ...(wasSecurity.get(id)?.fileIds ?? [])];
      if (key) current.push(securityEntry(id, f.severity, 'open', 0, fileIds));
    } else if (withheld && pub) {
      current.push({ ...pub, id: publicId(f.slug), severity: f.severity, status: 'open', runsSinceResolved: 0 });
    } else if (withheld) {
      if (key) current.push(withheldEntry(id, f.severity, 'open', 0));
    } else {
      current.push(toLedgerEntry(f, key));
    }
  }
  return [...old.filter((e) => !reported(e)).map((e) => age(e, resolved, key)), ...current];
}

// Dispositioned outside the review (an advisory closed, a maintainer's reply):
// open entries matching pred become resolved this run.
export function markResolved(ledger, pred) {
  return ledger.map((e) => (e.status === 'open' && pred(e) ? withStatus(e, 'resolved', 0) : e));
}

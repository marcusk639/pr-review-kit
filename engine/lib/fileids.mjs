// Keyed hashes of security findings' files ("fileIds"), carried in the public
// ledger instead of paths. A later run hashes the paths it sees (finding
// locations, slug file parts, path-like narrative tokens) and treats any match
// as a security file, so withholding outlasts the run that found it.
import { ID_RE, opaqueId } from './ids.mjs';
import { normalise, securityNeedles } from './needles.mjs';

export const MAX_FILE_IDS = 10;

export const fileId = (path, key) => opaqueId(normalise(path), key);

export function cleanFileIds(list) {
  const ids = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && ID_RE.test(x)) : [];
  return [...new Set(ids)].slice(0, MAX_FILE_IDS);
}

export function fileIdsOf(findings, key) {
  if (!key) return [];
  return cleanFileIds((findings ?? []).flatMap((f) => (f.locations ?? []).map((l) => fileId(l.file, key))));
}

export function priorFileIds(ledger) {
  return new Set((ledger ?? []).filter((e) => e?.security).flatMap((e) => cleanFileIds(e.fileIds)));
}

const slugFile = (slug) => String(slug ?? '').split(':')[1] ?? '';
const TOKEN_RE = /[a-z0-9_.\-/]*[./][a-z0-9_.\-/]*/g;

// Every path this run might publish: locations, slug file parts, narrative tokens.
export function candidatePaths(findings, texts = []) {
  const out = new Set();
  for (const f of findings ?? []) {
    for (const l of f.locations ?? []) out.add(normalise(l.file));
    out.add(normalise(slugFile(f.slug)));
  }
  for (const t of texts) {
    for (const tok of normalise(t).match(TOKEN_RE) ?? []) out.add(tok.replace(/^\.\//, '').replace(/[.]+$/, ''));
  }
  return [...out].filter(Boolean);
}

// The candidates that hash to a prior security fileId, as needles (path + basename).
export function hashedNeedles(candidates, ids, key) {
  if (!key || !ids?.size) return [];
  const out = new Set();
  for (const c of candidates) {
    if (!ids.has(fileId(c, key))) continue;
    out.add(c);
    out.add(c.split('/').pop());
  }
  return [...out].filter(Boolean);
}

export const isPriorSecurityPath = (path, ids, key) => Boolean(key && ids?.size && ids.has(fileId(path, key)));

// This run's needles: current security findings' files plus any candidate
// path that hashes to a prior security fileId.
export function runNeedles(findings, texts, ids, key) {
  const all = new Set([...securityNeedles(findings), ...hashedNeedles(candidatePaths(findings, texts), ids, key)]);
  return [...all].sort((a, b) => b.length - a.length);
}

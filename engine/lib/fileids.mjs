// Keyed hashes of security findings' files ("fileIds"), carried in the public
// ledger instead of paths. A later run hashes the paths it sees (finding
// locations, slug file parts, path-like narrative tokens) and treats any match
// as a security file, so withholding outlasts the run that found it.
import { ID_RE, opaqueId } from './ids.mjs';
import { parsePath, pathKey, pathTokens, securityNeedles, suffixPaths } from './needles.mjs';

export const MAX_FILE_IDS = 10;

export const fileId = (path, key) => opaqueId(pathKey(path), key);

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

// Every path this run might publish (locations, slug file parts, path-like
// tokens of the texts), canonical, with each '/'-boundary suffix, so an
// absolute or ./-prefixed form still hashes to the repo path's fileId.
export function candidatePaths(findings, texts = []) {
  const out = new Set();
  const add = (p) => suffixPaths(p.parts).forEach((x) => out.add(x));
  for (const f of findings ?? []) {
    for (const l of f.locations ?? []) add(parsePath(l.file));
    add(parsePath(slugFile(f.slug)));
  }
  for (const t of texts) pathTokens(t).forEach(add);
  return [...out].filter(Boolean);
}

// The candidates that hash to a prior security fileId, as needles (full paths;
// mentions() matches their basename only as a bare token).
export function hashedNeedles(candidates, ids, key) {
  if (!key || !ids?.size) return [];
  return [...new Set(candidates.filter((c) => c && ids.has(fileId(c, key))))];
}

export const isPriorSecurityPath = (path, ids, key) => Boolean(key && ids?.size && ids.has(fileId(path, key)));

// This run's needles: current security findings' files plus any candidate
// path that hashes to a prior security fileId. paths: the PR's changed files
// (facts' trusted list), so a prior security file this PR touches is found by
// its full path even where public text names only its basename.
export function runNeedles(findings, texts, ids, key, paths = []) {
  const candidates = [...candidatePaths(findings, texts), ...(paths ?? []).filter((p) => typeof p === 'string').map(pathKey)];
  const all = new Set([...securityNeedles(findings), ...hashedNeedles(candidates, ids, key)]);
  return [...all].sort((a, b) => b.length - a.length);
}

// Prior review state for publish: the trusted snapshot's fields, sanitized, or
// (when facts could not read them) a re-read of the existing summary comment.
// The history is never replaced by empty defaults it could not read.
import { listIssueComments } from './gh.mjs';
import { findSummary } from './state.mjs';
import { decodeLedger, rawLedgerMarker } from './markers.mjs';
import { sanitizeLedger } from './ledger.mjs';

const SHA_RE = /^[0-9a-f]{40}$/i;

const LEDGER_TEXT = /pr-review:ledger/;

export const PRIOR_NOTICE = '> prior review state unavailable; findings history preserved unchanged';

export const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
export const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string') : []);

// Lower-cased so comparisons with git and the API (always lower case) match.
export function sha(v) {
  return typeof v === 'string' && SHA_RE.test(v) ? v.toLowerCase() : null;
}

// The marker payload a prior state stands for: SHAs checked, link types limited
// to routing.json's, the ledger sanitized (security entries reshaped).
export function priorPayload(p, idKey, linkTypes) {
  const s = isObject(p) ? p : {};
  const known = new Set(linkTypes ?? []);
  return {
    lastReviewedSha: sha(s.lastReviewedSha),
    lastBaseSha: sha(s.lastBaseSha),
    // linkTypes null (routing.json unreadable): carried through, not erased.
    linkTypesSeen: [...new Set(strings(s.linkTypesSeen).filter((t) => !linkTypes || known.has(t)))],
    ledger: sanitizeLedger(s.ledger, idKey),
  };
}

// Prior state from the existing summary comment (same author and marker rule
// as loadState). null when the comments cannot be read.
export async function priorFromComment(repo, pr, list = listIssueComments) {
  let comments;
  try {
    comments = await list(repo, pr);
  } catch {
    return null;
  }
  const summary = findSummary(comments);
  if (!summary) return { state: {}, found: false };
  const payload = decodeLedger(summary.body);
  if (isObject(payload)) return { state: payload, found: true };
  // A summary with no ledger marker at all has nothing to preserve.
  if (!LEDGER_TEXT.test(String(summary.body))) return { state: {}, found: true };
  // unreadable: a marker is there but does not decode to an object.
  return { state: {}, found: true, rawMarker: rawLedgerMarker(summary.body), unreadable: true };
}

const PRIOR_FIELDS = ['lastReviewedSha', 'lastBaseSha', 'ledger', 'linkTypesSeen'];

// For a snapshot facts flagged priorUnavailable: re-read the comment. A
// decodable marker supplies the prior fields; otherwise the old marker (from
// the re-read, else the one facts saw) is re-emitted verbatim with PRIOR_NOTICE.
// "No summary" on the re-read counts as a fresh start only when facts did not
// see a marker either: a summary that vanished (or a listing that came back
// short) must not wipe a history facts knows exists.
// skip: no marker known at all, so the summary must not be rewritten.
export async function resolvePrior(repo, pr, snapshot, list) {
  if (!isObject(snapshot) || snapshot.priorUnavailable !== true) return { snapshot };
  const again = await priorFromComment(repo, pr, list);
  const seen = rawLedgerMarker(String(snapshot.priorRawMarker ?? ''));
  const decoded = again && again.found !== false && !('rawMarker' in again);
  const fresh = again && again.found === false && !seen;
  if (decoded || fresh) {
    const fields = Object.fromEntries(PRIOR_FIELDS.map((k) => [k, again.state[k]]));
    return { snapshot: { ...snapshot, ...fields, priorUnavailable: false } };
  }
  const raw = again?.rawMarker ?? seen;
  if (!raw) return { snapshot, skip: true };
  return { snapshot, rawMarker: raw, notice: PRIOR_NOTICE };
}

// Upserts the summary comment. A failed update is retried once with a minimal,
// fixed banner that re-emits the previous marker (when known), so the comment
// never keeps claiming an older review silently. Logs status codes only.
import { SUMMARY_MARKER, rawLedgerMarker } from './markers.mjs';
import { findSummary } from './state.mjs';
import { sha } from './prior.mjs';

export const statusOf = (err) => (Number.isInteger(err?.status) ? err.status : 'unknown');
const status = statusOf;

export function minimalBody(headSha, code, previousMarker) {
  const short = String(headSha ?? '').slice(0, 7) || 'unknown';
  const lines = [SUMMARY_MARKER, '## PR review (advisory)', `> ⚠ summary could not be updated for \`${short}\` (status ${code})`];
  if (previousMarker) lines.push(previousMarker);
  return lines.join('\n\n');
}

export async function postSummary(repo, pr, body, upsert, { headSha, previousMarker = null } = {}) {
  try {
    await upsert(repo, pr, body);
    return true;
  } catch (err) {
    const code = status(err);
    console.log(`::warning::pr-review summary update failed (${code})`);
    try {
      await upsert(repo, pr, minimalBody(headSha, code, previousMarker));
    } catch (again) {
      console.log(`publish: minimal summary failed: ${status(again)}`);
    }
    return false;
  }
}

// The PR's current head ({ sha }), or why it could not be read ({ sha: null,
// error }). Publish then goes ahead with a warning: a stale-run check that
// fails must not silence every review.
export async function currentHead(repo, pr, request) {
  if (!request) return { sha: null, error: 'no API client' };
  try {
    const head = sha((await request('GET', `/repos/${repo}/pulls/${pr}`))?.head?.sha);
    return head ? { sha: head } : { sha: null, error: 'no head in response' };
  } catch (err) {
    return { sha: null, error: statusOf(err) };
  }
}

// Last resort when publish could not write the real summary: the minimal
// banner, re-emitting the existing summary's marker so the history survives.
// Only an existing summary is replaced: when this listing shows none, nothing
// is posted (upsert lists again, and a summary that listing missed must not be
// overwritten without its marker). Nothing is posted either when the comments
// cannot be read or the existing marker cannot be carried over.
export async function fallbackSummary(repo, pr, headSha, deps, code) {
  let comments;
  try {
    comments = await deps.listIssueComments(repo, pr);
  } catch {
    return false;
  }
  const summary = findSummary(comments);
  if (!summary) return false;
  const marker = rawLedgerMarker(summary.body);
  if (!marker && /pr-review:ledger/.test(String(summary.body))) return false;
  try {
    await deps.upsertSummary(repo, pr, minimalBody(headSha, code, marker));
    return true;
  } catch (err) {
    console.log(`publish: minimal summary failed: ${statusOf(err)}`);
    return false;
  }
}

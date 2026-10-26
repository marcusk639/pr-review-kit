import { BOT_AUTHOR, SUMMARY_MARKER, decodeLedger, extractInlineSlugs, rawLedgerMarker } from './markers.mjs';
import { activeProject, resolveAuthors } from './config.mjs';
import { feedbackRecords, isEdited, prFeedback, reviewText } from './feedback.mjs';

// Both the summary and the inline comments are posted by publish.
const SUMMARY_AUTHOR = BOT_AUTHOR;
const INLINE_AUTHOR = BOT_AUTHOR;
const SHA_RE = /^[0-9a-f]{40}$/;

const FP_RE = /<!-- pr-review:fp=([^ >]+) -->/;
const MAX_ACK = 200;

const EMPTY = () => ({ lastReviewedSha: null, lastBaseSha: null, ledger: [], linkTypesSeen: [], inlineSlugs: [], acknowledgedSlugs: [], feedback: { rejectedSlugs: [], corrections: [] } });
const sha = (v) => (typeof v === 'string' && SHA_RE.test(v) ? v : null);

function fromPayload(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
  return {
    lastReviewedSha: sha(p.lastReviewedSha),
    lastBaseSha: sha(p.lastBaseSha),
    ledger: Array.isArray(p.ledger) ? p.ledger.filter((e) => e && typeof e === 'object' && !Array.isArray(e)) : [],
    linkTypesSeen: Array.isArray(p.linkTypesSeen) ? p.linkTypesSeen.filter((t) => typeof t === 'string') : [],
  };
}

// The one summary comment: posted by the workflow bot, first line the marker.
export function findSummary(comments) {
  return (comments ?? []).find(
    (c) => c?.user?.login === SUMMARY_AUTHOR && typeof c.body === 'string' && c.body.startsWith(SUMMARY_MARKER),
  );
}

// Slugs of publish's inline comments a trusted maintainer replied to in-thread
// with a "review:" reply (not edited): the finding is dispositioned (REVIEW.md:
// do not re-raise; publish resolves it unless it is Critical or security).
export function acknowledgedSlugs(reviewComments, trusted = []) {
  const all = reviewComments ?? [];
  const ok = new Set(trusted.map((t) => String(t).toLowerCase()));
  const replied = new Set(
    all
      .filter((c) => c?.user?.login !== INLINE_AUTHOR && c?.user?.type !== 'Bot' && ok.has(String(c?.user?.login).toLowerCase()) && c.in_reply_to_id != null && !isEdited(c) && reviewText(c.body) != null)
      .map((c) => c.in_reply_to_id),
  );
  const out = [];
  for (const c of all) {
    const m = c?.user?.login === INLINE_AUTHOR && replied.has(c.id) ? FP_RE.exec(String(c.body ?? '')) : null;
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out.slice(0, MAX_ACK);
}

// Reactions are listed only for the bot's inline comments that have some.
async function reactionsFor(repo, comments, listReactions) {
  const out = {};
  if (!listReactions) return out;
  for (const c of comments) {
    const r = c?.reactions;
    if (c?.user?.login !== INLINE_AUTHOR || !r || !(r['+1'] > 0 || r['-1'] > 0)) continue;
    out[c.id] = await listReactions(repo, c.id);
  }
  return out;
}

export async function loadState(repo, pr, { listIssueComments, listReviewComments, listReactions }) {
  const state = EMPTY();
  let comments = [];
  try {
    comments = await listIssueComments(repo, pr);
    const summary = findSummary(comments);
    const decoded = summary ? decodeLedger(summary.body) : null;
    // Only a plain object is a ledger; an array or a marker outside the
    // base64 charset is unreadable, never "no history".
    const payload = decoded && !Array.isArray(decoded) ? decoded : null;
    const raw = summary && !payload ? rawLedgerMarker(summary.body) : null;
    if (payload) Object.assign(state, fromPayload(payload));
    else if (raw || /pr-review:ledger/.test(String(summary?.body ?? ''))) {
      Object.assign(state, { priorUnavailable: true, priorUnavailableReason: 'marker-undecodable', ...(raw ? { priorRawMarker: raw } : {}) });
    }
  } catch {
    Object.assign(state, { priorUnavailable: true, priorUnavailableReason: 'comments-unreadable' });
  }
  try {
    const reviews = await listReviewComments(repo, pr);
    state.inlineSlugs = extractInlineSlugs(reviews.filter((c) => c.user?.login === INLINE_AUTHOR).map((c) => c.body));
    const trusted = resolveAuthors(activeProject().config.trust.feedbackAuthors, repo);
    state.acknowledgedSlugs = acknowledgedSlugs(reviews, trusted);
    // Trusted feedback on earlier findings: 👎 means "do not re-raise", text is a correction.
    const reactions = await reactionsFor(repo, reviews, listReactions);
    state.feedback = prFeedback(feedbackRecords({ pr, reviewComments: reviews, issueComments: comments, reactions, ledger: state.ledger, trusted }));
  } catch {
    // keep defaults
  }
  return state;
}

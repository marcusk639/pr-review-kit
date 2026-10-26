// Publish's inline stage: post the survivors of OUT/inline.json (completed
// reviews only), then run the post-hoc guard over this run's github-actions[bot]
// review comments (whatever the outcome). Returns the posted slugs and any
// fixed notices for the summary. Logs status codes and counts only.
import { mentions } from './needles.mjs';
import { sanitizeLedger } from './ledger.mjs';
import { BOT_AUTHOR, extractInlineSlugs } from './markers.mjs';
import { candidatePaths, isPriorSecurityPath, priorFileIds, runNeedles } from './fileids.mjs';
import { guardInlineComments } from './inline-guard.mjs';
import { inlineEligible, newDrops, postInlineReview, readInline, selectInline } from './inline-post.mjs';

export const INLINE_NOTICE = '> an inline comment could not be removed automatically; please review';
export const INLINE_POST_NOTICE = '> some inline comments could not be posted';
export const INLINE_READ_NOTICE = '> inline.json could not be read; no inline comments were posted';
export const lostNotice = (n) => `> ${n} inline comment(s) for Critical or High findings were not posted (malformed, outside the PR's changed files, or over the limit of 10); those findings are listed below`;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const status = (err) => (Number.isInteger(err?.status) ? err.status : 'unknown');
const strings = (l) => (Array.isArray(l) ? l.filter((s) => typeof s === 'string') : []);

// Current security findings' files, plus any path (a changed file, or a
// path-like token of a body) hashing to a prior security fileId (keyed only).
function securityPathTest(findings, snapshot, key) {
  const ids = priorFileIds(sanitizeLedger(isObject(snapshot) ? snapshot.ledger : [], key));
  const needles = runNeedles(findings, [], ids, key, strings(snapshot?.changedFiles));
  const namesPrior = (t) => candidatePaths([], [t]).some((p) => isPriorSecurityPath(p, ids, key));
  const test = (t) => mentions(t, needles) || isPriorSecurityPath(t, ids, key) || namesPrior(t);
  return { test, needles };
}

async function list(deps, repo, pr) {
  try {
    return await deps.listReviewComments(repo, pr);
  } catch (err) {
    console.log(`inline: listing failed: ${status(err)}`);
    return null;
  }
}

// findings: this run's validated findings, or null when the review did not complete.
// notPosted: comments the maintainer should know were not posted (failed
// posts, lost Critical/High drops, an unreadable inline.json counts as one).
export async function runInline({ repo, pr, snapshot, findings, inlineText, idKey, headSha, runStartedAt }, deps) {
  const posted = new Set();
  if (!deps.listReviewComments) return { posted, notices: [], notPosted: 0 };
  const notices = [];
  let notPosted = 0;
  const key = idKey || null;
  const { test: isSecurityPath, needles } = securityPathTest(findings ?? [], snapshot, key);
  const before = findings ? await list(deps, repo, pr) : null;
  const read = readInline(inlineText);
  if (findings && before) {
    const ours = before.filter((c) => c?.user?.login === BOT_AUTHOR).map((c) => c.body);
    const drops = newDrops();
    const comments = selectInline({
      entries: read.entries,
      findings,
      changedFiles: strings(snapshot?.changedFiles),
      postedSlugs: extractInlineSlugs(ours),
      isSecurityPath,
      needles,
      drops,
    });
    // Invalid entries count as lost only when they name an eligible finding.
    const eligible = new Set(findings.filter((f) => inlineEligible(f, needles)).map((f) => f.slug));
    // A slug whose comment was kept from another entry is not lost.
    const kept = new Set(comments.map((c) => c.slug));
    const lost = new Set([...drops.lost, ...read.invalidSlugs.filter((s) => eligible.has(s))].filter((s) => !kept.has(s)));
    console.log(`inline select: kept ${comments.length}, invalid ${read.invalid}, not-a-finding ${drops.notFinding}, ineligible ${drops.ineligible}, already-posted ${drops.duplicate}, outside-changed-files ${drops.path}, unsafe ${drops.unsafe}, over-cap ${drops.overCap}`);
    if (read.malformed) notices.push(INLINE_READ_NOTICE);
    if (lost.size) notices.push(lostNotice(lost.size));
    notPosted += lost.size + (read.malformed ? 1 : 0);
    const res = await postInlineReview({ repo, pr, headSha, comments, request: deps.request });
    for (const s of res.posted) posted.add(s);
    if (res.failed) notices.push(INLINE_POST_NOTICE);
    notPosted += res.failed;
    console.log(`inline post: posted ${res.posted.length}, failed ${res.failed}`);
  } else if (findings && (read.entries.length || read.malformed)) {
    notices.push(INLINE_POST_NOTICE);
    notPosted += Math.max(1, read.entries.length);
  }
  const after = await list(deps, repo, pr);
  if (!after) return { posted, notices: [...notices, INLINE_NOTICE], notPosted };
  // The workflow's run start (captured before the review step), else facts'.
  const start = runStartedAt || (isObject(snapshot) ? snapshot.runStartedAt : null);
  const res = await guardInlineComments({ repo, comments: after, findings: findings ?? [], headSha, runStartedAt: start, isSecurityPath, request: deps.request });
  console.log(`inline guard: removed ${res.removed}, failed ${res.failed}`);
  for (const s of res.removedSlugs ?? []) posted.delete(s);
  return { posted, notices: res.failed ? [...notices, INLINE_NOTICE] : notices, notPosted };
}

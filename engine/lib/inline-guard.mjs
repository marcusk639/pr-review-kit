// Technical guard for inline comments. The model has no inline tool: publish
// posts them (inline-post.mjs) after running unsafeInline() over each one as a
// pre-filter. This post-hoc pass is the backstop: this run's top-level
// github-actions[bot] review comments are deleted when they carry a security
// fingerprint (by findings.json or by checklist class), carry no fingerprint at
// all, match a secret pattern, or sit on / name a security file. claude[bot]
// comments are left alone. Logs counts only; never a path, body or id.
import { ghRequest } from './gh.mjs';
import { secretPatterns } from './redact.mjs';
import { isForcedSecurity } from './findings.mjs';
import { BOT_AUTHOR } from './markers.mjs';

const FP_RE = /<!-- pr-review:fp=([^ >]+) -->/;

// "This run" needs both: created at or after the run start (captured before
// the review step) AND first posted on this head. GitHub moves an older
// comment's commit_id to the new head when its line is unchanged, so only
// original_commit_id counts. Replies (in_reply_to_id) are never ours: publish
// posts top-level comments only.
function thisRun(c, headSha, runStartedAt) {
  if (c?.user?.login !== BOT_AUTHOR || c.in_reply_to_id != null) return false;
  if (!headSha || c.original_commit_id !== headSha) return false;
  const start = Date.parse(runStartedAt ?? '');
  const created = Date.parse(c.created_at ?? '');
  return Number.isFinite(start) && Number.isFinite(created) && created >= start;
}

// Shared by the pre-filter (on the body publish would post, fp marker
// included) and the post-hoc guard (on a posted comment).
export function unsafeInline(c, securitySlugs, isSecurityPath) {
  const body = String(c?.body ?? '');
  const m = FP_RE.exec(body);
  if (!m) return true;
  const slug = m[1];
  if (securitySlugs.has(slug) || isForcedSecurity(undefined, slug)) return true;
  if (secretPatterns().some((re) => new RegExp(re.source).test(body))) return true;
  return Boolean(isSecurityPath(String(c.path ?? '')) || isSecurityPath(String(slug.split(':')[1] ?? '')) || isSecurityPath(body));
}

export const securitySlugsOf = (findings) => new Set((findings ?? []).filter((f) => f?.security).map((f) => f.slug));

export async function guardInlineComments({ repo, comments, findings = [], headSha, runStartedAt, isSecurityPath = () => false, request = ghRequest }) {
  const securitySlugs = securitySlugsOf(findings);
  let removed = 0;
  let failed = 0;
  // Slugs whose comment was deleted: publish must not report them as posted.
  const removedSlugs = [];
  for (const c of comments ?? []) {
    if (!thisRun(c, headSha, runStartedAt) || !unsafeInline(c, securitySlugs, isSecurityPath)) continue;
    if (!Number.isInteger(c.id)) {
      failed++;
      continue;
    }
    try {
      await request('DELETE', `/repos/${repo}/pulls/comments/${c.id}`);
      removed++;
      const m = FP_RE.exec(String(c.body ?? ''));
      if (m) removedSlugs.push(m[1]);
    } catch (err) {
      failed++;
      console.log(`inline guard: delete failed: ${Number.isInteger(err?.status) ? err.status : 'unknown'}`);
    }
  }
  return { removed, failed, removedSlugs };
}

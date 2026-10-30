// Publish's post-hoc check on the model's reply (config.model.reply). The
// reply command checks the text against findings.json as it stood when the
// model ran it, but the model can rewrite findings.json afterwards. So publish
// re-checks this run's reply comments against the final findings and every
// prior security file, and deletes one that names a security finding, its
// file, or a secret: the same predicate family as the inline guard.
import { REPLY_MARKER } from './reply.mjs';
import { secretPatterns } from './redact.mjs';
import { securitySlugsOf } from './inline-guard.mjs';
import { isForcedSecurity } from './findings.mjs';
import { securityPathTest } from './inline-stage.mjs';
import { activeProject } from './config.mjs';

export const REPLY_GUARD_NOTICE = "> the reviewer's reply could not be removed automatically; please review";

const status = (err) => (Number.isInteger(err?.status) ? err.status : 'unknown');

// A reply this run posted: bot-authored, carries the marker, created at or
// after the run started (never a maintainer's comment quoting the marker).
function thisRunsReply(c, runStartedAt) {
  if (c?.user?.type !== 'Bot' || !String(c?.body ?? '').includes(REPLY_MARKER)) return false;
  const start = Date.parse(runStartedAt ?? '');
  const created = Date.parse(c?.created_at ?? '');
  return Number.isFinite(start) && Number.isFinite(created) && created >= start;
}

export function unsafeReply(body, findings, isSecurityPath) {
  const text = String(body ?? '');
  const slugs = [...securitySlugsOf(findings)];
  for (const f of findings ?? []) if (isForcedSecurity(f?.class, f?.slug)) slugs.push(f.slug);
  if (slugs.some((s) => typeof s === 'string' && s && text.includes(s))) return true;
  if (secretPatterns().some((re) => new RegExp(re.source).test(text))) return true;
  return Boolean(isSecurityPath(text));
}

// findings: this run's validated findings, or null (incomplete run: only the
// prior security files and secret patterns apply). Returns { removed, failed, notices }.
export async function runReplyGuard({ repo, pr, snapshot, findings, idKey, runStartedAt }, deps, project = activeProject()) {
  const none = { removed: 0, failed: 0, notices: [] };
  if (project.config.model?.reply !== true || !deps.listIssueComments || !deps.request) return none;
  let comments;
  try {
    comments = await deps.listIssueComments(repo, pr);
  } catch (err) {
    console.log(`reply guard: listing failed: ${status(err)}`);
    return { ...none, failed: 1, notices: [REPLY_GUARD_NOTICE] };
  }
  const start = runStartedAt || snapshot?.runStartedAt;
  const { test } = securityPathTest(findings ?? [], snapshot, idKey || null);
  let removed = 0;
  let failed = 0;
  for (const c of comments ?? []) {
    if (!thisRunsReply(c, start) || !unsafeReply(c.body, findings ?? [], test)) continue;
    try {
      if (!Number.isInteger(c.id)) throw new Error('no id');
      await deps.request('DELETE', `/repos/${repo}/issues/comments/${c.id}`);
      removed++;
    } catch (err) {
      failed++;
      console.log(`reply guard: delete failed: ${status(err)}`);
    }
  }
  console.log(`reply guard: removed ${removed}, failed ${failed}`);
  return { removed, failed, notices: failed ? [REPLY_GUARD_NOTICE] : [] };
}

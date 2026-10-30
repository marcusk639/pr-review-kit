// Publishes the PR review: the inline comments from OUT/inline.json (as one PR
// review), private advisories for security findings, then the one summary
// comment from OUT/{findings.json,summary.md} and the trusted STATE_FILE
// snapshot (never OUT/state.json). Runs from the kit's pinned action path
// after the model has finished, with the project config from a fresh base
// checkout, so nothing the model wrote can change this code or its config.
// Entry point: run-publish.mjs.
// A run for a head the PR has moved past posts nothing. Logs status codes
// only, warns on anything that leaves the summary stale, writes one status
// line to the job summary, and always exits 0.
import { listIssueComments, upsertSummary } from './lib/gh.mjs';
import { encodeLedger } from './lib/markers.mjs';
import { fitMarker, ledgerSlug, markResolved, mergeLedger, opaqueId, reportedBy, visibleEntries } from './lib/ledger.mjs';
import { MAX_MARKER, renderSummary } from './lib/render.mjs';
import { completedFindings, completion, failureReason, isPartial, outcomeLabel } from './lib/completion.mjs';
import { DELIVERED, NOT_DELIVERED, NO_CHANNEL, NO_KEY, deliver } from './lib/deliver.mjs';
import { isObject, priorFromComment, priorPayload, resolvePrior, sha, strings } from './lib/prior.mjs';
import { currentHead, fallbackSummary, postSummary, statusOf } from './lib/summary-post.mjs';
import { stepSummary, warn } from './lib/status.mjs';
import { touchesSecurityFile } from './lib/needles.mjs';
import { priorFileIds, runNeedles } from './lib/fileids.mjs';
import { runInline, INLINE_NOTICE } from './lib/inline-stage.mjs';
import { runReplyGuard } from './lib/reply-guard.mjs';
import { deliverAdvisories } from './advisories.mjs';
import { activeProject } from './lib/config.mjs';

export { INLINE_NOTICE, priorFromComment, failureReason };

// Link types publish will carry forward: only those the project's routing.json
// defines. null when no project is loaded: prior link types are then carried
// through unfiltered rather than erased.
export function knownLinkTypes() {
  const p = activeProject();
  if (!p.dir) {
    warn('routing.json unavailable; link types carried through unfiltered');
    return null;
  }
  return p.linkTypes;
}

// Tier "none" (facts found nothing new; the review step was skipped): only the
// SHAs move. The ledger and linkTypesSeen stay as they were; an old marker that
// could not be read is re-emitted verbatim rather than replaced by an empty one.
function noChangeBody(prior, headSha, baseSha, notices, rawMarker) {
  const head = sha(headSha) ?? prior.lastReviewedSha;
  const base = sha(baseSha) ?? prior.lastBaseSha;
  const since = String(prior.lastReviewedSha ?? head ?? '').slice(0, 7);
  const baseMoved = Boolean(prior.lastBaseSha && base && base !== prior.lastBaseSha);
  const note = baseMoved ? `Base updated; no counterpart changes since \`${since}\`.` : `No new changes since \`${since}\`.`;
  const ledger = { ...prior, lastReviewedSha: head, lastBaseSha: base };
  return renderSummary({ state: {}, findings: null, narrative: '', outcome: 'none', note, ledger, notices, rawMarker });
}

// Findings to mark "(new)": none on a first review. Without the id key,
// security and withheld findings have no prior entry to compare against.
function newSlugs(findings, prior, idKey, needles) {
  if (!prior.lastReviewedSha) return new Set();
  const comparable = (f) => idKey || (!f.security && !touchesSecurityFile(f, needles));
  return new Set(findings.filter((f) => comparable(f) && !prior.ledger.some(reportedBy([f], idKey))).map((f) => f.slug));
}

export { DELIVERED, NOT_DELIVERED, NO_KEY };

// Without a trusted snapshot: always the failure banner, with prior state from
// the existing summary comment (fallback.state, sanitized as usual) or, if its
// marker does not decode, that marker re-emitted verbatim (fallback.rawMarker).
function untrustedBody(fallback, idKey, linkTypes, notices) {
  const ledger = priorPayload(fallback?.state, idKey, linkTypes);
  return renderSummary({ state: {}, findings: null, narrative: '', outcome: 'failure', reason: 'failed', ledger, rawMarker: fallback?.rawMarker ?? null, notices });
}

// checks.writeCollaborators: a loud status line, never a login.
function writersNotice(s) {
  if (s.writeCollaborators === 'unreadable') return ['> write collaborators could not be listed; others may be able to write to this repository'];
  // Pending invitations need Administration read, which no workflow token has.
  return Number.isInteger(s.writeCollaborators) && s.writeCollaborators > 0 ? [`> ${s.writeCollaborators} collaborator(s) other than the allowed ones can write to this repository (pending invitations are not visible to this check)`] : [];
}

export const rejectedNotice = (n) => `> ${n} finding(s) a maintainer rejected were not re-raised`;

export const FROZEN_NOTICE = '> ledger frozen for security entries: id key unavailable';

// Without the key: no security or withheld entry can be created (or matched),
// so existing ones are carried unchanged and the summary says so.
function frozenNotice(idKey, ledger, findings, needles) {
  if (idKey || activeProject().config.securityChannel === 'none') return [];
  const priorOpaque = ledger.some((e) => e.security || e.withheld);
  const current = (findings ?? []).some((f) => f.security || touchesSecurityFile(f, needles));
  return priorOpaque || current ? [FROZEN_NOTICE] : [];
}

// resolvedIds: security ids whose advisory was dispositioned (advisories.mjs).
// notices: fixed lines from publish itself (e.g. the inline guard).
// rawMarker: the old marker, re-emitted verbatim when the prior state could not be read.
export function composeBody({ state, findingsText, narrative, outcome, executionLog, headSha, baseSha, idKey, linkTypes = knownLinkTypes(), fallback, securityClause = DELIVERED, resolvedIds = [], notices = [], inlinePosted = new Set(), rawMarker = null }) {
  // A missing or invalid snapshot fails closed, whatever the action outcome.
  if (!isObject(state)) return untrustedBody(fallback, idKey, linkTypes, notices);
  const s = state;
  const known = new Set(linkTypes ?? []);
  const types = (list) => strings(list).filter((t) => !linkTypes || known.has(t));
  const prior = priorPayload(s, idKey, linkTypes);
  if (s.tier === 'none' && outcome === 'skipped') return noChangeBody(prior, headSha, baseSha, notices, rawMarker);
  // Tier "none" never runs the model, so a "success" alongside it is not trusted.
  const { findings: completed, reason, suppressed, belowFloor } = completion(s, findingsText, outcome, narrative);
  if (!completed) {
    const lines = [...notices, ...frozenNotice(idKey, prior.ledger, [], [])];
    return renderSummary({ state: s, findings: null, narrative: '', outcome: 'failure', reason: reason ?? failureReason(executionLog), ledger: prior, notices: lines, rawMarker });
  }
  // Only what publish itself posted counts; the model's own flag is ignored.
  const findings = { ...completed, findings: completed.findings.map((f) => ({ ...f, inlinePosted: inlinePosted.has(f.slug) })) };
  // Built once: current security files plus paths (finding locations, narrative
  // tokens, the PR's changed files) hashing to prior security fileIds.
  const needles = runNeedles(findings.findings, [narrative ?? ''], priorFileIds(prior.ledger), idKey, strings(s.changedFiles));
  // The trusted head (workflow env, then snapshot); the model's reviewedSha is ignored.
  const reviewed = sha(headSha) ?? sha(s.headSha) ?? prior.lastReviewedSha;
  // Entries this run re-reports: by keyed id (security, withheld) or by slug (public).
  const reported = reportedBy(findings.findings, idKey);
  const keyed = new Set(findings.findings.map((f) => opaqueId(f.slug, idKey)));
  // Dispositioned outside the review: a closed/withdrawn/published advisory
  // (security), or a maintainer's reply to the inline comment (non-security).
  // An id reported again in this run stays open.
  const dispositioned = new Set(resolvedIds.filter((id) => !keyed.has(id)));
  // A maintainer's reply (acknowledged) or trusted 👎 (rejected) dispositions the finding.
  const acked = new Set([...strings(s.acknowledgedSlugs), ...strings(s.feedback?.rejectedSlugs)].map(ledgerSlug));
  const merged = markResolved(
    mergeLedger(prior.ledger, findings.findings, findings.resolvedSlugs, s.tier, { key: idKey, needles }),
    (e) => (e.security ? dispositioned.has(e.id) : !e.withheld && e.severity !== 'Critical' && acked.has(e.slug) && !reported(e)),
  );
  const ledger = {
    lastReviewedSha: reviewed,
    lastBaseSha: sha(baseSha),
    linkTypesSeen: [...new Set([...prior.linkTypesSeen, ...types(s.runLinkTypes)])],
    ledger: merged,
  };
  const visible = visibleEntries(merged);
  return renderSummary({
    state: { ...s, headSha: reviewed },
    findings: { ...findings, reviewedSha: reviewed },
    narrative,
    outcome: 'success',
    ledger,
    needles,
    newSlugs: newSlugs(findings.findings, prior, idKey, needles),
    carried: visible.filter((e) => e.status === 'open' && !reported(e)),
    resolved: visible.filter((e) => e.status === 'resolved'),
    securityClause: idKey || securityClause === NO_CHANNEL ? securityClause : NO_KEY,
    notices: [...notices, ...writersNotice(s), ...(suppressed ? [rejectedNotice(suppressed)] : []), ...(belowFloor ? [`> ${belowFloor} finding(s) below their class's confidence floor not shown`] : []), ...frozenNotice(idKey, prior.ledger, findings.findings, needles)],
    rawMarker,
    partial: isPartial(s),
  });
}

// The marker the summary carried before this run, for the minimal retry body.
function previousMarker(snapshot, fallback, rawMarker, idKey) {
  if (rawMarker) return rawMarker;
  if (!isObject(snapshot) && fallback?.rawMarker) return fallback.rawMarker;
  const p = priorPayload(isObject(snapshot) ? snapshot : fallback?.state, idKey, knownLinkTypes());
  return encodeLedger(fitMarker(p, encodeLedger, MAX_MARKER));
}

// The tier for the status line: facts' fixed vocabulary only, never free text.
const TIER_RE = /^[a-z][a-z-]{0,29}$/;
const tierOf = (s) => (isObject(s) && TIER_RE.test(String(s.tier)) ? ` (tier ${s.tier})` : '');

// Without a trusted snapshot and without the comment, nothing is posted: the
// old comment (and its marker) stays as it was. The same holds when facts could
// not read the prior state and publish cannot either. Both cases warn; the
// second also tries the minimal banner, which only ever replaces a summary it
// found and keeps that summary's marker.
async function publishRun({ repo, pr, snapshot: trusted, advisoryToken, ...rest }, deps) {
  const head = sha(rest.headSha);
  const check = await currentHead(repo, pr, deps.request);
  if (head && check.sha && check.sha !== head) {
    console.log('::notice::pr-review superseded: the PR head has moved on; nothing posted');
    return `superseded: the PR head moved past ${head.slice(0, 7)}; nothing posted`;
  }
  const extra = [];
  if (!head || !check.sha) {
    warn(`head not verified (${head ? check.error : 'HEAD_SHA missing'}); publishing without the stale-run check`);
    extra.push('head unverified');
  }
  let fallback;
  if (!isObject(trusted)) {
    fallback = await priorFromComment(repo, pr, deps.listIssueComments);
    // An existing marker that cannot be read and cannot be carried over: never
    // replace it with an empty ledger.
    if (!fallback || (fallback.unreadable && !fallback.rawMarker)) {
      warn('summary not updated: no trusted state and the summary comment could not be read');
      return 'skipped: no trusted state and the summary comment could not be read';
    }
  }
  const prior = await resolvePrior(repo, pr, trusted, deps.listIssueComments);
  const snapshot = prior.snapshot;
  const raw = prior.rawMarker ?? fallback?.rawMarker ?? null;
  const oversized = Boolean(raw && raw.length > MAX_MARKER);
  if (prior.skip || oversized) {
    // Checked before anything is posted. Advisories still go out: they are
    // private and do not depend on the summary.
    const { clause } = await deliver(repo, pr, snapshot, { ...rest, advisoryToken, request: deps.request, deliverIssues: deps.deliverIssues }, deps.deliverAdvisories ?? deliverAdvisories);
    const why = oversized ? 'the old marker is too large to carry over' : 'prior review state unavailable';
    warn(`summary not updated: ${why}`);
    const minimal = await fallbackSummary(repo, pr, head ?? sha(snapshot?.headSha), deps, oversized ? 'marker too large' : 'prior state unavailable');
    return `skipped: ${why}; inline comments not posted; advisories ${clause === DELIVERED ? 'ok' : 'not delivered'}${minimal ? '; minimal summary posted' : ''}`;
  }
  if (raw) {
    warn('ledger not updated: prior review state unreadable; old marker re-emitted');
    extra.push('ledger frozen (prior state unreadable)');
  }
  const headSha = head ?? sha(snapshot?.headSha);
  const findings = completedFindings(snapshot, rest.findingsText, rest.outcome, rest.narrative)?.findings ?? null;
  const inline = await runInline({ repo, pr, snapshot, findings, inlineText: rest.inlineText, idKey: rest.idKey, headSha, runStartedAt: rest.runStartedAt }, deps);
  const reply = await runReplyGuard({ repo, pr, snapshot, findings, idKey: rest.idKey, runStartedAt: rest.runStartedAt }, deps);
  if (reply.removed) extra.push(`${reply.removed} reply comment(s) removed`);
  if (inline.notPosted) {
    warn(`${inline.notPosted} inline comment(s) not posted`);
    extra.push(`${inline.notPosted} inline comment(s) not posted`);
  }
  const { clause, resolvedIds } = await deliver(repo, pr, snapshot, { ...rest, advisoryToken, request: deps.request, deliverIssues: deps.deliverIssues }, deps.deliverAdvisories ?? deliverAdvisories);
  if (clause === NOT_DELIVERED) {
    warn('security advisories not delivered');
    extra.push('advisories not delivered');
  }
  const notices = [...(prior.notice ? [prior.notice] : []), ...inline.notices, ...reply.notices];
  const body = composeBody({ ...rest, state: snapshot, fallback, securityClause: clause, resolvedIds, notices, inlinePosted: inline.posted, rawMarker: prior.rawMarker ?? null });
  const ok = await postSummary(repo, pr, body, deps.upsertSummary, { headSha, previousMarker: previousMarker(snapshot, fallback, prior.rawMarker, rest.idKey || null) });
  const label = `${outcomeLabel(snapshot, rest)}${tierOf(snapshot)}`;
  const tail = extra.map((e) => `; ${e}`).join('');
  return ok ? `summary updated: ${label}; ${inline.posted.size} inline comment(s) posted${tail}` : `summary update failed (${label}); minimal banner attempted${tail}`;
}

// Returns the status line it also writes to the job summary (deps.report).
export async function publish(args, deps = { listIssueComments, upsertSummary }) {
  const report = deps.report ?? stepSummary;
  let status;
  try {
    status = await publishRun(args, deps);
  } catch (err) {
    // Never log bodies, tokens or messages; status only.
    const code = statusOf(err);
    warn(`publish failed (${code}); the summary may be stale`);
    const minimal = await fallbackSummary(args.repo, args.pr, sha(args.headSha), deps, code);
    status = `publish failed (${code})${minimal ? '; minimal summary posted' : ''}`;
  }
  report(status);
  return status;
}

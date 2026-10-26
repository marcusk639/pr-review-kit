// Collection (model-free): trusted feedback on the reviewer's findings across
// every PR updated inside the learning window, open, closed or merged, since
// most feedback arrives after the run that caused it. Each record is tied to a
// finding slug and enriched with its class, path, link types, severity and
// security from the slug, the project routing and the PR's summary ledger.
import { feedbackRecords } from '../lib/feedback.mjs';
import { findSummary } from '../lib/state.mjs';
import { decodeLedger } from '../lib/markers.mjs';
import { sanitizeLedger } from '../lib/ledger.mjs';
import { route } from '../lib/routing.mjs';
import { securityClasses } from '../lib/config.mjs';

const BOT = 'github-actions[bot]';
const DAY = 24 * 60 * 60 * 1000;
const SLUG_RE = /^c(\d{1,3}):([^:\s]+):/;

function ledgerOf(issueComments) {
  const s = findSummary(issueComments);
  const payload = s ? decodeLedger(s.body) : null;
  return payload && !Array.isArray(payload) ? sanitizeLedger(payload.ledger, null) : [];
}

async function reactionsFor(repo, reviews, listReactions) {
  const out = {};
  for (const c of reviews) {
    const r = c?.reactions;
    if (c?.user?.login === BOT && c.in_reply_to_id == null && r && (r['+1'] > 0 || r['-1'] > 0)) out[c.id] = await listReactions(repo, c.id);
  }
  return out;
}

export function enrich(record, ledger, project) {
  const m = SLUG_RE.exec(record.slug);
  const cls = m ? Number(m[1]) : null;
  const path = m ? m[2] : null;
  const e = ledger.find((x) => x.slug === record.slug);
  return {
    ...record,
    class: cls,
    path,
    linkTypes: path ? route([path], project).linkTypes : [],
    severity: e?.severity ?? null,
    security: securityClasses(project.config).has(cls) || e?.security === true,
  };
}

// deps: { listPulls(repo), listIssueComments(repo, n), listReviewComments(repo, n), listReactions(repo, id) }
export async function collect({ repo, project, now = new Date(), deps }) {
  const cutoff = now.getTime() - project.config.learning.windowDays * DAY;
  const pulls = (await deps.listPulls(repo)).filter((p) => Date.parse(p.updated_at) >= cutoff);
  const trusted = project.config.trust.feedbackAuthors;
  const records = [];
  const recordsByPr = {};
  for (const p of pulls) {
    const issue = await deps.listIssueComments(repo, p.number);
    const reviews = await deps.listReviewComments(repo, p.number);
    const ledger = ledgerOf(issue);
    const reactions = await reactionsFor(repo, reviews, deps.listReactions);
    const recs = feedbackRecords({ pr: p.number, reviewComments: reviews, issueComments: issue, reactions, ledger, trusted }).map((r) => enrich(r, ledger, project));
    recordsByPr[p.number] = recs;
    records.push(...recs);
  }
  return { records, recordsByPr, pulls: pulls.length };
}

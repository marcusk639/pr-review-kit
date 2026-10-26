// The private-repo-issue security channel: details of security findings go to
// issues in a separate, Marcus-only private repository (the inbox), through a
// fine-grained PAT with Issues read/write on that repository only. The inbox
// is verified on every delivery (private, every collaborator a reader) and
// nothing is sent otherwise. Issues are deduplicated by (repository, opaque
// id), like advisories; a closed issue resolves its ledger entry. Bodies are
// redacted and lose @-mentions and email addresses (no notifications, no
// personal data). Logs status codes and counts only.
import { redact } from './redact.mjs';
import { activeProject } from './config.mjs';
import { opaqueId, SEVERITIES } from './ledger.mjs';
import { safeArea, safePackage } from './findings.mjs';
import { verifyPrivateChannel } from './private-channel.mjs';

const MAX_PAGES = 10;
const FOOTER_RE = /^(?:repository:|pull request:|pr-review-id:|also touched by\b)/i;
const MENTION = /(^|[^\w`])@[A-Za-z0-9][A-Za-z0-9-]{0,38}(\/[A-Za-z0-9_.-]+)?/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export const issueFooter = (repo, pr, id) => `Repository: ${repo}\nPull request: #${pr}\npr-review-id: ${id}`;

function strip(text) {
  let t = String(text ?? '').replace(EMAIL, '[email removed]').replace(MENTION, '$1[mention removed]');
  for (const p of activeProject().config.issueBody?.extraPatterns ?? []) t = t.replace(new RegExp(p, 'g'), '[removed]');
  return t
    .split('\n')
    .filter((l) => !FOOTER_RE.test(l.trim()))
    .join('\n');
}

export function issueBody(f, { repo, pr, id }) {
  const where = f.locations.map((l) => `- ${strip(l.file)}${l.line > 0 ? `:${l.line}` : ''} (${l.side})`).join('\n');
  const body = [
    'Reported by the pr-review agent. Private: do not copy into public channels.',
    `Title: ${strip(f.title)}`,
    `Class: ${f.class}`,
    `Severity: ${f.severity} (confidence: ${f.confidence})`,
    `Package / area: ${strip(f.package)} ${strip(f.area)}`,
    `Feature at risk: ${strip(f.feature)}`,
    `Locations:\n${where}`,
    `Why: ${strip(f.why)}`,
    `Fix: ${strip(f.fix)}`,
  ].join('\n\n');
  return `${redact(body)}\n\n${issueFooter(repo, pr, id)}`;
}

// The code-written footer only (model text cannot hold footer lines).
export function footerOf(body) {
  const ls = String(body ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const prs = new Set();
  let i = ls.length - 1;
  for (let m; i >= 0 && (m = /^Also touched by #(\d+)$/.exec(ls[i])); i--) prs.add(Number(m[1]));
  const id = /^pr-review-id: ([0-9a-f]{16})$/.exec(ls[i] ?? '');
  const pr = /^Pull request: #(\d+)$/.exec(ls[i - 1] ?? '');
  const repo = /^Repository: (\S+)$/.exec(ls[i - 2] ?? '');
  if (!id || !pr || !repo) return { id: null, repo: null, prs };
  prs.add(Number(pr[1]));
  return { id: id[1], repo: repo[1], prs };
}

async function listIssues(target, token, request) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await request('GET', `/repos/${target}/issues?state=all&per_page=100&page=${page}`, undefined, token);
    if (!Array.isArray(items)) break;
    all.push(...items.filter((x) => x && !x.pull_request));
    if (items.length < 100) break;
  }
  return all;
}

export async function deliverIssues({ repo, pr, findings = [], token, target, readers = [], key, priorIds = [], request }) {
  if (!findings.length && !priorIds.length) return { delivered: true, resolvedIds: [] };
  if (!target || !token || !key) return { delivered: false, reason: 'missing target, token or key' };
  const v = await verifyPrivateChannel(target, readers, request, token);
  if (!v.verified) {
    console.log(`private issues: inbox not verified (${v.reason})`);
    return { delivered: false, reason: 'inbox not verified' };
  }
  let created = 0;
  let updated = 0;
  try {
    const known = (await listIssues(target, token, request)).map((x) => ({ ...x, footer: footerOf(x.body) })).filter((x) => x.footer.repo === repo);
    const reported = new Set(findings.map((f) => opaqueId(f.slug, key)));
    const open = new Set(known.filter((x) => x.state === 'open').map((x) => x.footer.id));
    const resolvedIds = [...new Set(known.filter((x) => x.state === 'closed' && priorIds.includes(x.footer.id) && !reported.has(x.footer.id) && !open.has(x.footer.id)).map((x) => x.footer.id))];
    const done = new Set();
    for (const f of findings) {
      const id = opaqueId(f.slug, key);
      if (done.has(id)) continue;
      done.add(id);
      const existing = known.find((x) => x.state === 'open' && x.footer.id === id);
      if (!existing) {
        const sev = SEVERITIES.includes(f.severity) ? f.severity : 'High';
        const title = `[pr-review] ${activeProject().config.project} ${safePackage(f.package) ?? 'unknown'} ${safeArea(f.area)} (${sev})`;
        await request('POST', `/repos/${target}/issues`, { title, body: issueBody(f, { repo, pr, id }) }, token);
        created++;
      } else if (!existing.footer.prs.has(Number(pr))) {
        await request('PATCH', `/repos/${target}/issues/${existing.number}`, { body: `${existing.body}\nAlso touched by #${pr}` }, token);
        existing.footer.prs.add(Number(pr));
        updated++;
      }
    }
    console.log(`private issues: created ${created}, updated ${updated}`);
    return { delivered: true, resolvedIds };
  } catch (err) {
    console.log(`private issues failed: ${Number.isInteger(err?.status) ? err.status : 'unknown'}`);
    return { delivered: false, reason: 'api-error' };
  }
}

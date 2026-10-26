// Renders the one public summary comment. Everything model-written passes
// through redact() and loses any HTML-comment syntax, so it can neither leak a
// secret nor plant a fake marker ahead of the real ledger marker.
import { SUMMARY_MARKER, encodeLedger } from './markers.mjs';
import { redact } from './redact.mjs';
import { SEVERITIES, fitMarker, visibleEntries } from './ledger.mjs';
import { validateFindings, securityPointer } from './findings.mjs';
import { securityNeedles, mentions, touchesSecurityFile } from './needles.mjs';

export { validateFindings, securityPointer };

export const MAX_BODY = 60000;
export const MAX_MARKER = 30000;
const MAX_FIELD = 1500;
const TRUNC = '(truncated)';
const WITHHELD = '(some narrative withheld: security)';
const MAX_SECTION = 50;

function neutralise(s) {
  return s.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
}

function clean(text, max = MAX_FIELD) {
  const s = neutralise(redact(String(text ?? '')).replace(/\s+/g, ' ').trim());
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function where(l) {
  const file = String(l.file).replace(/`/g, '');
  return `\`${clean(file, 300)}${l.line > 0 ? `:${l.line}` : ''}\` (${l.side})`;
}

export const WITHHELD_TITLE = '(withheld: touches a security-relevant file)';

function renderFinding(f, needles, isNew, clause) {
  // The security pointer keeps its exact fixed public form: never tagged.
  if (f.security) return `- ${redact(securityPointer(f, clause))}`;
  const fresh = isNew ? ' (new)' : '';
  if (touchesSecurityFile(f, needles)) return `- **${WITHHELD_TITLE}** (confidence: ${f.confidence})${fresh}`;
  return [
    `- **${clean(f.title, 200)}** (confidence: ${f.confidence})${fresh}${f.inlinePosted ? ' (inline comment posted)' : ''}`,
    `  - Where: ${f.locations.map(where).join('; ')}`,
    `  - Why: ${clean(f.why)}`,
    `  - Fix: ${clean(f.fix)}`,
    `  - Feature at risk: ${clean(f.feature, 200)}`,
  ].join('\n');
}

function renderPriorEntry(e) {
  if (e.security) return `- Security-relevant issue (${e.severity}) reported earlier; details sent privately`;
  if (e.withheld) return `- **${WITHHELD_TITLE}** (${e.severity}, from an earlier review)`;
  return `- **${clean(e.title || e.slug, 200)}** (${e.severity}, from an earlier review)`;
}

// A trimmable section: assemble() pops its lines before dropping findings.
function section(heading, lines, what, footer = []) {
  return { heading, lines: lines.slice(0, MAX_SECTION), dropped: Math.max(0, lines.length - MAX_SECTION), what, footer };
}

function renderSection(s) {
  if (!s || (!s.lines.length && !s.dropped && !s.footer.length)) return '';
  const body = [...s.lines, ...(s.dropped ? [`- ${TRUNC} ${s.dropped} more ${s.what} not shown`] : []), ...s.footer];
  return [s.heading, body.join('\n')].join('\n\n');
}

// Ledger entries only: security and withheld ones are counted, never named.
function renderResolved(entries) {
  if (!entries.length) return null;
  const hidden = entries.filter((e) => e.security || e.withheld).length;
  const named = entries
    .filter((e) => !e.security && !e.withheld)
    .map((e) => {
      const when = e.runsSinceResolved === 0 ? 'this review' : `${e.runsSinceResolved} review(s) ago`;
      return `- **${clean(e.title || e.slug, 200)}** (${e.severity}, resolved ${when})`;
    });
  const footer = hidden ? [`- ${hidden} security-relevant or withheld finding(s) resolved; details not shown`] : [];
  return section('### Resolved since last review', named, 'resolved finding(s)', footer);
}

function renderCarried(entries) {
  if (!entries.length) return null;
  return section('### Still open from earlier reviews', entries.map(renderPriorEntry), 'open finding(s)');
}

// Drops every narrative line naming a security finding's file, then redacts.
export function withholdNarrative(narrative, findings, needles = securityNeedles(findings)) {
  const lines = String(narrative ?? '').split('\n');
  const kept = lines.filter((line) => !mentions(line, needles));
  let text = kept.join('\n').trim();
  if (kept.length < lines.length) text = `${text}\n\n${WITHHELD}`.trim();
  return neutralise(redact(text));
}

function bySeverity(items) {
  const parts = SEVERITIES.map((s) => [s, items.filter((f) => f.severity === s).length])
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

const TIERS = new Set(['full', 'incremental', 'incremental-new-links', 'light', 'base-drift', 'none']);
const tierName = (t) => (TIERS.has(t) ? t : 'unknown');
const CHECK_RE = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;

// This run's findings and the open entries carried from earlier reviews are
// counted apart; "No issues found" only when nothing at all is open.
export const PRIOR_UNREAD = 'prior findings could not be read; earlier open findings may still apply';

export const PARTIAL = 'partial review: the pre-checks were unavailable or the PR diff was missing or truncated, so issues may have been missed';

// priorUnread: the old marker is re-emitted because it could not be read, so
// "nothing open" cannot be claimed. partial: facts failed or pr.diff is
// missing or truncated, so "No issues found" cannot be claimed either.
function headline(sha, tier, list, carried, priorUnread = false, partial = false) {
  const head = `Reviewed \`${clean(sha, 7)}\` (${tierName(tier)}${partial ? ', partial review' : ''}):`;
  const tail = partial ? `; ${PARTIAL}.` : '.';
  if (priorUnread) return `${head} ${list.length} reported this run${bySeverity(list)}; ${PRIOR_UNREAD}${tail}`;
  if (!list.length && !carried.length && !partial) return `${head} No issues found.`;
  return `${head} ${list.length} reported this run${bySeverity(list)}; ${carried.length} still open from earlier reviews${bySeverity(carried)}${tail}`;
}

// Fixed text: the tier and the names of pre-checks facts could not run.
function tierLine(state) {
  const checks = (Array.isArray(state?.unavailableChecks) ? state.unavailableChecks : []).filter((c) => typeof c === 'string' && CHECK_RE.test(c)).slice(0, 20);
  return `Tier: \`${tierName(state?.tier)}\`; unavailable pre-checks: ${checks.length ? checks.join(', ') : 'none'}.`;
}

function groupBySeverity(items, render) {
  return Object.fromEntries(SEVERITIES.map((s) => [s, items.filter((i) => i.severity === s).map(render)]));
}

function build(head, groups, dropped, narrative, extra) {
  const out = [head];
  for (const s of SEVERITIES) {
    if (!groups[s].length && !dropped[s]) continue;
    out.push(`### ${s}`, groups[s].join('\n'));
    if (dropped[s]) out.push(`- ${TRUNC} ${dropped[s]} more ${s} finding(s) not shown`);
  }
  out.push(...extra.map(renderSection));
  if (narrative) out.push(narrative);
  return out.filter((x) => x !== '').join('\n\n');
}

// Truncates narrative first, then the earlier-review sections (last section
// first), then Low, then Medium findings; hard-cuts last.
function assemble(head, groups, narrative, markerText, sections = []) {
  const room = Math.max(0, MAX_BODY - markerText.length - 2);
  const extra = sections.filter(Boolean).map((s) => ({ ...s, lines: [...s.lines] }));
  const g = { ...groups, Low: [...groups.Low], Medium: [...groups.Medium] };
  const dropped = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  let narr = narrative;
  let text = build(head, g, dropped, narr, extra);
  if (text.length > room && narr) {
    const budget = room - build(head, g, dropped, '', extra).length - TRUNC.length - 4;
    narr = budget > 200 ? `${narr.slice(0, budget)}\n${TRUNC}` : TRUNC;
    text = build(head, g, dropped, narr, extra);
  }
  for (const s of [...extra].reverse()) {
    while (text.length > room && s.lines.length) {
      s.lines.pop();
      s.dropped++;
      text = build(head, g, dropped, narr, extra);
    }
  }
  for (const sev of ['Low', 'Medium']) {
    while (text.length > room && g[sev].length) {
      g[sev].pop();
      dropped[sev]++;
      text = build(head, g, dropped, narr, extra);
    }
  }
  // Whole-body pass before the hard cut, so the cut cannot split a secret into
  // a fragment too short to match; redaction only ever shortens text.
  text = redact(text);
  if (text.length > room) text = `${text.slice(0, Math.max(0, room - TRUNC.length - 2))}\n${TRUNC}`;
  // The summary marker must stay the first line whatever was cut.
  if (!text.startsWith(SUMMARY_MARKER)) text = `${SUMMARY_MARKER}\n${text}`;
  return `${text}\n\n${markerText}`;
}

const ADVISORY = '_Advisory only: not a required check. Security-relevant findings show only a pointer here._';

// Failure keeps the last completed review's open findings; tier "none" (no
// model run, outcome "none") also lists what that review resolved.
function renderPrior(ledger, markerText, banner, withResolved, notices = [], priorUnread = false) {
  const visible = visibleEntries(ledger.ledger ?? []);
  const open = visible.filter((e) => e.status === 'open');
  const head = [
    SUMMARY_MARKER,
    '## PR review (advisory)',
    banner,
    ...notices,
    priorUnread
      ? `${PRIOR_UNREAD[0].toUpperCase()}${PRIOR_UNREAD.slice(1)}.`
      : open.length
        ? 'Open findings from the last completed review:'
        : 'No open findings were recorded by an earlier completed review.',
  ].join('\n\n');
  const extra = withResolved ? [renderResolved(visible.filter((e) => e.status === 'resolved'))] : [];
  return assemble(head, groupBySeverity(open, renderPriorEntry), '', markerText, extra);
}

// rawMarker: an existing marker re-emitted verbatim when publish has no
// decodable prior state (it only ever comes from rawLedgerMarker's pattern).
// notices: fixed, code-written lines (never model text) shown under the banner.
export function renderSummary({ state, findings, narrative, outcome, ledger, reason = 'failed', needles, note = '', newSlugs = new Set(), carried = [], resolved = [], rawMarker = null, securityClause, notices = [], partial = false }) {
  // An oversized raw marker is dropped for an encoded (sanitized) ledger.
  const raw = rawMarker && rawMarker.length <= MAX_MARKER ? rawMarker : null;
  const markerText = raw ?? encodeLedger(fitMarker(ledger, encodeLedger, MAX_MARKER));
  if (outcome === 'none') return renderPrior(ledger, markerText, `${clean(note, 200)}\n\n${ADVISORY}`, true, notices, Boolean(raw));
  const ok = outcome === 'success' && findings && Array.isArray(findings.findings);
  if (!ok) return renderPrior(ledger, markerText, `> ⚠ review did not complete (${reason}) — will retry on next push`, false, notices, Boolean(raw));
  const list = findings.findings;
  const sha = String(findings.reviewedSha || state?.headSha || '').slice(0, 7);
  const head = [
    SUMMARY_MARKER,
    '## PR review (advisory)',
    headline(sha, state?.tier, list, carried, Boolean(raw), partial),
    tierLine(state),
    ADVISORY,
    ...notices,
  ].join('\n\n');
  const n = needles ?? securityNeedles(list);
  const groups = groupBySeverity(list, (f) => renderFinding(f, n, newSlugs.has(f.slug), securityClause));
  const extra = [renderCarried(carried), renderResolved(resolved)];
  return assemble(head, groups, withholdNarrative(narrative, list, n), markerText, extra);
}

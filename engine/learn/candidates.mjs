// Candidate lessons (deterministic) from trusted feedback records:
// - an explicit text correction on a finding → a lesson scoped to that finding
//   (its file, class and link types);
// - repeated 👎 with no text on one class under one directory, across at least
//   learning.repeatThreshold PRs → a pattern lesson;
// - a lone 👎 → nothing (it is a precision count only).
// Instruction-shaped text is never a candidate: it is listed as unresolved
// feedback, weighed by Marcus, not obeyed. Feedback already cited by a lesson
// (any status) is not proposed again.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isProtected } from './precision.mjs';

const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 10);

// Imperatives aimed at the reviewer itself rather than at a finding.
const INSTRUCTION_PATTERNS = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(instructions?|rules?|prompt|procedure|guidelines?|everything)\b/i,
  /\byou are (now|no longer)\b|\bsystem prompt\b|\bact as\b|\bnew instructions?\b/i,
  /\b(stop|never|don'?t|do not|no longer)\s+(report|flag|rais|mention|review|check|comment)\w*\s+(on\s+)?(any|all|every|anything)\b/i,
  /\b(stop|never|don'?t|do not|no longer)\s+(report|flag|rais|mention|review|check)\w*\s+(\w+\s+){0,2}(security|secrets?|auth\w*|vulnerabilit\w*)/i,
  /\b(approve|lgtm|pass)\b[^.\n]{0,30}\b(this|the|every|all)\s+(pr|pull request|change)s?\b/i,
];

export const instructionShaped = (text) => INSTRUCTION_PATTERNS.some((re) => re.test(String(text ?? '')));


const source = (r) => ({ id: r.id, url: r.url, at: r.at, author: r.author, pr: r.pr });

function correction(r) {
  return {
    id: `C-${hash(r.id)}`,
    kind: 'correction',
    scope: { paths: [r.path], class: r.class, linkTypes: r.linkTypes },
    scopeKey: `${r.class}:${r.path}`,
    text: r.text,
    signal: r.signal,
    severity: r.severity,
    security: r.security,
    sources: [source(r)],
  };
}

function patterns(downs, config) {
  const groups = new Map();
  for (const r of downs) {
    const dir = posix.dirname(r.path);
    const key = `${r.class}:${dir === '.' ? '' : `${dir}/`}**`;
    const g = groups.get(key) ?? { key, dir, cls: r.class, records: [] };
    g.records.push(r);
    groups.set(key, g);
  }
  const out = [];
  for (const g of groups.values()) {
    const prs = new Set(g.records.map((r) => r.pr));
    if (prs.size < config.learning.repeatThreshold) continue;
    const scopePath = g.dir === '.' ? '**' : `${g.dir}/**`;
    const name = config.classes.find((k) => k.id === g.cls)?.name ?? `class ${g.cls}`;
    out.push({
      id: `C-${hash(g.records.map((r) => r.id).sort().join())}`,
      kind: 'pattern',
      scope: { paths: [scopePath], class: g.cls, linkTypes: [...new Set(g.records.flatMap((r) => r.linkTypes))] },
      scopeKey: `${g.cls}:${scopePath}`,
      text: `Findings of class ${g.cls} (${name}) under \`${scopePath}\` were rejected with 👎 on ${prs.size} PRs (${[...prs].sort((a, b) => a - b).map((n) => `#${n}`).join(', ')}). Raise the bar here: report only with high confidence and a cited counterpart.`,
      signal: 'down',
      severity: null,
      security: false,
      sources: g.records.map(source),
    });
  }
  return out;
}

// consumed: source ids of lessons that were replaced or pruned, so their
// feedback never returns as a candidate (lessons.json keeps the list).
export function buildCandidates(records, config, lessons = [], consumedIds = []) {
  const consumed = new Set([...consumedIds, ...lessons.flatMap((l) => (l.sources ?? []).map((s) => s.id))]);
  const fresh = (records ?? []).filter((r) => r.slug && r.path && Number.isInteger(r.class) && !consumed.has(r.id));
  const candidates = [];
  const unresolved = [];
  const byTime = [...fresh].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const r of byTime.filter((x) => x.text && x.signal !== 'up')) {
    const c = correction(r);
    if (instructionShaped(r.text)) {
      unresolved.push({ candidate: c.id, reason: 'instruction-shaped: weighed as data, not applied', url: r.url, pr: r.pr, slug: r.slug, text: r.text });
    } else candidates.push(c);
  }
  const downs = fresh.filter((r) => r.signal === 'down' && !r.text && !isProtected(r));
  candidates.push(...patterns(downs, config));
  return { candidates, unresolved };
}

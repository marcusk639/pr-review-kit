// 👍/👎 precision per bug class and per link type, from trusted feedback.
// Stored per PR (learned/precision.json) so a collection window that slides
// past old PRs never loses their counts: each collection replaces the
// contribution of the PRs it saw. Votes on security, Critical or High findings
// are "protected": shown, but never used to demote a class.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { securityClasses } from '../lib/config.mjs';

const EMPTY = () => ({ version: 1, byPr: {} });
const zero = () => ({ up: 0, down: 0, protectedUp: 0, protectedDown: 0 });
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Shared with candidates: a vote on a security, Critical, High or unknown-severity
// finding never demotes a class or forms a pattern lesson.
export const isProtected = (r) => r.security === true || r.severity == null || r.severity === 'Critical' || r.severity === 'High';

function bump(map, key, r) {
  const c = (map[key] ??= zero());
  const field = `${isProtected(r) ? 'protected' : ''}${isProtected(r) ? (r.signal === 'up' ? 'Up' : 'Down') : r.signal}`;
  c[field]++;
}

// records: one PR's trusted feedback records; only up/down signals count.
export function countPr(records) {
  const out = { classes: {}, linkTypes: {} };
  for (const r of records ?? []) {
    if (r.signal !== 'up' && r.signal !== 'down') continue;
    if (Number.isInteger(r.class)) bump(out.classes, String(r.class), r);
    for (const t of r.linkTypes ?? []) bump(out.linkTypes, t, r);
  }
  return out;
}

// recordsByPr: { [pr]: records } for every PR this collection saw.
export function mergePrecision(prior, recordsByPr) {
  const p = isObj(prior) && isObj(prior.byPr) ? { version: 1, byPr: { ...prior.byPr } } : EMPTY();
  for (const [pr, records] of Object.entries(recordsByPr ?? {})) {
    const c = countPr(records);
    if (Object.keys(c.classes).length || Object.keys(c.linkTypes).length) p.byPr[pr] = c;
    else delete p.byPr[pr];
  }
  return p;
}

export function totals(precision) {
  const out = { classes: {}, linkTypes: {} };
  for (const c of Object.values(precision?.byPr ?? {})) {
    for (const kind of ['classes', 'linkTypes']) {
      for (const [k, v] of Object.entries(c?.[kind] ?? {})) {
        const t = (out[kind][k] ??= zero());
        for (const f of Object.keys(t)) t[f] += Number.isInteger(v?.[f]) ? v[f] : 0;
      }
    }
  }
  return out;
}

const ratio = (c) => (c.up + c.down ? c.up / (c.up + c.down) : null);

export function demotedClasses(precision, config) {
  const { minVotes, maxPrecision } = config.learning.demote;
  const security = securityClasses(config);
  const protectedIds = new Set(config.classes.filter((k) => k.protected).map((k) => k.id));
  const out = new Set();
  for (const [k, c] of Object.entries(totals(precision).classes)) {
    const id = Number(k);
    if (security.has(id) || protectedIds.has(id) || c.up + c.down < minVotes) continue;
    if (ratio(c) <= maxPrecision) out.add(id);
  }
  return out;
}

export function readPrecision(projectDir) {
  try {
    const p = JSON.parse(readFileSync(join(projectDir, 'learned/precision.json'), 'utf8'));
    return isObj(p) && isObj(p.byPr) ? p : EMPTY();
  } catch {
    return EMPTY();
  }
}

const pct = (c) => (ratio(c) == null ? '–' : `${Math.round(ratio(c) * 100)}%`);

// Markdown for the learning PR: which parts of the reviewer earn their keep.
export function renderPrecision(precision, config) {
  const t = totals(precision);
  const demoted = demotedClasses(precision, config);
  const name = (id) => config.classes.find((k) => k.id === id)?.name ?? '(unknown class)';
  const head = ['| Class | 👍 | 👎 | protected 👍 / 👎 | precision | status |', '| --- | --- | --- | --- | --- | --- |'];
  const rows = Object.entries(t.classes)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([k, c]) => `| ${k} ${name(Number(k))} | ${c.up} | ${c.down} | ${c.protectedUp} / ${c.protectedDown} | ${pct(c)} | ${demoted.has(Number(k)) ? 'demoted' : 'ok'} |`);
  const lt = Object.entries(t.linkTypes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, c]) => `| ${k} | ${c.up} | ${c.down} | ${c.protectedUp} / ${c.protectedDown} | ${pct(c)} |`);
  const ltHead = ['| Link type | 👍 | 👎 | protected 👍 / 👎 | precision |', '| --- | --- | --- | --- | --- |'];
  return [...head, ...(rows.length ? rows : ['| (no votes yet) | | | | | |']), '', ...ltHead, ...(lt.length ? lt : ['| (no votes yet) | | | | |'])].join('\n');
}

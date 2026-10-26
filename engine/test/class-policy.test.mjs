import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RP } from './helpers/rp.mjs';
import { normalizeConfig, setActiveProject } from '../lib/config.mjs';
import { demotedClasses, mergePrecision } from '../learn/precision.mjs';
import { applyProposals } from '../learn/apply.mjs';
import { completion } from '../lib/completion.mjs';

const config = normalizeConfig({ version: 1, project: 'p', classes: [{ id: 2, name: 'drift', protected: true }, { id: 3, name: 'silent', minConfidence: 'high' }, { id: 4, name: 'other' }], learning: { demote: { minVotes: 2, maxPrecision: 0.5 } } }).config;
afterEach(() => setActiveProject(RP));

test('a protected class is never demoted', () => {
  const rec = (cls) => ({ pr: 1, class: cls, linkTypes: [], severity: 'Medium', security: false, signal: 'down' });
  const p = mergePrecision(null, { 1: [rec(2), rec(2), rec(4), rec(4)] });
  assert.deepEqual([...demotedClasses(p, config)], [4]);
});

test('a lesson on a protected class is held for decision but its text is kept (not security)', () => {
  const c = { id: 'C-1', kind: 'correction', scope: { paths: ['src/a.ts'], class: 2, linkTypes: [] }, scopeKey: '2:src/a.ts', text: 'intentional', security: false, sources: [{ id: 's', url: 'u', pr: 1 }] };
  const r = applyProposals({ candidates: [c], proposals: [{ candidate: 'C-1', target: 'false-positives.md', rule: 'Intentional here.', scope: { paths: ['src/a.ts'] } }], config: { ...config, knowledge: ['false-positives.md'] }, files: ['src/a.ts'], today: 'd' });
  assert.equal(r.flagged.length, 1);
  assert.match(r.flagged[0].why, /class 2 is protected/);
});

test('findings below their class confidence floor are not shown; Critical and security always are', () => {
  setActiveProject({ ...RP, config });
  const f = (slug, cls, confidence, severity = 'Medium') => ({ slug, class: cls, severity, confidence, security: false, package: 'p', area: 'a', title: 't', feature: 'f', why: 'w', fix: 'x', locations: [{ file: 'a.ts', line: 1, side: 'changed' }] });
  const text = JSON.stringify({ reviewedSha: 'c'.repeat(40), findings: [f('c3:a.ts:lo', 3, 'medium'), f('c3:a.ts:hi', 3, 'high'), f('c3:a.ts:crit', 3, 'low', 'Critical'), f('c4:a.ts:x', 4, 'low')], resolvedSlugs: [], complete: true });
  const r = completion({ tier: 'full' }, text, 'success', '');
  assert.deepEqual(r.findings.findings.map((x) => x.slug), ['c3:a.ts:hi', 'c3:a.ts:crit', 'c4:a.ts:x']);
  assert.equal(r.belowFloor, 1);
});

test('learning.forbidden takes exact knowledge files or globs; anything else is a config error', async () => {
  const { normalizeConfig: n } = await import('../lib/config.mjs');
  const base = { version: 1, project: 'p', classes: [{ id: 1, name: 'x' }], knowledge: ['checklist.md', 'conventions.md', 'maps/contract-api.md'] };
  assert.deepEqual(n({ ...base, learning: { forbidden: ['conventions.md', 'maps/**'] } }).errors, []);
  assert.match(n({ ...base, learning: { forbidden: ['CLAUDE.md'] } }).errors.join(), /learning\.forbidden: CLAUDE\.md is neither a glob nor a knowledge file/);
  const cfg = n({ ...base, learning: { forbidden: ['maps/**'] } }).config;
  const c = { id: 'C-1', kind: 'correction', scope: { paths: ['src/a.ts'], class: 1, linkTypes: [] }, scopeKey: '1:src/a.ts', text: 't', security: false, sources: [{ id: 's', url: 'u', pr: 1 }] };
  const prop = (target) => applyProposals({ candidates: [c], proposals: [{ candidate: 'C-1', target, rule: 'r', scope: { paths: ['src/a.ts'] } }], config: cfg, files: ['src/a.ts'], today: 'd' });
  assert.equal(prop('maps/contract-api.md').added.length, 0, 'glob-forbidden target refused');
  assert.equal(prop('conventions.md').added.length, 1);
});

import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFacts, recordRun } from '../facts.mjs';
import { runPaths } from '../lib/paths.mjs';

const base = {
  files: [{ file: 'a.ts', status: 'M' }],
  routeResult: { packages: ['recovery-api'], linkTypes: ['callable'], classes: [13, 14] },
  results: [],
  prContext: 'ctx',
};

test('facts output is capped', () => {
  const facts = Array.from({ length: 500 }, (_, i) => ({ check: 'big', file: `f${i}.ts`, note: 'x'.repeat(300) }));
  const out = buildFacts({ ...base, results: [{ check: 'big', facts }] });
  assert.ok(Buffer.byteLength(out) <= 40000);
  assert.match(out, /more omitted/);
});

test('total output stays under cap across many checks', () => {
  const results = Array.from({ length: 10 }, (_, c) => ({
    check: `c${c}`,
    facts: Array.from({ length: 30 }, (_, i) => ({ check: `c${c}`, file: `f${i}.ts`, note: 'y'.repeat(400) })),
  }));
  const out = buildFacts({ ...base, results });
  assert.ok(Buffer.byteLength(out) <= 40000);
});

test('thrown check yields pre-check unavailable', () => {
  const out = buildFacts({ ...base, results: [{ check: 'checkRegion', error: new Error('x') }] });
  assert.match(out, /pre-check unavailable: checkRegion/);
  assert.doesNotMatch(out, /Error: x/);
});

test('contains all headings', () => {
  const out = buildFacts(base);
  for (const h of ['## Packages', '## Link types', '## Checklist classes', '## Facts', '## PR context']) {
    assert.ok(out.includes(h), h);
  }
});

test('renders facts with file and line', () => {
  const out = buildFacts({ ...base, results: [{ check: 'k', facts: [{ check: 'k', file: 'a.ts', line: 7, note: 'hello' }] }] });
  assert.match(out, /a\.ts:7/);
  assert.match(out, /hello/);
});

test('PR context carries the redacted PR title', () => {
  const secret = 'whsec' + '_' + 'B'.repeat(16);
  const out = buildFacts({ ...base, title: `ci: add ${secret}\nsecond line` });
  assert.match(out, /## PR context\nPR title: ci: add whsec_… second line/);
  assert.ok(!out.includes(secret));
});

test('OUT and STATE_FILE are both required: no fallback to "." or RUNNER_TEMP', () => {
  assert.deepEqual(runPaths({ OUT: '/t/o', STATE_FILE: '/x/s.json', RUNNER_TEMP: '/t' }), { out: '/t/o', stateFile: '/x/s.json' });
  assert.equal(runPaths({ STATE_FILE: '/x/s.json', RUNNER_TEMP: '/t' }), null);
  assert.equal(runPaths({ OUT: '/t/o', RUNNER_TEMP: '/t' }), null);
  assert.equal(runPaths({}), null);
});

test('each non-full tier states its own scope; base-drift lists drift files', () => {
  const out = buildFacts({ ...base, tier: 'base-drift', driftFiles: ['homegroups/mobile/src/a.ts'] });
  assert.match(out, /## Review tier\nbase-drift/);
  assert.match(out, /Base drift: the PR is unchanged/);
  assert.doesNotMatch(out, /Incremental:/);
  assert.match(out, /- homegroups\/mobile\/src\/a\.ts/);
  assert.match(buildFacts({ ...base, tier: 'light' }), /Light: only docs, lockfiles or images changed/);
  assert.match(buildFacts({ ...base, tier: 'incremental' }), /only changes since the last reviewed commit/);
  assert.doesNotMatch(buildFacts({ ...base, tier: 'full' }), /only changes since/);
});

test('recordRun stores tier, turns and this run link types for state and snapshot', () => {
  const s = recordRun({ linkTypesSeen: ['push'] }, 'incremental', { linkTypes: ['callable', 'storage'] });
  assert.deepEqual([s.tier, s.maxTurns, s.runLinkTypes, s.linkTypesSeen], ['incremental', 40, ['callable', 'storage'], ['push']]);
  assert.deepEqual(recordRun({}, 'full', { linkTypes: [] }).runLinkTypes, []);
});

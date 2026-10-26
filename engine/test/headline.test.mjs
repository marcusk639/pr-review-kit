import './helpers/rp.mjs';
// I6: the headline counts this run's findings and what is still open from
// earlier reviews, names the tier, and a fixed line lists unavailable pre-checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeBody } from '../publish.mjs';
import { opaqueId } from '../lib/ledger.mjs';
import { unavailableChecks } from '../facts.mjs';

const KEY = 'test-id-key';
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const OLD = 'e'.repeat(40);
const entry = (slug, severity, over = {}) => ({ id: opaqueId(slug, KEY), slug, title: `T ${slug}`, severity, status: 'open', security: false, runsSinceResolved: 0, ...over });
const state = (over = {}) => ({ lastReviewedSha: OLD, lastBaseSha: BASE, ledger: [], linkTypesSeen: [], runLinkTypes: [], inlineSlugs: [], tier: 'incremental', maxTurns: 40, headSha: HEAD, baseSha: BASE, pr: 7, ...over });
const finding = (slug, severity) => ({ slug, class: 9, severity, confidence: 'high', security: false, package: 'p', area: 'a', title: 't', feature: 'f', locations: [{ file: 'a.ts', line: 1, side: 'changed' }], why: 'w', fix: 'x' });
const text = (findings) => JSON.stringify({ reviewedSha: HEAD, findings, resolvedSlugs: [], complete: true });
const compose = (over) => composeBody({ state: state(), findingsText: text([]), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY, ...over });

test('nothing new but carried findings open: no "No issues found", counts and tier shown', () => {
  const ledger = [entry('c9:a.ts:x', 'High'), entry('c9:b.ts:y', 'High'), entry('c9:c.ts:z', 'Medium'), entry('c9:d.ts:w', 'Low', { status: 'resolved' })];
  const body = compose({ state: state({ ledger }) });
  assert.doesNotMatch(body, /No issues found/);
  assert.match(body, /Reviewed `ccccccc` \(incremental\): 0 reported this run; 3 still open from earlier reviews \(2 High, 1 Medium\)\./);
});

test('this run and carried findings are counted separately', () => {
  const body = compose({ state: state({ ledger: [entry('c9:a.ts:x', 'Low')] }), findingsText: text([finding('c9:n.ts:n', 'Critical'), finding('c9:m.ts:m', 'Low')]) });
  assert.match(body, /Reviewed `ccccccc` \(incremental\): 2 reported this run \(1 Critical, 1 Low\); 1 still open from earlier reviews \(1 Low\)\./);
});

test('"No issues found" only when nothing is open at all', () => {
  assert.match(compose({ state: state({ tier: 'full' }) }), /Reviewed `ccccccc` \(full\): No issues found\./);
});

test('a fixed line names the tier and the unavailable pre-checks; bad names are dropped', () => {
  const body = compose({ state: state({ unavailableChecks: ['checkRegion', 'runVerifyDiff', 'bad name<!--', 7] }) });
  assert.match(body, /Tier: `incremental`; unavailable pre-checks: checkRegion, runVerifyDiff\./);
  assert.match(compose(), /Tier: `incremental`; unavailable pre-checks: none\./);
  assert.match(compose({ state: state({ tier: '<b>x' }) }), /Tier: `unknown`/);
});

test('facts records a check as unavailable when it threw or reported itself unavailable', () => {
  const results = [
    { check: 'checkRegion', error: new Error('x') },
    { check: 'runVerifyDiff', facts: [{ check: 'verify-diff', file: 'v', line: null, note: 'verify-diff unavailable' }] },
    { check: 'checkQueriesVsIndexes', facts: [{ check: 'queries-vs-indexes', file: 'i', line: null, note: 'queries-vs-indexes unavailable: index file missing' }] },
    { check: 'checkSecrets', facts: [{ check: 'secrets', file: 'a', line: 1, note: 'possible secret' }] },
    { check: 'checkTwins', facts: [] },
  ];
  assert.deepEqual(unavailableChecks(results), ['checkRegion', 'runVerifyDiff', 'checkQueriesVsIndexes']);
});

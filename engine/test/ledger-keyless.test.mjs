import './helpers/rp.mjs';
// Round 3: public (non-security) ledger entries are matched by slug, so a run
// before PR_REVIEW_ID_KEY exists, or after it is rotated, neither counts a
// finding twice nor leaves the old entry "still open" forever. Security and
// withheld entries keep keyed ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeBody } from '../publish.mjs';
import { mergeLedger, opaqueId, publicId, toLedgerEntry } from '../lib/ledger.mjs';
import { decodeLedger } from '../lib/markers.mjs';

const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const OLD = 'e'.repeat(40);
const KEY = 'new-key';
const OLD_KEY = 'old-key';
const SLUG = 'c9:regroup/mobile/src/a.ts:load';
const finding = (slug = SLUG, over = {}) => ({
  slug, class: 9, severity: 'Medium', confidence: 'high', security: false, package: 'regroup/mobile', area: 'data',
  title: 'Swallowed error', feature: 'Feed', locations: [{ file: 'regroup/mobile/src/a.ts', line: 3, side: 'changed' }], why: 'w', fix: 'x', ...over,
});
const entry = (id, over = {}) => ({ id, slug: SLUG, title: 'Swallowed error', severity: 'Medium', status: 'open', security: false, runsSinceResolved: 0, ...over });
const state = (ledger, over = {}) => ({ lastReviewedSha: OLD, lastBaseSha: BASE, ledger, linkTypesSeen: [], runLinkTypes: [], tier: 'incremental', headSha: HEAD, baseSha: BASE, ...over });
const text = (findings, resolvedSlugs = []) => JSON.stringify({ reviewedSha: HEAD, findings, resolvedSlugs, complete: true });
const compose = (s, findings, over = {}) => composeBody({ state: s, findingsText: text(findings, over.resolvedSlugs), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY, linkTypes: [], ...over });

test('public entries get an unkeyed id; security entries stay keyed', () => {
  assert.equal(toLedgerEntry(finding(), KEY).id, publicId(SLUG));
  assert.equal(toLedgerEntry(finding(), null).id, publicId(SLUG));
  const sec = finding('c1:regroup/functions/src/pay.ts:charge', { class: 1, security: true });
  assert.equal(toLedgerEntry(sec, KEY).id, opaqueId(sec.slug, KEY));
  assert.notEqual(toLedgerEntry(sec, KEY).id, publicId(sec.slug));
});

for (const [name, priorId] of [['an id made before the key existed', publicId(SLUG)], ['an id keyed with a rotated-out key', opaqueId(SLUG, OLD_KEY)]]) {
  test(`re-reporting a finding whose entry has ${name}: one entry, not new, not "still open"`, () => {
    const body = compose(state([entry(priorId)]), [finding()]);
    const ledger = decodeLedger(body).ledger;
    assert.equal(ledger.filter((e) => e.slug === SLUG).length, 1, 'counted once');
    assert.equal(ledger[0].id, publicId(SLUG));
    assert.doesNotMatch(body, /\(new\)/);
    assert.match(body, /1 reported this run \(1 Medium\); 0 still open from earlier reviews/);
  });

  test(`resolvedSlugs resolves an entry with ${name}`, () => {
    const ledger = decodeLedger(compose(state([entry(priorId)]), [], { resolvedSlugs: [SLUG] })).ledger;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].status, 'resolved');
  });

  test(`a maintainer's reply resolves an entry with ${name}`, () => {
    const ledger = decodeLedger(compose(state([entry(priorId)], { acknowledgedSlugs: [SLUG] }), [])).ledger;
    assert.equal(ledger[0].status, 'resolved');
  });
}

test('mergeLedger without a key matches a public entry keyed earlier, by slug', () => {
  const merged = mergeLedger([entry(opaqueId(SLUG, OLD_KEY))], [finding()], [], 'incremental', { key: null });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, publicId(SLUG));
});

test('a security entry is not matched by slug guessing: its id stays keyed', () => {
  const sec = { id: opaqueId('c1:x.ts:y', OLD_KEY), severity: 'High', status: 'open', security: true, runsSinceResolved: 0, fileIds: [] };
  const merged = mergeLedger([sec], [], ['c1:x.ts:y'], 'incremental', { key: KEY });
  assert.equal(merged[0].status, 'open', 'resolvedSlugs never resolve a security entry');
});

test('a slug over the stored length still matches its own entry, with the key set', () => {
  const long = `c9:regroup/mobile/src/${'deep/'.repeat(50)}a.ts:load`;
  assert.ok(long.length > 200);
  const first = mergeLedger([], [finding(long)], [], 'full', { key: KEY });
  const again = mergeLedger(first, [finding(long)], [], 'incremental', { key: KEY });
  assert.equal(again.length, 1, 'not counted twice');
  const resolved = mergeLedger(again, [], [long], 'incremental', { key: KEY });
  assert.equal(resolved[0].status, 'resolved');
  const body = compose(state(again), [finding(long)]);
  assert.match(body, /1 reported this run \(1 Medium\); 0 still open from earlier reviews/);
  assert.doesNotMatch(body, /\(new\)/);
});

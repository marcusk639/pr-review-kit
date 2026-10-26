import './helpers/rp.mjs';
// I2 (already-public entries are never rewritten as withheld), I4 (no id key:
// security and withheld entries frozen, not erased), I5 (an id reported this
// run is never resolved) and the decoded marker never holding a secret or a
// security file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLedger, opaqueId } from '../lib/ledger.mjs';
import { fileId } from '../lib/fileids.mjs';
import { decodeLedger } from '../lib/markers.mjs';
import { composeBody } from '../publish.mjs';

const FAKE_WHSEC = 'whsec' + '_' + 'A'.repeat(16);
const KEY = 'test-id-key';
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const OLD = 'e'.repeat(40);
const SEC_FILE = 'regroup/functions/src/callable/payments.ts';

const finding = (over = {}) => ({
  slug: 'c9:regroup/mobile/src/a.ts:load', class: 9, severity: 'Medium', confidence: 'high', security: false,
  package: 'regroup/mobile', area: 'data', title: 'Swallowed error', feature: 'Feed',
  locations: [{ file: 'regroup/mobile/src/a.ts', line: 3, side: 'changed' }], why: 'w', fix: 'x', ...over,
});
const SEC = finding({ slug: `c1:${SEC_FILE}:charge`, class: 1, severity: 'High', security: true, locations: [{ file: SEC_FILE, line: 9, side: 'changed' }] });
const PUBLIC_NEAR = { id: opaqueId(`c9:${SEC_FILE}:old`, KEY), slug: `c9:${SEC_FILE}:old`, title: 'Old note on payments.ts', severity: 'Low', status: 'open', security: false, runsSinceResolved: 0 };
const PRIOR_SEC = { id: opaqueId(`c1:${SEC_FILE}:x`, KEY), severity: 'High', status: 'open', security: true, runsSinceResolved: 0, fileIds: [fileId(SEC_FILE, KEY)] };
const PRIOR_WITHHELD = { id: opaqueId('c9:w.ts:w', KEY), severity: 'Low', status: 'open', security: false, runsSinceResolved: 2, withheld: true };

const needles = [SEC_FILE, 'payments.ts'];
const state = (over = {}) => ({ lastReviewedSha: OLD, lastBaseSha: BASE, ledger: [], linkTypesSeen: [], runLinkTypes: [], inlineSlugs: [], tier: 'incremental', maxTurns: 40, headSha: HEAD, baseSha: BASE, pr: 7, ...over });
const text = (findings, resolvedSlugs = []) => JSON.stringify({ reviewedSha: HEAD, findings, resolvedSlugs, complete: true });
const compose = (over) => composeBody({ state: state(), findingsText: text([]), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY, ...over });

test('I2: a prior public entry naming a security file is left exactly as it was', () => {
  const merged = mergeLedger([PUBLIC_NEAR], [SEC], [], 'incremental', { key: KEY, needles });
  assert.deepEqual(merged.find((e) => e.id === PUBLIC_NEAR.id), PUBLIC_NEAR);
});

test('I2: re-reporting an already-public slug on a security file keeps the public entry, not a withheld one', () => {
  const again = finding({ slug: PUBLIC_NEAR.slug, severity: 'High', locations: [{ file: SEC_FILE, line: 50, side: 'changed' }] });
  const merged = mergeLedger([{ ...PUBLIC_NEAR, status: 'resolved', runsSinceResolved: 1 }], [SEC, again], [], 'incremental', { key: KEY, needles });
  const e = merged.find((x) => x.slug === PUBLIC_NEAR.slug);
  assert.equal(e.withheld, undefined);
  assert.equal(e.slug, PUBLIC_NEAR.slug);
  assert.equal(e.title, PUBLIC_NEAR.title, 'the already-public title, not the new text');
  assert.equal(e.status, 'open');
  assert.equal(e.severity, 'High');
  // A brand-new finding on that file is still withheld.
  const fresh = finding({ slug: `c9:${SEC_FILE}:fresh`, locations: [{ file: SEC_FILE, line: 60, side: 'changed' }] });
  const m2 = mergeLedger([], [SEC, fresh], [], 'incremental', { key: KEY, needles });
  assert.equal(m2.find((x) => x.id === opaqueId(fresh.slug, KEY)).withheld, true);
});

test('I4: without the id key prior security and withheld entries are carried unchanged, none added', () => {
  const ledger = [PRIOR_SEC, PRIOR_WITHHELD];
  const near = finding({ slug: `c9:${SEC_FILE}:near`, locations: [{ file: SEC_FILE, line: 70, side: 'changed' }] });
  const body = compose({ state: state({ ledger }), findingsText: text([SEC, near]), idKey: null });
  const m = decodeLedger(body).ledger;
  assert.deepEqual(m.filter((e) => e.security || e.withheld), ledger);
  assert.match(body, /ledger frozen for security entries: id key unavailable/);
  assert.match(body, /Security-relevant issue \(High\) in regroup\/mobile data; details could not be delivered privately; id key unavailable/);
  const failed = decodeLedger(compose({ state: state({ ledger }), findingsText: null, outcome: 'failure', idKey: null })).ledger;
  assert.deepEqual(failed, ledger, 'a failed run without the key keeps them too');
  const keyed = compose({ state: state({ ledger }), findingsText: text([]) });
  assert.doesNotMatch(keyed, /ledger frozen/);
});

test('I5: an id reported in this run is never resolved, even if its advisory was dispositioned', () => {
  const ledger = [{ ...PRIOR_SEC, id: opaqueId(SEC.slug, KEY) }];
  const m = decodeLedger(compose({ state: state({ ledger }), findingsText: text([SEC]), resolvedIds: [opaqueId(SEC.slug, KEY)] })).ledger;
  assert.equal(m.find((e) => e.id === opaqueId(SEC.slug, KEY)).status, 'open');
  const untouched = decodeLedger(compose({ state: state({ ledger }), findingsText: text([]), resolvedIds: [opaqueId(SEC.slug, KEY)] })).ledger;
  assert.equal(untouched[0].status, 'resolved');
});

test('the decoded marker holds no secret and no security file, even from a tampered prior entry', () => {
  const secretSlug = finding({ slug: `c9:regroup/mobile/src/a.ts:${FAKE_WHSEC}`, title: `Token ${FAKE_WHSEC} logged` });
  const tampered = [
    { id: opaqueId('c1:t.ts:t', KEY), severity: 'High', status: 'open', security: true, runsSinceResolved: 0, slug: `c1:${SEC_FILE}:x`, title: FAKE_WHSEC, file: SEC_FILE, fileIds: [] },
    { id: opaqueId('c9:t.ts:u', KEY), slug: `c9:t.ts:${FAKE_WHSEC}`, title: `see ${FAKE_WHSEC}`, severity: 'Low', status: 'open', security: false, runsSinceResolved: 0, why: SEC_FILE },
  ];
  const near = finding({ slug: `c9:${SEC_FILE}:near`, title: 'Near payments.ts', locations: [{ file: SEC_FILE, line: 70, side: 'changed' }] });
  for (const idKey of [KEY, null]) {
    const body = compose({ state: state({ ledger: tampered }), findingsText: text([SEC, secretSlug, near]), idKey });
    const json = JSON.stringify(decodeLedger(body));
    assert.ok(!json.includes(FAKE_WHSEC), 'no secret in the marker');
    assert.ok(!json.toLowerCase().includes('payments.ts'), 'no security file in the marker');
    assert.ok(!body.includes(FAKE_WHSEC), 'no secret in the body');
  }
});

test('without the key resolved security and withheld entries are not aged either', () => {
  const ledger = [{ ...PRIOR_SEC, status: 'resolved', runsSinceResolved: 1 }, { ...PRIOR_WITHHELD, status: 'resolved', runsSinceResolved: 3 }];
  assert.deepEqual(mergeLedger(ledger, [], [], 'incremental', { key: null, needles: [] }), ledger);
  const keyed = mergeLedger(ledger, [], [], 'incremental', { key: KEY, needles: [] });
  assert.deepEqual(keyed.map((e) => e.runsSinceResolved), [2, 4]);
});

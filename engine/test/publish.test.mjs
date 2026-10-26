import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeBody, failureReason } from '../publish.mjs';
import { decodeLedger } from '../lib/markers.mjs';
import { opaqueId } from '../lib/ledger.mjs';
import { fileId } from '../lib/fileids.mjs';

// Built at runtime so this source holds no secret-shaped literal.
const FAKE_WHSEC = 'whsec' + '_' + 'A'.repeat(16);
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const SEC_FILE = 'regroup/functions/src/callable/payments.ts';
const KEY = 'test-id-key';
const OLD = 'e'.repeat(40);
const OLDBASE = 'f'.repeat(40);

const L = [
  { id: opaqueId('c9:a.ts:x', KEY), slug: 'c9:a.ts:x', title: 'Swallowed error', severity: 'Medium', status: 'open', security: false, runsSinceResolved: 0 },
  { id: opaqueId('c1:b.ts:y', KEY), severity: 'High', status: 'open', security: true, runsSinceResolved: 0, fileIds: [] },
];

function state(over = {}) {
  return {
    lastReviewedSha: OLD,
    lastBaseSha: OLDBASE,
    ledger: L,
    linkTypesSeen: ['callable'],
    inlineSlugs: [],
    tier: 'full',
    maxTurns: 60,
    headSha: HEAD,
    baseSha: BASE,
    pr: 7,
    ...over,
  };
}

const secFinding = {
  slug: `c1:${SEC_FILE}:createCharge`,
  class: 1,
  severity: 'High',
  confidence: 'high',
  security: true,
  package: 'regroup/functions',
  area: 'payments',
  title: 'Trusted client account',
  feature: 'Rent payment',
  locations: [{ file: SEC_FILE, line: 30, side: 'changed' }],
  why: 'trusts input',
  fix: 'derive server-side',
  inlinePosted: false,
};

function findingsText(findings) {
  return JSON.stringify({ reviewedSha: HEAD, findings, resolvedSlugs: [], complete: true });
}

test('publish redacts secrets and withholds security paths', () => {
  const narrative = [
    '## Features touched',
    `- Webhook config uses ${FAKE_WHSEC} in the sample`,
    `- Changed ${SEC_FILE} for rent payments`,
    '- Also touched payments.ts helper',
    '## Checked and fine',
    '- callable names match',
  ].join('\n');
  const body = composeBody({ state: state(), findingsText: findingsText([secFinding]), narrative, outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY });
  assert.ok(body.includes('whsec_…'));
  assert.ok(!body.includes(FAKE_WHSEC));
  assert.ok(!body.includes(SEC_FILE));
  assert.ok(!body.includes('payments.ts'));
  assert.ok(body.includes('narrative withheld'));
  assert.ok(body.includes('callable names match'));
});

test('publish keeps prior state when findings.json is invalid', () => {
  const text = findingsText([secFinding]).slice(0, 60);
  const body = composeBody({ state: state(), findingsText: text, narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY });
  assert.ok(body.includes('review did not complete (failed)'));
  const m = decodeLedger(body);
  assert.deepEqual(m.ledger, L);
  assert.equal(m.lastReviewedSha, OLD);
  assert.equal(m.lastBaseSha, OLDBASE);
  assert.deepEqual(m.linkTypesSeen, ['callable']);
  assert.ok(body.includes('Swallowed error'));
  assert.ok(body.includes('Security-relevant issue (High)'));
  assert.doesNotMatch(body, /No issues found/);
});

test('failed action keeps prior state even with valid findings', () => {
  const body = composeBody({ state: state(), findingsText: findingsText([]), narrative: '', outcome: 'failure', headSha: HEAD, baseSha: BASE, idKey: KEY });
  assert.ok(body.includes('review did not complete (failed)'));
  assert.equal(decodeLedger(body).lastReviewedSha, OLD);
});

test('rate limit in the execution log is reported as rate-limited', () => {
  assert.equal(failureReason('... "result":"Claude AI usage limit reached" ...'), 'rate-limited');
  assert.equal(failureReason('error: Rate limit exceeded'), 'rate-limited');
  assert.equal(failureReason('max turns'), 'failed');
  assert.equal(failureReason(null), 'failed');
  const body = composeBody({ state: state(), findingsText: null, narrative: '', outcome: 'failure', executionLog: 'rate_limit_error', headSha: HEAD, baseSha: BASE, idKey: KEY });
  assert.ok(body.includes('review did not complete (rate-limited)'));
});

test('success writes the new marker: current findings win over prior entries', () => {
  const reReported = { ...secFinding, slug: 'c1:b.ts:y', severity: 'Critical', locations: [{ file: 'b.ts', line: 1, side: 'changed' }] };
  const body = composeBody({ state: state(), findingsText: findingsText([reReported]), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY });
  const m = decodeLedger(body);
  assert.equal(m.lastReviewedSha, HEAD);
  assert.equal(m.lastBaseSha, BASE);
  assert.deepEqual(m.linkTypesSeen, ['callable']);
  assert.equal(m.ledger.length, 2);
  assert.deepEqual(m.ledger.find((e) => e.id === opaqueId('c1:b.ts:y', KEY)), {
    id: opaqueId('c1:b.ts:y', KEY), severity: 'Critical', status: 'open', security: true, runsSinceResolved: 0, fileIds: [fileId('b.ts', KEY)],
  });
  assert.ok(m.ledger.some((e) => e.slug === 'c9:a.ts:x'));
});

test('malformed prior ledger entries are dropped and security entries reshaped', () => {
  const dirty = [...L, 'junk', { id: 'nothex', severity: 'High', status: 'open', security: false }, { id: opaqueId('c1:z.ts:z', KEY), severity: 'Low', status: 'open', security: true, runsSinceResolved: 0, slug: 'leak', title: 'leak' }];
  const body = composeBody({ state: state({ ledger: dirty }), findingsText: null, narrative: '', outcome: 'failure', headSha: HEAD, baseSha: BASE, idKey: KEY });
  const m = decodeLedger(body);
  assert.equal(m.ledger.length, 3);
  assert.ok(!JSON.stringify(m.ledger).includes('leak'));
});

test('missing state on success fails closed with a decodable marker', () => {
  const body = composeBody({ state: null, findingsText: findingsText([]), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY });
  const m = decodeLedger(body);
  assert.equal(m.lastReviewedSha, null);
  assert.deepEqual(m.ledger, []);
  assert.match(body, /review did not complete \(failed\)/);
  assert.doesNotMatch(body, /No issues found/);
});

test('keyed ids: same slug and key match, a different key does not', () => {
  assert.equal(opaqueId('c1:x.ts:y', KEY), opaqueId('c1:x.ts:y', KEY));
  assert.notEqual(opaqueId('c1:x.ts:y', KEY), opaqueId('c1:x.ts:y', 'other-key'));
  assert.notEqual(opaqueId('c1:x.ts:y', KEY), opaqueId('c1:x.ts:y'));
});

test('without the id key no security entry is added, prior ones are carried, and the pointer says why', () => {
  const body = composeBody({ state: state(), findingsText: findingsText([secFinding]), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE });
  const m = decodeLedger(body);
  assert.deepEqual(m.ledger.filter((e) => e.security), [L[1]]);
  assert.ok(m.ledger.some((e) => e.slug === 'c9:a.ts:x'));
  assert.ok(body.includes('Security-relevant issue (High) in regroup/functions payments; details could not be delivered privately; id key unavailable'));
  const failed = decodeLedger(composeBody({ state: state(), findingsText: null, narrative: '', outcome: 'failure', headSha: HEAD, baseSha: BASE }));
  assert.deepEqual(failed.ledger.filter((e) => e.security), [L[1]]);
});

test('an id that was security stays security when re-reported as non-security', () => {
  const again = { ...secFinding, slug: 'c1:b.ts:y', security: false, title: 'Now looks harmless', locations: [{ file: 'b.ts', line: 2, side: 'changed' }] };
  const m = decodeLedger(composeBody({ state: state(), findingsText: findingsText([again]), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY }));
  const e = m.ledger.find((x) => x.id === opaqueId('c1:b.ts:y', KEY));
  assert.deepEqual(Object.keys(e).sort(), ['fileIds', 'id', 'runsSinceResolved', 'security', 'severity', 'status']);
  assert.deepEqual(e.fileIds, [fileId('b.ts', KEY)]);
  assert.ok(!JSON.stringify(m.ledger).includes('Now looks harmless'));
});

test('prior SHAs must be 40-hex and linkTypesSeen is limited to routing.json types', () => {
  const s = state({ lastReviewedSha: 'old', lastBaseSha: 'x'.repeat(40), linkTypesSeen: ['callable', 'y'.repeat(5000), 'callable', 7] });
  const m = decodeLedger(composeBody({ state: s, findingsText: null, narrative: '', outcome: 'failure', headSha: HEAD, baseSha: BASE, idKey: KEY }));
  assert.equal(m.lastReviewedSha, null);
  assert.equal(m.lastBaseSha, null);
  assert.deepEqual(m.linkTypesSeen, ['callable']);
});

test('non-security finding text naming a security file is withheld, case and slashes ignored', () => {
  const other = {
    ...secFinding,
    slug: 'c9:regroup/functions/src/util/log.ts:logIt',
    class: 9,
    severity: 'Medium',
    security: false,
    title: 'Error swallowed near PAYMENTS.TS',
    why: 'See regroup\\functions\\src\\callable\\payments.ts for the caller',
    fix: 'Rethrow',
    locations: [{ file: 'regroup/functions/src/util/log.ts', line: 3, side: 'changed' }],
  };
  const narrative = 'Touched Regroup\\Functions\\src\\callable\\Payments.ts today\nOther line';
  const body = composeBody({ state: state(), findingsText: findingsText([secFinding, other]), narrative, outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY });
  assert.doesNotMatch(body, /payments\.ts/i);
  assert.ok(body.includes('(withheld: touches a security-relevant file)'));
  noNeedle(body);
  assert.ok(body.includes('Other line'));
  assert.ok(body.includes('narrative withheld'));
});

function noNeedle(body) {
  const json = JSON.stringify(decodeLedger(body)).toLowerCase();
  for (const n of [SEC_FILE.toLowerCase(), 'payments.ts']) assert.ok(!json.includes(n), `ledger contains ${n}`);
}

const nonSec = (over) => ({
  ...secFinding,
  slug: 'c9:regroup/functions/src/util/log.ts:logIt',
  class: 9,
  severity: 'Medium',
  security: false,
  title: 'Swallowed error',
  why: 'w',
  fix: 'f',
  feature: 'Logging',
  locations: [{ file: 'regroup/functions/src/util/log.ts', line: 3, side: 'changed' }],
  ...over,
});

const WITHHELD_KEYS = ['id', 'runsSinceResolved', 'security', 'severity', 'status', 'withheld'];

test('ledger: a non-security title naming a security file is stored withheld', () => {
  const f = nonSec({ title: 'Error swallowed near Payments.TS' });
  const body = composeBody({ state: state(), findingsText: findingsText([secFinding, f]), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY });
  noNeedle(body);
  const e = decodeLedger(body).ledger.find((x) => x.id === opaqueId(f.slug, KEY));
  assert.deepEqual(Object.keys(e).sort(), WITHHELD_KEYS);
  assert.equal(e.withheld, true);
  assert.ok(body.includes('(withheld: touches a security-relevant file)'));
  assert.ok(!body.includes('Error swallowed near'));
});

test('ledger: a non-security finding located in a security file is withheld everywhere', () => {
  const f = nonSec({ slug: `c9:${SEC_FILE}:otherFn`, locations: [{ file: SEC_FILE, line: 90, side: 'changed' }] });
  const body = composeBody({ state: state(), findingsText: findingsText([secFinding, f]), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY });
  noNeedle(body);
  assert.doesNotMatch(body, /payments\.ts/i);
  assert.ok(!body.includes('Logging'));
});

test('ledger: a same-run slug collision stays security, with or without the key', () => {
  const f = nonSec({ slug: secFinding.slug, title: 'Collides' });
  for (const order of [[f, secFinding], [secFinding, f]]) {
    const keyed = composeBody({ state: state(), findingsText: findingsText(order), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY });
    noNeedle(keyed);
    const e = decodeLedger(keyed).ledger.find((x) => x.id === opaqueId(secFinding.slug, KEY));
    assert.deepEqual({ ...e, fileIds: [...e.fileIds].sort() }, { id: e.id, severity: 'High', status: 'open', security: true, runsSinceResolved: 0, fileIds: [...new Set([fileId(SEC_FILE, KEY), fileId(f.locations[0].file, KEY)])].sort() });
    const unkeyed = composeBody({ state: state(), findingsText: findingsText(order), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE });
    noNeedle(unkeyed);
    assert.ok(!decodeLedger(unkeyed).ledger.some((x) => x.id === opaqueId(secFinding.slug)));
  }
});

test('withheld prior entries survive a failed run in their exact shape', () => {
  const w = { id: opaqueId('c9:q.ts:q', KEY), severity: 'Low', status: 'open', security: false, runsSinceResolved: 1, withheld: true, slug: 'x', title: 'y' };
  const m = decodeLedger(composeBody({ state: state({ ledger: [w] }), findingsText: null, narrative: '', outcome: 'failure', headSha: HEAD, baseSha: BASE, idKey: KEY }));
  assert.deepEqual(m.ledger, [{ id: w.id, severity: 'Low', status: 'open', security: false, runsSinceResolved: 1, withheld: true }]);
});

test('resolvedSlugs entries over 300 characters are rejected', () => {
  const text = JSON.stringify({ reviewedSha: HEAD, findings: [], resolvedSlugs: ['c1:' + 'a'.repeat(400) + ':x'] });
  const body = composeBody({ state: state(), findingsText: text, narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY });
  assert.ok(body.includes('review did not complete (failed)'));
});

test('ledger without the id key: no new withheld entry and no needle; prior ones carried', () => {
  const located = nonSec({ slug: `c9:${SEC_FILE}:otherFn`, locations: [{ file: SEC_FILE, line: 90, side: 'changed' }] });
  const titled = nonSec({ slug: 'c9:regroup/functions/src/util/x.ts:y', title: 'Near payments.ts' });
  const priorWithheld = { id: opaqueId('c9:w.ts:w', KEY), severity: 'Low', status: 'open', security: false, runsSinceResolved: 0, withheld: true };
  const body = composeBody({
    state: state({ ledger: [...L, priorWithheld] }),
    findingsText: findingsText([secFinding, located, titled]),
    narrative: '',
    outcome: 'success',
    headSha: HEAD,
    baseSha: BASE,
  });
  noNeedle(body);
  const ledger = decodeLedger(body).ledger;
  assert.deepEqual(ledger.filter((e) => e.withheld || e.security), [L[1], priorWithheld]);
  assert.ok(!ledger.some((e) => e.id === opaqueId(located.slug)));
  assert.ok(ledger.some((e) => e.slug === 'c9:a.ts:x'));
  assert.ok(body.includes('(withheld: touches a security-relevant file)'));
});

test('disguised security file names in a non-security title are withheld', () => {
  for (const disguise of ['payments​.ts', 'payments&#46;ts', 'payments%2Ets', 'payments&period;ts', 'Payments&#x2E;TS']) {
    const f = nonSec({ title: `Error near ${disguise}` });
    const body = composeBody({ state: state(), findingsText: findingsText([secFinding, f]), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY });
    assert.ok(body.includes('(withheld: touches a security-relevant file)'), disguise);
    assert.ok(!body.includes('Error near'), disguise);
    assert.ok(decodeLedger(body).ledger.find((x) => x.id === opaqueId(f.slug, KEY)).withheld, disguise);
  }
});

test('an upper-case HEAD_SHA is lower-cased, so later comparisons still match', () => {
  const body = composeBody({ state: state(), findingsText: findingsText([]), narrative: '', outcome: 'success', headSha: HEAD.toUpperCase(), baseSha: BASE.toUpperCase(), idKey: KEY });
  const p = decodeLedger(body);
  assert.equal(p.lastReviewedSha, HEAD);
  assert.equal(p.lastBaseSha, BASE);
  assert.match(body, /`ccccccc`/);
  const none = composeBody({ state: state({ tier: 'none', lastReviewedSha: 'A'.repeat(40) }), findingsText: null, narrative: '', outcome: 'skipped', headSha: HEAD.toUpperCase(), baseSha: BASE, idKey: KEY });
  assert.equal(decodeLedger(none).lastReviewedSha, HEAD);
});

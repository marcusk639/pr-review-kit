import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLedger, visibleEntries, opaqueId, fitMarker } from '../lib/ledger.mjs';
import { composeBody } from '../publish.mjs';
import { decodeLedger, encodeLedger } from '../lib/markers.mjs';

const KEY = 'test-id-key';
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const OLD = 'e'.repeat(40);
const OLDBASE = 'f'.repeat(40);
const SEC_FILE = 'regroup/functions/src/callable/payments.ts';

function finding(over = {}) {
  return {
    slug: 'c9:regroup/mobile/src/a.ts:load',
    class: 9,
    severity: 'Medium',
    confidence: 'high',
    security: false,
    package: 'regroup/mobile',
    area: 'rent',
    title: 'Swallowed error',
    feature: 'Rent history',
    locations: [{ file: 'regroup/mobile/src/a.ts', line: 3, side: 'changed' }],
    why: 'catch ignores it',
    fix: 'rethrow',
    inlinePosted: false,
    ...over,
  };
}

const SEC = finding({ slug: `c1:${SEC_FILE}:createCharge`, class: 1, severity: 'High', security: true, title: 'Trusted client account', locations: [{ file: SEC_FILE, line: 30, side: 'changed' }] });

const merge = (prior, findings, resolved = [], tier = 'incremental', key = KEY) => mergeLedger(prior, findings, resolved, tier, { key });

test('a security finding yields an entry with exactly the security keys', () => {
  const [e] = merge([], [SEC]);
  assert.deepEqual(Object.keys(e), ['id', 'severity', 'status', 'security', 'runsSinceResolved', 'fileIds']);
  assert.equal(e.id, opaqueId(SEC.slug, KEY));
});

test('the same slug on two runs yields one entry', () => {
  const once = merge([], [finding()]);
  const twice = merge(once, [finding({ severity: 'High' })]);
  assert.equal(twice.length, 1);
  assert.equal(twice[0].severity, 'High');
  assert.equal(twice[0].status, 'open');
});

test('resolvedSlugs resolves; five more merges hide it but the ledger keeps it', () => {
  const other = finding({ slug: 'c9:regroup/mobile/src/b.ts:save' });
  let l = merge([], [finding(), other]);
  l = merge(l, [], [finding().slug, other.slug]);
  assert.deepEqual(l.map((e) => [e.status, e.runsSinceResolved]), [['resolved', 0], ['resolved', 0]]);
  for (let i = 0; i < 5; i++) l = merge(l, []);
  assert.equal(l.length, 2);
  assert.ok(l.every((e) => e.runsSinceResolved === 5));
  assert.deepEqual(visibleEntries(l), []);
  assert.equal(visibleEntries(merge(merge([], [finding()]), [], [finding().slug])).length, 1);
});

test('resolvedSlugs naming security or withheld entries are ignored (private channel only)', () => {
  const withheld = { id: opaqueId('c9:w.ts:q', KEY), severity: 'Low', status: 'open', security: false, runsSinceResolved: 0, withheld: true };
  const l = merge([...merge([], [SEC]), withheld], [], [SEC.slug, 'c9:w.ts:q']);
  assert.deepEqual(l.map((e) => e.status), ['open', 'open']);
});

test('an open entry not re-reported stays open; a resolvedSlug repeated does not reset its age', () => {
  let l = merge([], [finding()]);
  l = merge(l, []);
  assert.equal(l[0].status, 'open');
  l = merge(l, [], [finding().slug]);
  l = merge(l, [], [finding().slug]);
  assert.deepEqual([l[0].status, l[0].runsSinceResolved], ['resolved', 1]);
});

test('a re-reported resolved finding reopens; a finding listed as resolved too stays open', () => {
  let l = merge(merge([], [finding()]), [], [finding().slug]);
  l = merge(l, [finding()]);
  assert.deepEqual([l[0].status, l[0].runsSinceResolved], ['open', 0]);
  const both = merge([], [finding()], [finding().slug]);
  assert.equal(both[0].status, 'open');
});

test('tier none leaves the ledger unchanged', () => {
  const l = merge(merge([], [finding()]), [], [finding().slug]);
  assert.deepEqual(merge(l, [], [], 'none'), l);
});

test('resolution by id works without a key for non-security entries', () => {
  const l = merge(merge([], [finding()], [], 'full', null), [], [finding().slug], 'light', null);
  assert.equal(l[0].status, 'resolved');
});

test('fitMarker trims the oldest resolved entries first', () => {
  const open = merge([], [finding({ slug: 'c9:x.ts:open', title: 'T'.repeat(100) })]);
  const old = { ...merge([], [finding({ slug: 'c9:x.ts:old' })])[0], status: 'resolved', runsSinceResolved: 9 };
  const young = { ...merge([], [finding({ slug: 'c9:x.ts:young' })])[0], status: 'resolved', runsSinceResolved: 1 };
  const payload = { lastReviewedSha: HEAD, lastBaseSha: BASE, linkTypesSeen: [], ledger: [old, ...open, young] };
  const max = encodeLedger({ ...payload, ledger: [...open, young] }).length;
  const fitted = fitMarker(payload, encodeLedger, max);
  assert.deepEqual(fitted.ledger.map((e) => e.slug), ['c9:x.ts:open', 'c9:x.ts:young']);
  assert.equal(fitted.ledger[0].title, 'T'.repeat(100));
});

const PRIOR = [
  { id: opaqueId('c9:a.ts:x', KEY), slug: 'c9:a.ts:x', title: 'Swallowed error', severity: 'Medium', status: 'open', security: false, runsSinceResolved: 0 },
  { id: opaqueId('c1:b.ts:y', KEY), severity: 'High', status: 'open', security: true, runsSinceResolved: 0, fileIds: [] },
  { id: opaqueId('c9:c.ts:z', KEY), slug: 'c9:c.ts:z', title: 'Old fixed thing', severity: 'Low', status: 'resolved', security: false, runsSinceResolved: 2 },
];

function snap(over = {}) {
  return { lastReviewedSha: OLD, lastBaseSha: OLDBASE, ledger: PRIOR, linkTypesSeen: ['callable'], runLinkTypes: [], inlineSlugs: [], tier: 'none', maxTurns: 0, headSha: HEAD, baseSha: BASE, pr: 7, ...over };
}

const compose = (over) => composeBody({ narrative: '', headSha: HEAD, baseSha: BASE, idKey: KEY, findingsText: null, outcome: 'skipped', ...over });

test('publish for tier none keeps the ledger and moves lastReviewedSha to the head', () => {
  const body = compose({ state: snap(), baseSha: OLDBASE });
  const m = decodeLedger(body);
  assert.deepEqual(m.ledger, PRIOR);
  assert.equal(m.lastReviewedSha, HEAD);
  assert.equal(m.lastBaseSha, OLDBASE);
  assert.deepEqual(m.linkTypesSeen, ['callable']);
  assert.match(body, /No new changes since `eeeeeee`/);
  assert.match(body, /Swallowed error/);
  assert.match(body, /Security-relevant issue \(High\)/);
  assert.doesNotMatch(body, /did not complete/);
});

test('publish for tier none says base updated when the base moved', () => {
  const body = compose({ state: snap() });
  assert.match(body, /Base updated; no counterpart changes/);
  assert.equal(decodeLedger(body).lastBaseSha, BASE);
});

test('skipped outside tier none, a failed tier none, or a missing snapshot is a failure', () => {
  for (const over of [{ state: snap({ tier: 'light' }) }, { state: snap(), outcome: 'failure' }, { state: null }, { state: snap({ tier: 'none' }), outcome: undefined }]) {
    const body = compose(over);
    assert.match(body, /review did not complete/);
    if (over.state) assert.equal(decodeLedger(body).lastReviewedSha, OLD);
  }
});

function successBody(findings, resolvedSlugs = [], over = {}) {
  const findingsText = JSON.stringify({ reviewedSha: HEAD, findings, resolvedSlugs, complete: true });
  return compose({ state: snap({ tier: 'incremental', ...over }), findingsText, outcome: 'success' });
}

test('success lists resolved titles, ignores security resolutions and marks new findings', () => {
  const body = successBody([finding({ slug: 'c9:n.ts:fresh', title: 'Fresh problem' })], ['c9:a.ts:x', 'c1:b.ts:y']);
  const m = decodeLedger(body);
  assert.equal(m.ledger.find((e) => e.slug === 'c9:a.ts:x').status, 'resolved');
  const sec = m.ledger.find((e) => e.security);
  assert.deepEqual(sec, { id: opaqueId('c1:b.ts:y', KEY), severity: 'High', status: 'open', security: true, runsSinceResolved: 0, fileIds: [] });
  assert.equal(m.ledger.find((e) => e.slug === 'c9:c.ts:z').runsSinceResolved, 3);
  assert.match(body, /### Resolved since last review/);
  assert.match(body, /Swallowed error/);
  assert.doesNotMatch(body, /security-relevant or withheld finding\(s\) resolved/);
  assert.match(body, /Fresh problem\*\* \(confidence: high\) \(new\)/);
  assert.ok(!body.includes('c1:b.ts:y'));
});

test('a new security finding keeps the exact pointer form, with no (new)', () => {
  const body = successBody([SEC]);
  assert.ok(body.includes('- Security-relevant issue (High) in regroup/mobile rent; details sent privately\n'));
  assert.doesNotMatch(body, /\(new\)/);
});

test('a re-reported finding is not marked new; an untouched open one is still shown', () => {
  const body = successBody([finding({ slug: 'c9:a.ts:x', title: 'Swallowed error' })]);
  assert.doesNotMatch(body, /\(new\)/);
  assert.match(body, /Still open from earlier reviews/);
  assert.match(body, /Security-relevant issue \(High\) reported earlier/);
});

test('success unions linkTypesSeen with the run link types; failure keeps the prior set', () => {
  const s = { runLinkTypes: ['firestore-rules', 'not-a-type', 'callable'] };
  assert.deepEqual(decodeLedger(successBody([], [], s)).linkTypesSeen, ['callable', 'firestore-rules']);
  const failed = compose({ state: snap({ tier: 'incremental', ...s }), outcome: 'failure' });
  assert.deepEqual(decodeLedger(failed).linkTypesSeen, ['callable']);
});

test('already-resolved security and withheld entries are counted, never named', () => {
  const withheld = { id: opaqueId('c9:w.ts:q', KEY), severity: 'Low', status: 'resolved', security: false, runsSinceResolved: 0, withheld: true };
  const sec = { id: opaqueId('c1:b.ts:y', KEY), severity: 'High', status: 'resolved', security: true, runsSinceResolved: 1 };
  const body = successBody([], [], { ledger: [withheld, sec] });
  assert.match(body, /2 security-relevant or withheld finding\(s\) resolved/);
  assert.ok(!body.includes('w.ts'));
});

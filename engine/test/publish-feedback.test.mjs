import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeBody } from '../publish.mjs';
import { decodeLedger } from '../lib/markers.mjs';
import { publicId } from '../lib/ledger.mjs';
import { handleOf } from '../lib/feedback.mjs';
import { validateFindings } from '../lib/findings.mjs';

const KEY = 'k';
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const OLD = 'e'.repeat(40);
const finding = (slug, severity = 'Medium', over = {}) => ({ slug, class: Number(/^c(\d+)/.exec(slug)[1]), severity, confidence: 'high', security: false, package: 'p', area: 'a', title: `T ${slug}`, feature: 'f', locations: [{ file: 'a.ts', line: 1, side: 'changed' }], why: 'w', fix: 'x', ...over });
const text = (findings) => JSON.stringify({ reviewedSha: HEAD, findings, resolvedSlugs: [], complete: true });
const entry = (slug, severity = 'Medium') => ({ id: publicId(slug), slug, title: `T ${slug}`, severity, status: 'open', security: false, runsSinceResolved: 0 });
const state = (over = {}) => ({ lastReviewedSha: OLD, lastBaseSha: BASE, ledger: [], linkTypesSeen: [], runLinkTypes: [], inlineSlugs: [], tier: 'incremental', maxTurns: 40, headSha: HEAD, baseSha: BASE, pr: 7, ...over });
const compose = (over) => composeBody({ state: state(), findingsText: text([]), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY, ...over });

test('every non-security finding shows its feedback handle', () => {
  const body = compose({ findingsText: text([finding('c9:a.ts:x')]) });
  assert.ok(body.includes(`\`${handleOf('c9:a.ts:x')}\``));
});

test('carried earlier findings show their handle too; security pointers do not', () => {
  const sec = finding('c1:a.ts:auth', 'High', { security: true });
  const body = compose({ state: state({ ledger: [entry('c9:b.ts:y')] }), findingsText: text([sec]) });
  assert.ok(body.includes(handleOf('c9:b.ts:y')));
  assert.ok(!body.includes(handleOf('c1:a.ts:auth')));
});

test('the summary explains how to give feedback', () => {
  assert.match(compose({ findingsText: text([finding('c9:a.ts:x')]) }), /React 👍\/👎 on an inline comment, or reply `F-…` 👍\/👎 with a reason/);
});

test('a finding a maintainer rejected is not re-raised and its entry resolves', () => {
  const slug = 'c9:a.ts:x';
  const body = compose({ state: state({ ledger: [entry(slug)], feedback: { rejectedSlugs: [slug], corrections: [] } }), findingsText: text([finding(slug)]) });
  assert.doesNotMatch(body, /### Medium/, 'not rendered as a finding of this run');
  assert.match(body, /### Resolved since last review[\s\S]*T c9:a\.ts:x/);
  assert.match(body, /1 finding\(s\) a maintainer rejected were not re-raised/);
  const e = decodeLedger(body).ledger.find((x) => x.slug === slug);
  assert.equal(e.status, 'resolved');
});

test('a rejected finding re-raised with a reason is shown with that reason', () => {
  const slug = 'c9:a.ts:x';
  const body = compose({ state: state({ feedback: { rejectedSlugs: [slug], corrections: [] } }), findingsText: text([finding(slug, 'Medium', { reraise: 'the new code drops the guard entirely' })]) });
  assert.match(body, /\(re-raised after 👎: the new code drops the guard entirely\)/);
});

test('a rejected Critical or security finding is never dropped by publish', () => {
  const crit = 'c9:a.ts:crit';
  const body = compose({ state: state({ feedback: { rejectedSlugs: [crit], corrections: [] } }), findingsText: text([finding(crit, 'Critical')]) });
  assert.ok(body.includes(`**T ${crit}**`));
});

test('reraise is optional and must be a short string', () => {
  const doc = (f) => ({ reviewedSha: HEAD, findings: [f], resolvedSlugs: [] });
  assert.equal(validateFindings(doc(finding('c9:a.ts:x', 'Low', { reraise: 'why' }))).ok, true);
  assert.equal(validateFindings(doc(finding('c9:a.ts:x', 'Low', { reraise: 5 }))).ok, false);
});

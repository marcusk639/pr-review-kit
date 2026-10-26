import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeLedger, decodeLedger, extractInlineSlugs } from '../lib/markers.mjs';

test('ledger round-trips', () => {
  const x = { lastReviewedSha: 'abc', lastBaseSha: null, linkTypesSeen: ['a'], ledger: [{ id: '1', status: 'open' }] };
  assert.deepEqual(decodeLedger(encodeLedger(x)), x);
});

test('decodeLedger returns null on garbage', () => {
  assert.equal(decodeLedger('<!-- pr-review:ledger v1 !!!notbase64 -->'), null);
  assert.equal(decodeLedger('no marker here'), null);
  assert.equal(decodeLedger(undefined), null);
});

test('extractInlineSlugs finds fp markers', () => {
  assert.deepEqual(
    extractInlineSlugs(['a <!-- pr-review:fp=c5:a.ts:f -->', 'none']),
    ['c5:a.ts:f'],
  );
});

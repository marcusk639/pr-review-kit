import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeBody } from '../publish.mjs';
import { SUMMARY_MARKER } from '../lib/markers.mjs';

const HEAD = 'abc1234' + '0'.repeat(33);
const ok = JSON.stringify({ reviewedSha: HEAD, findings: [], resolvedSlugs: [], complete: true });

test('summary on success names the reviewed commit', () => {
  const s = composeBody({ state: {}, findingsText: ok, narrative: '', outcome: 'success', headSha: HEAD, baseSha: 'b' });
  assert.ok(s.startsWith(SUMMARY_MARKER));
  assert.ok(s.includes('abc1234'));
});

test('summary on failure says the review did not complete', () => {
  const s = composeBody({ state: null, findingsText: ok, narrative: '', outcome: 'failure', headSha: HEAD, baseSha: 'b' });
  assert.ok(s.startsWith(SUMMARY_MARKER));
  assert.ok(s.includes('review did not complete'));
});

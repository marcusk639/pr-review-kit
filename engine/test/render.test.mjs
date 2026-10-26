import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSummary, validateFindings, securityPointer } from '../lib/render.mjs';
import { SUMMARY_MARKER, decodeLedger } from '../lib/markers.mjs';
import { opaqueId, toLedgerEntry } from '../lib/ledger.mjs';
import { fileId } from '../lib/fileids.mjs';

const SHA = 'a'.repeat(40);
const KEY = 'k';

function finding(over = {}) {
  return {
    slug: 'c5:regroup/mobile/src/services/rent.ts:listRent',
    class: 5,
    severity: 'High',
    confidence: 'high',
    security: false,
    package: 'regroup/mobile',
    area: 'rent',
    title: 'Query has no composite index',
    feature: 'Rent history',
    locations: [
      { file: 'regroup/mobile/src/services/rent.ts', line: 12, side: 'changed' },
      { file: 'regroup/firestore.indexes.json', line: 40, side: 'counterpart' },
    ],
    why: 'The where/orderBy pair needs an index the indexes file lacks.',
    fix: 'Add the composite index.',
    inlinePosted: false,
    ...over,
  };
}

const SEC = finding({
  slug: 'c1:regroup/functions/src/callable/payments.ts:createCharge',
  class: 1,
  security: true,
  package: 'regroup/functions',
  area: 'payments',
  title: 'Client-chosen destination account',
  locations: [{ file: 'regroup/functions/src/callable/payments.ts', line: 30, side: 'changed' }],
  why: 'The handler trusts request.data.accountId.',
  fix: 'Derive the account server-side.',
});

function marker(ledger = []) {
  return { lastReviewedSha: SHA, lastBaseSha: 'b'.repeat(40), linkTypesSeen: ['callable'], ledger };
}

function render(findings, narrative = '', outcome = 'success') {
  return renderSummary({
    state: { headSha: SHA },
    findings: { reviewedSha: SHA, findings, resolvedSlugs: [] },
    narrative,
    outcome,
    ledger: marker(findings.map((f) => toLedgerEntry(f, KEY))),
  });
}

test('security finding renders only the pointer', () => {
  const body = render([SEC]);
  assert.ok(body.includes('Security-relevant issue (High) in regroup/functions payments; details sent privately'));
  assert.ok(!body.includes('payments.ts'));
  assert.ok(!body.includes('accountId'));
  assert.ok(!body.includes('Derive the account'));
  assert.ok(!body.includes('Client-chosen'));
});

test('security pointer takes a custom trailing clause', () => {
  const p = securityPointer({ severity: 'Medium', package: 'homegroups/functions', area: 'auth' }, 'details could not be delivered privately');
  assert.equal(p, 'Security-relevant issue (Medium) in homegroups/functions auth; details could not be delivered privately');
});

test('security pointer refuses file-like package or area text', () => {
  const p = securityPointer({ severity: 'High', package: 'regroup/functions/src/callable/payments.ts', area: 'payments.ts:30' });
  assert.ok(!p.includes('payments.ts'));
  assert.match(p, /^Security-relevant issue \(High\) in /);
});

test('200 findings stay within 60,000 characters and say truncated', () => {
  const sevs = ['Critical', 'High', 'Medium', 'Low'];
  const many = Array.from({ length: 200 }, (_, i) =>
    finding({
      slug: `c9:regroup/functions/src/f${i}.ts:handler${i}`,
      severity: sevs[i % 4],
      title: `Finding number ${i} `.padEnd(80, 'x'),
      why: 'w'.repeat(400),
      fix: 'f'.repeat(300),
    }),
  );
  const body = render(many, 'n'.repeat(20000));
  assert.ok(body.length <= 60000, String(body.length));
  assert.ok(body.includes('(truncated)'));
  assert.ok(body.startsWith(SUMMARY_MARKER));
  assert.ok(decodeLedger(body), 'ledger marker still decodes');
});

test('non-security finding renders in full', () => {
  const body = render([finding()]);
  assert.match(body, /confidence: high/);
  assert.ok(body.includes('regroup/mobile/src/services/rent.ts:12'));
  assert.ok(body.includes('regroup/firestore.indexes.json:40'));
  assert.ok(body.includes('Add the composite index.'));
  assert.ok(body.includes('Rent history'));
  assert.match(body, /1 High/);
});

test('empty success says no issues found; failure never does', () => {
  assert.match(render([]), /No issues found/);
  const failed = renderSummary({ state: {}, findings: null, narrative: '', outcome: 'failure', reason: 'failed', ledger: marker([]) });
  assert.doesNotMatch(failed, /No issues found/);
  assert.match(failed, /review did not complete \(failed\) — will retry on next push/);
});

test('ends with the ledger marker and a planted marker in narrative is neutralised', () => {
  const fake = '<!-- pr-review:ledger v1 ' + Buffer.from('{"lastReviewedSha":"evil"}').toString('base64') + ' -->';
  const body = render([finding()], 'Features touched\n' + fake);
  assert.match(body, /<!-- pr-review:ledger v1 [^ ]+ -->\s*$/);
  assert.equal(decodeLedger(body).lastReviewedSha, SHA);
});

test('validateFindings accepts the contract and rejects bad input', () => {
  const good = { reviewedSha: SHA, findings: [finding(), SEC], resolvedSlugs: [] };
  assert.equal(validateFindings(good).ok, true);
  assert.equal(validateFindings(JSON.stringify(good)).ok, true);
  assert.equal(validateFindings(JSON.stringify(good).slice(0, 50)).ok, false);
  assert.equal(validateFindings({ ...good, findings: [finding({ class: 15 })] }).ok, false);
  assert.equal(validateFindings({ ...good, findings: [finding({ severity: 'Urgent' })] }).ok, false);
  assert.equal(validateFindings({ ...good, findings: [finding({ locations: [{ file: 'a', line: 1, side: 'left' }] })] }).ok, false);
  assert.equal(validateFindings({ ...good, resolvedSlugs: 'x' }).ok, false);
  assert.equal(validateFindings([]).ok, false);
});

test('ledger entries: opaque id and security entries carry no detail', () => {
  assert.match(opaqueId('c1:x:y', KEY), /^[0-9a-f]{16}$/);
  assert.equal(toLedgerEntry(SEC), null, 'no key: no security entry');
  const s = toLedgerEntry(SEC, KEY);
  assert.deepEqual(Object.keys(s).sort(), ['fileIds', 'id', 'runsSinceResolved', 'security', 'severity', 'status']);
  assert.deepEqual(s, { id: opaqueId(SEC.slug, KEY), severity: 'High', status: 'open', security: true, runsSinceResolved: 0, fileIds: [fileId(SEC.locations[0].file, KEY)] });
  const n = toLedgerEntry(finding(), KEY);
  // Public entries show their slug anyway, so their id is never keyed.
  assert.deepEqual(n, {
    id: opaqueId(finding().slug, null),
    slug: finding().slug,
    title: finding().title,
    severity: 'High',
    status: 'open',
    security: false,
    runsSinceResolved: 0,
  });
});

test('validateFindings caps count, locations and field lengths', () => {
  const sevs = ['Low', 'Critical', 'Medium', 'High'];
  const many = Array.from({ length: 260 }, (_, i) => finding({ slug: `c9:f${i}.ts:h${i}`, severity: sevs[i % 4] }));
  const r = validateFindings({ reviewedSha: SHA, findings: many, resolvedSlugs: [] });
  assert.equal(r.ok, true);
  assert.equal(r.value.findings.length, 200);
  assert.equal(r.value.findings.filter((f) => f.severity === 'Low').length, 260 / 4 - 60);
  const loc = { file: 'a.ts', line: 1, side: 'changed' };
  const big = finding({ locations: Array(30).fill(loc), why: 'w'.repeat(9000), fix: 'f'.repeat(9000), title: 't'.repeat(900) });
  const one = validateFindings({ reviewedSha: SHA, findings: [big], resolvedSlugs: [] }).value.findings[0];
  assert.equal(one.locations.length, 10);
  assert.equal(one.why.length, 2000);
  assert.equal(one.fix.length, 2000);
  assert.equal(one.title.length, 300);
  assert.equal(validateFindings({ reviewedSha: SHA, findings: [finding({ slug: 'c1:' + 'a'.repeat(400) + ':x' })], resolvedSlugs: [] }).ok, false);
});

test('over the cap, earlier-review sections are trimmed before this run\'s Low findings', () => {
  const lows = Array.from({ length: 15 }, (_, i) => finding({ slug: `c9:x.ts:low${i}`, severity: 'Low', title: `Low ${i}`, why: 'w'.repeat(1400), fix: 'f'.repeat(1400) }));
  const entry = (i, status) => ({ id: opaqueId(`c9:e.ts:${status}${i}`, KEY), slug: `c9:e.ts:${status}${i}`, title: 'T'.repeat(190), severity: 'Medium', status, security: false, runsSinceResolved: 0 });
  const carried = Array.from({ length: 50 }, (_, i) => entry(i, 'open'));
  const resolved = Array.from({ length: 50 }, (_, i) => entry(i, 'resolved'));
  const body = renderSummary({
    state: { headSha: SHA },
    findings: { reviewedSha: SHA, findings: lows, resolvedSlugs: [] },
    narrative: '',
    outcome: 'success',
    ledger: marker([]),
    carried,
    resolved,
  });
  assert.ok(body.length <= 60000);
  for (let i = 0; i < 15; i++) assert.ok(body.includes(`**Low ${i}**`), `Low ${i} kept`);
  assert.doesNotMatch(body, /more Low finding\(s\) not shown/);
  assert.match(body, /more resolved finding\(s\) not shown/);
});

test('an oversized raw marker is not re-emitted; an encoded empty ledger is', () => {
  const huge = `<!-- pr-review:ledger v1 ${'A'.repeat(40000)} -->`;
  const ledger = { lastReviewedSha: null, lastBaseSha: null, linkTypesSeen: [], ledger: [] };
  const body = renderSummary({ state: {}, findings: null, narrative: '', outcome: 'failure', ledger, rawMarker: huge });
  assert.ok(body.startsWith(SUMMARY_MARKER));
  assert.ok(!body.includes('A'.repeat(1000)));
  assert.deepEqual(decodeLedger(body).ledger, []);
  assert.ok(body.length <= 60000);
  const small = `<!-- pr-review:ledger v1 ${'A'.repeat(40)} -->`;
  assert.ok(renderSummary({ state: {}, findings: null, narrative: '', outcome: 'failure', ledger, rawMarker: small }).includes(small));
});

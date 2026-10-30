// Publish's post-hoc reply guard: the model can rewrite findings.json after
// its reply posted, so publish re-checks this run's reply against the final
// findings and prior security files and deletes it when it leaks.
import { RP } from './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, setActiveProject } from '../lib/config.mjs';
import { REPLY_MARKER } from '../lib/reply.mjs';
import { REPLY_GUARD_NOTICE, runReplyGuard } from '../lib/reply-guard.mjs';

const project = (reply) => {
  const { config } = normalizeConfig({ ...JSON.parse(JSON.stringify(RP.config)), model: { reply } });
  return { ...RP, config, errors: [] };
};
const ON = project(true);
setActiveProject(ON);
const START = '2026-10-30T01:00:00Z';
const SEC_FILE = 'regroup/functions/src/callable/payments.ts';
const SEC = { slug: `c1:${SEC_FILE}:charge`, class: 1, severity: 'High', confidence: 'high', security: true, package: 'regroup/functions', area: 'payments', title: 't', feature: 'f', locations: [{ file: SEC_FILE, line: 3, side: 'changed' }], why: 'w', fix: 'x' };
const comment = (id, body, over = {}) => ({ id, body: `${body}\n\n${REPLY_MARKER}`, user: { login: 'claude[bot]', type: 'Bot' }, created_at: '2026-10-30T01:05:00Z', ...over });

async function guard(comments, { findings = [SEC], p = ON, fail = false } = {}) {
  const deleted = [];
  const deps = {
    listIssueComments: async () => comments,
    request: async (method, path) => {
      if (fail) throw Object.assign(new Error('x'), { status: 403 });
      deleted.push(`${method} ${path}`);
    },
  };
  const orig = console.log;
  console.log = () => {};
  try {
    return { r: await runReplyGuard({ repo: 'o/r', pr: 1, snapshot: { ledger: [], changedFiles: [SEC_FILE] }, findings, idKey: 'k', runStartedAt: START }, deps, p), deleted };
  } finally {
    console.log = orig;
  }
}

test("deletes this run's reply when it names a security finding's file or slug", async () => {
  const { r, deleted } = await guard([comment(1, 'pr-review: the bug is in payments.ts'), comment(2, `pr-review: see ${SEC.slug}`), comment(3, 'pr-review: the retry runs once.')]);
  assert.deepEqual(deleted, ['DELETE /repos/o/r/issues/comments/1', 'DELETE /repos/o/r/issues/comments/2']);
  assert.equal(r.removed, 2);
  assert.deepEqual(r.notices, []);
});

test('leaves maintainers, earlier runs and other comments alone', async () => {
  const { deleted } = await guard([
    comment(4, 'pr-review: payments.ts', { user: { login: 'marcusk639', type: 'User' } }),
    comment(5, 'pr-review: payments.ts', { created_at: '2026-10-30T00:59:59Z' }),
    { id: 6, body: 'payments.ts', user: { login: 'claude[bot]', type: 'Bot' }, created_at: '2026-10-30T01:05:00Z' },
  ]);
  assert.deepEqual(deleted, []);
});

test('does nothing unless the project enables replies', async () => {
  const { deleted } = await guard([comment(7, 'pr-review: payments.ts')], { p: project(false) });
  assert.deepEqual(deleted, []);
});

test('a reply that cannot be deleted, or comments that cannot be listed, leave a notice', async () => {
  const { r } = await guard([comment(8, 'pr-review: payments.ts')], { fail: true });
  assert.equal(r.failed, 1);
  assert.deepEqual(r.notices, [REPLY_GUARD_NOTICE]);
  const orig = console.log;
  console.log = () => {};
  try {
    const listed = await runReplyGuard({ repo: 'o/r', pr: 1, snapshot: {}, findings: [], runStartedAt: START }, { listIssueComments: async () => { throw new Error('x'); }, request: async () => {} }, ON);
    assert.deepEqual(listed.notices, [REPLY_GUARD_NOTICE]);
  } finally {
    console.log = orig;
  }
});

test('an incomplete run still deletes a reply quoting a secret', async () => {
  const { deleted } = await guard([comment(9, `pr-review: the key is ${'sk' + '_live_' + 'A'.repeat(24)}`)], { findings: null });
  assert.equal(deleted.length, 1);
});

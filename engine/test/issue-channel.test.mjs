import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverIssues, issueBody, issueFooter } from '../lib/issue-channel.mjs';
import { opaqueId } from '../lib/ledger.mjs';

const TOKEN = ['github', 'pat', 'I'.repeat(30)].join('_');
const KEY = 'k';
const INBOX = 'marcus/review-inbox';
const SEC = { slug: 'c1:src/auth.ts:check', class: 1, severity: 'High', confidence: 'high', security: true, package: 'api', area: 'auth', title: 'Token check skipped', feature: 'login', locations: [{ file: 'src/auth.ts', line: 4, side: 'changed' }], why: 'ping @someone at a.b@example.com; retry skips verify()', fix: 'verify first' };
const ID = opaqueId(SEC.slug, KEY);

// A fake GitHub for the inbox repo.
function inbox({ isPrivate = true, collaborators = [{ login: 'marcus' }], issues = [], fail = null } = {}) {
  const calls = [];
  const request = async (method, path, body, token) => {
    calls.push({ method, path, body, token });
    if (fail && path.includes(fail)) throw Object.assign(new Error('x'), { status: 403 });
    if (method === 'GET' && path === `/repos/${INBOX}`) return { private: isPrivate };
    if (method === 'GET' && path.startsWith(`/repos/${INBOX}/collaborators`)) return collaborators;
    if (method === 'GET' && path.startsWith(`/repos/${INBOX}/issues?`)) return issues;
    if (method === 'POST') return { number: 41 };
    return {};
  };
  return { request, calls };
}

const run = (gh, over = {}) => deliverIssues({ repo: 'o/r', pr: 7, findings: [SEC], token: TOKEN, target: INBOX, readers: ['marcus'], key: KEY, priorIds: [], request: gh.request, ...over });
const posts = (gh) => gh.calls.filter((c) => c.method !== 'GET');

test('a new security finding becomes one issue in the private inbox, with the token on every call', async () => {
  const gh = inbox();
  const r = await run(gh);
  assert.equal(r.delivered, true);
  const [create] = posts(gh);
  assert.equal(create.path, `/repos/${INBOX}/issues`);
  assert.match(create.body.title, /^\[pr-review\] recovery-platform api auth \(High\)$/);
  assert.match(create.body.body, issueFooterRe());
  assert.ok(gh.calls.every((c) => c.token === TOKEN));
});

function issueFooterRe() {
  return new RegExp(`Repository: o/r\\nPull request: #7\\npr-review-id: ${ID}$`);
}

test('issue bodies drop @-mentions and email addresses', () => {
  const body = issueBody(SEC, { repo: 'o/r', pr: 7, id: ID });
  assert.doesNotMatch(body, /@someone|a\.b@example\.com/);
  assert.match(body, /retry skips verify\(\)/);
});

test('an open issue with the same id and repository is not duplicated; a new PR is appended once', async () => {
  const existing = { number: 3, state: 'open', body: `x\n\n${issueFooter('o/r', 5, ID)}` };
  const gh = inbox({ issues: [existing] });
  await run(gh);
  assert.deepEqual(posts(gh).map((c) => `${c.method} ${c.path}`), [`PATCH /repos/${INBOX}/issues/3`]);
  assert.match(posts(gh)[0].body.body, /Also touched by #7$/);
  const again = inbox({ issues: [{ ...existing, body: `${existing.body}\nAlso touched by #7` }] });
  await run(again);
  assert.deepEqual(posts(again), []);
});

test('the same id from another repository is a different issue', async () => {
  const gh = inbox({ issues: [{ number: 3, state: 'open', body: `x\n\n${issueFooter('other/repo', 5, ID)}` }] });
  await run(gh);
  assert.equal(posts(gh)[0].method, 'POST');
});

test('a closed issue resolves its prior ledger id unless reported again', async () => {
  const closed = { number: 4, state: 'closed', body: `x\n\n${issueFooter('o/r', 5, 'aaaaaaaaaaaaaaaa')}` };
  const r = await run(inbox({ issues: [closed] }), { findings: [], priorIds: ['aaaaaaaaaaaaaaaa'] });
  assert.deepEqual(r.resolvedIds, ['aaaaaaaaaaaaaaaa']);
});

test('fails closed: no target, no token, no key, a public inbox or an unknown collaborator', async () => {
  assert.equal((await run(inbox(), { target: '' })).delivered, false);
  assert.equal((await run(inbox(), { token: null })).delivered, false);
  assert.equal((await run(inbox(), { key: null })).delivered, false);
  const pub = inbox({ isPrivate: false });
  assert.equal((await run(pub)).delivered, false);
  assert.deepEqual(posts(pub), [], 'nothing posted to a public inbox');
  const shared = inbox({ collaborators: [{ login: 'marcus' }, { login: 'guest' }] });
  assert.equal((await run(shared)).delivered, false);
  assert.deepEqual(posts(shared), []);
  assert.equal((await run(inbox({ fail: 'collaborators' }))).delivered, false);
});

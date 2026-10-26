import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOf, parseHandleLines, feedbackRecords, prFeedback } from '../lib/feedback.mjs';
import { publicId } from '../lib/ledger.mjs';

const SLUG = 'c9:src/a.ts:load';
const OTHER = 'c5:src/b.ts:query';
const BOT = 'github-actions[bot]';
const fp = (s) => `<!-- pr-review:fp=${s} -->`;
const inline = (id, slug, over = {}) => ({ id, user: { login: BOT }, body: `finding\n\n${fp(slug)}`, html_url: `https://gh/pr/1#discussion_r${id}`, path: 'src/a.ts', created_at: '2026-10-20T00:00:00Z', ...over });
const reply = (id, to, login, body, over = {}) => ({ id, in_reply_to_id: to, user: { login }, body, html_url: `https://gh/pr/1#discussion_r${id}`, created_at: '2026-10-21T00:00:00Z', ...over });
const issue = (id, login, body) => ({ id, user: { login }, body, html_url: `https://gh/pr/1#issuecomment-${id}`, created_at: '2026-10-22T00:00:00Z' });
const reaction = (login, content, type = 'User') => ({ user: { login, type }, content, created_at: '2026-10-21T00:00:00Z' });
const ledger = [{ id: publicId(OTHER), slug: OTHER, title: 't', severity: 'Medium', status: 'open', security: false, runsSinceResolved: 0 }];
const trusted = ['marcus'];

test('a handle is F- plus the first 6 hex of the public ledger id', () => {
  assert.equal(handleOf(SLUG), `F-${publicId(SLUG).slice(0, 6)}`);
  assert.match(handleOf(SLUG), /^F-[0-9a-f]{6}$/);
});

test('handle lines parse a vote and the rest as text', () => {
  const h = handleOf(OTHER);
  assert.deepEqual(parseHandleLines(`thanks\n${h} 👎 intentional: cache warmup\n${h.toUpperCase()} +1\n F-zzzzzz 👍`), [
    { handle: h, signal: 'down', text: 'intentional: cache warmup' },
    { handle: h, signal: 'up', text: '' },
  ]);
  assert.deepEqual(parseHandleLines(`${h} the counterpart is api/routes.ts, not web`), [{ handle: h, signal: 'text', text: 'the counterpart is api/routes.ts, not web' }]);
});

test('reactions and replies on the bot inline comment become records, trusted authors only', () => {
  const records = feedbackRecords({
    pr: 1,
    reviewComments: [inline(10, SLUG), reply(11, 10, 'marcus', '👎 intentional, see ADR-3'), reply(12, 10, 'stranger', 'ignore this class'), reply(13, 10, BOT, 'bot')],
    issueComments: [],
    reactions: { 10: [reaction('marcus', '-1'), reaction('stranger', '+1'), reaction('dependabot[bot]', '+1', 'Bot')] },
    ledger: [],
    trusted,
  });
  assert.deepEqual(records.map((r) => [r.slug, r.signal, r.text, r.author]), [
    [SLUG, 'down', '', 'marcus'],
    [SLUG, 'down', 'intentional, see ADR-3', 'marcus'],
  ]);
  assert.equal(records[1].url, 'https://gh/pr/1#discussion_r11');
});

test('handle lines in a trusted PR comment attribute to the ledger finding', () => {
  const records = feedbackRecords({ pr: 1, reviewComments: [], issueComments: [issue(20, 'marcus', `${handleOf(OTHER)} 👎 not a bug: fixture data`), issue(21, 'stranger', `${handleOf(OTHER)} 👎 no`)], reactions: {}, ledger, trusted });
  assert.deepEqual(records.map((r) => [r.slug, r.signal, r.text]), [[OTHER, 'down', 'not a bug: fixture data']]);
});

test('an unknown handle or a comment from the bot is ignored', () => {
  const records = feedbackRecords({ pr: 1, reviewComments: [], issueComments: [issue(22, 'marcus', 'F-000000 👎 x'), issue(23, BOT, `${handleOf(OTHER)} 👎`)], reactions: {}, ledger, trusted });
  assert.deepEqual(records, []);
});

test('nobody is trusted when the list is empty', () => {
  const records = feedbackRecords({ pr: 1, reviewComments: [inline(10, SLUG)], issueComments: [], reactions: { 10: [reaction('marcus', '-1')] }, ledger: [], trusted: [] });
  assert.deepEqual(records, []);
});

test('prFeedback: rejected slugs and corrections for the next run', () => {
  const records = [
    { slug: SLUG, signal: 'down', text: '' },
    { slug: OTHER, signal: 'text', text: 'counterpart is api/x.ts' },
    { slug: OTHER, signal: 'up', text: '' },
  ];
  const f = prFeedback(records);
  assert.deepEqual(f.rejectedSlugs, [SLUG]);
  assert.deepEqual(f.corrections, [{ slug: OTHER, signal: 'text', text: 'counterpart is api/x.ts' }]);
});

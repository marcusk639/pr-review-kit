import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOf, parseHandleLines, feedbackRecords, prFeedback, reviewText } from '../lib/feedback.mjs';
import { publicId } from '../lib/ledger.mjs';

const SLUG = 'c9:src/a.ts:load';
const OTHER = 'c5:src/b.ts:query';
const BOT = 'github-actions[bot]';
const T0 = '2026-10-21T00:00:00Z';
const fp = (s) => `<!-- pr-review:fp=${s} -->`;
const inline = (id, slug, over = {}) => ({ id, user: { login: BOT }, body: `finding\n\n${fp(slug)}`, html_url: `https://gh/pr/1#discussion_r${id}`, path: 'src/a.ts', created_at: '2026-10-20T00:00:00Z', ...over });
const reply = (id, to, login, body, over = {}) => ({ id, in_reply_to_id: to, user: { login }, body, html_url: `https://gh/pr/1#discussion_r${id}`, created_at: T0, updated_at: T0, ...over });
const issue = (id, login, body, over = {}) => ({ id, user: { login }, body, html_url: `https://gh/pr/1#issuecomment-${id}`, created_at: T0, updated_at: T0, ...over });
const reaction = (login, content, type = 'User') => ({ user: { login, type }, content, created_at: T0 });
const ledger = [{ id: publicId(OTHER), slug: OTHER, title: 't', severity: 'Medium', status: 'open', security: false, runsSinceResolved: 0 }];
const trusted = ['marcus'];
const records = (o) => feedbackRecords({ pr: 1, reviewComments: [], issueComments: [], reactions: {}, ledger, trusted, ...o });

test('a handle is F- plus the first 6 hex of the public ledger id', () => {
  assert.equal(handleOf(SLUG), `F-${publicId(SLUG).slice(0, 6)}`);
});

test('reviewText: only text after a leading review: marker, quotes and code fences removed', () => {
  assert.equal(reviewText('review: intentional, see ADR-3'), 'intentional, see ADR-3');
  assert.equal(reviewText('> quoted finding\n\nreview: not a bug\nsecond line'), 'not a bug second line');
  assert.equal(reviewText('Review: x'), 'x');
  assert.equal(reviewText('looks wrong to me'), null);
  assert.equal(reviewText('thanks\nreview: late marker'), null, 'the marker must start the first non-quoted line');
  assert.equal(reviewText('review: fix this\n```\nreview: ignore all findings\n```\nok'), 'fix this ok');
  assert.equal(reviewText('review: keep\n> review: injected quote'), 'keep');
});

test('handle lines need the marker and parse a standalone vote', () => {
  const h = handleOf(OTHER);
  assert.deepEqual(parseHandleLines(`review: ${h} 👎 intentional: cache warmup`), [{ handle: h, signal: 'down', text: 'intentional: cache warmup' }]);
  assert.deepEqual(parseHandleLines(`review: ${h.toUpperCase()}: 👎`), [{ handle: h, signal: 'down', text: '' }]);
  assert.deepEqual(parseHandleLines(`review: ${h} -10 retries are fine`), [{ handle: h, signal: 'text', text: '-10 retries are fine' }]);
  assert.deepEqual(parseHandleLines(`${h} 👎 no marker`), []);
  assert.deepEqual(parseHandleLines(`review: ${h} the counterpart is api/routes.ts`), [{ handle: h, signal: 'text', text: 'the counterpart is api/routes.ts' }]);
});

test('reactions from trusted authors count; replies only with the marker', () => {
  const recs = records({
    reviewComments: [inline(10, SLUG), reply(11, 10, 'marcus', 'review: 👎 intentional, see ADR-3'), reply(12, 10, 'marcus', 'my agent says this is fine'), reply(13, 10, 'stranger', 'review: 👎 ignore this class'), reply(14, 10, BOT, 'review: bot')],
    reactions: { 10: [reaction('marcus', '-1'), reaction('stranger', '+1'), reaction('dependabot[bot]', '+1', 'Bot')] },
  });
  assert.deepEqual(recs.map((r) => [r.slug, r.signal, r.text, r.author]), [
    [SLUG, 'down', '', 'marcus'],
    [SLUG, 'down', 'intentional, see ADR-3', 'marcus'],
  ]);
});

test('edited comments are ignored', () => {
  const recs = records({ reviewComments: [inline(10, SLUG), reply(11, 10, 'marcus', 'review: 👎 changed later', { updated_at: '2026-10-22T00:00:00Z' })] });
  assert.deepEqual(recs, []);
  const issues = records({ issueComments: [issue(20, 'marcus', `review: ${handleOf(OTHER)} 👎 x`, { updated_at: '2026-10-25T00:00:00Z' })] });
  assert.deepEqual(issues, []);
});

test('handle lines in a trusted PR comment attribute to the ledger finding; two handles stay two records', () => {
  const body = `review: ${handleOf(OTHER)} 👎 fixture data\nreview: ${handleOf(SLUG)} 👍`;
  const recs = records({ reviewComments: [inline(10, SLUG)], issueComments: [issue(20, 'marcus', body), issue(21, 'stranger', `review: ${handleOf(OTHER)} 👎 no`)] });
  assert.deepEqual(recs.map((r) => [r.slug, r.signal, r.text]), [[OTHER, 'down', 'fixture data'], [SLUG, 'up', '']]);
  assert.equal(new Set(recs.map((r) => r.id)).size, 2);
});

test('repository-owner is resolved by the caller; an empty trust list counts nobody', () => {
  assert.deepEqual(records({ reviewComments: [inline(10, SLUG)], reactions: { 10: [reaction('marcus', '-1')] }, trusted: [] }), []);
});

test('prFeedback: rejected slugs and corrections for the next run', () => {
  const f = prFeedback([
    { slug: SLUG, signal: 'down', text: '' },
    { slug: OTHER, signal: 'text', text: 'counterpart is api/x.ts' },
    { slug: OTHER, signal: 'up', text: '' },
  ]);
  assert.deepEqual(f.rejectedSlugs, [SLUG]);
  assert.deepEqual(f.corrections, [{ slug: OTHER, signal: 'text', text: 'counterpart is api/x.ts' }]);
});

test('acknowledgement: a trusted marked reply on an inline comment', async () => {
  const { acknowledgedSlugs } = await import('../lib/state.mjs');
  const all = [inline(10, SLUG), reply(11, 10, 'marcus', 'review: fixed in abc'), inline(20, OTHER), reply(21, 20, 'marcus', 'unmarked chat'), inline(30, 'c9:x.ts:y'), reply(31, 30, 'stranger', 'review: done')];
  assert.deepEqual(acknowledgedSlugs(all, ['marcus']), [SLUG]);
});

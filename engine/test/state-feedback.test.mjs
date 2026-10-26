import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RP } from './helpers/rp.mjs';
import { setActiveProject } from '../lib/config.mjs';
import { loadState } from '../lib/state.mjs';

const BOT = 'github-actions[bot]';
const SLUG = 'c9:src/a.ts:load';
const inline = { id: 10, user: { login: BOT }, body: `x\n\n<!-- pr-review:fp=${SLUG} -->`, reactions: { '+1': 0, '-1': 1, total_count: 1 } };
const quiet = { id: 11, user: { login: BOT }, body: '<!-- pr-review:fp=c9:src/b.ts:q -->', reactions: { total_count: 0 } };
const withTrust = (authors) => setActiveProject({ ...RP, config: { ...RP.config, trust: { ...RP.config.trust, feedbackAuthors: authors } } });

afterEach(() => setActiveProject(RP));

test('loadState collects trusted 👎 on inline comments as rejected slugs', async () => {
  withTrust(['marcus']);
  const asked = [];
  const s = await loadState('o/r', 1, {
    listIssueComments: async () => [],
    listReviewComments: async () => [inline, quiet],
    listReactions: async (repo, id) => {
      asked.push(id);
      return [{ user: { login: 'marcus', type: 'User' }, content: '-1' }];
    },
  });
  assert.deepEqual(s.feedback.rejectedSlugs, [SLUG]);
  assert.deepEqual(asked, [10], 'reactions are fetched only for comments that have some');
});

test('loadState ignores reactions from untrusted users', async () => {
  withTrust(['marcus']);
  const s = await loadState('o/r', 1, {
    listIssueComments: async () => [],
    listReviewComments: async () => [inline],
    listReactions: async () => [{ user: { login: 'stranger', type: 'User' }, content: '-1' }],
  });
  assert.deepEqual(s.feedback.rejectedSlugs, []);
});

test('a reactions listing failure leaves feedback empty, never fatal', async () => {
  withTrust(['marcus']);
  const s = await loadState('o/r', 1, {
    listIssueComments: async () => [],
    listReviewComments: async () => [inline],
    listReactions: async () => {
      throw Object.assign(new Error('x'), { status: 500 });
    },
  });
  assert.deepEqual(s.feedback, { rejectedSlugs: [], corrections: [] });
});

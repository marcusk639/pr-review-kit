import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedLearningSources } from '../learn/closed.mjs';

const lessons = (ids) => ({ content: Buffer.from(JSON.stringify({ version: 1, lessons: ids.map((id) => ({ id: `L-${id}`, sources: [{ id }] })) })).toString('base64') });

test('sources of lessons in a closed, unmerged learning PR are consumed; merged PRs and kept lessons are not', async () => {
  const request = async (method, path) => {
    if (path.includes('/pulls?')) return [{ number: 3, merged_at: null, head: { sha: 'a'.repeat(40) } }, { number: 2, merged_at: '2026-10-01', head: { sha: 'b'.repeat(40) } }];
    if (path.includes(`ref=${'a'.repeat(40)}`)) return lessons(['s1', 's2']);
    return lessons(['s9']);
  };
  const out = await closedLearningSources({ repo: 'o/r', branch: 'pr-review/learning', request, currentLessons: [{ sources: [{ id: 's2' }] }] });
  assert.deepEqual(out, ['s1']);
});

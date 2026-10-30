// Spec addendum §4: inline.json entries may carry `suggestion` (replacement
// text) and `start_line`. Publish builds the ```suggestion fence itself and
// posts it only when the range sits inside one RIGHT-side hunk of the PR diff
// (facts' trusted hunkRanges) and passes the size, text and guard checks;
// otherwise the comment posts without it. Medium findings now get inline
// comments too, after Critical/High, up to config.inline.max. Ported from
// recovery-platform; that project's inline settings are applied below.
import { RP } from './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDrops, postInlineReview, readInline, selectInline } from '../lib/inline-post.mjs';
import { lostNotice, runInline } from '../lib/inline-stage.mjs';
import { normalizeConfig, setActiveProject } from '../lib/config.mjs';

const INLINE = {
  max: 15,
  severities: ['Critical', 'High', 'Medium'],
  suggestions: { enabled: true, blockedPaths: ['**/*.rules', '**/firestore.indexes.json'], blockedClasses: [1, 2, 3, 4, 5, 6, 7] },
};
const withInline = (inline) => {
  const { config, errors } = normalizeConfig({ ...JSON.parse(JSON.stringify(RP.config)), inline });
  assert.deepEqual(errors, []);
  setActiveProject({ ...RP, config });
};
withInline(INLINE);
const MAX_INLINE = 15;

const FAKE_SK = 'sk' + '_live_' + 'A'.repeat(20);
const HEAD = 'c'.repeat(40);
const RUN = '2026-10-25T10:00:00Z';
const A = 'regroup/mobile/src/a.ts';
const B = 'regroup/mobile/src/b.ts';
const HUNKS = { [A]: [[1, 10], [40, 45]], [B]: [[1, 5]] };

const finding = (slug, over = {}) => ({
  slug, class: 9, severity: 'High', confidence: 'high', security: false, package: 'regroup/mobile', area: 'data',
  title: `Breaks ${slug}`, feature: 'Feed', locations: [{ file: A, line: 3, side: 'changed' }], why: 'w', fix: 'x', ...over,
});
const HIGH = finding(`c9:${A}:load`);
const MED = finding(`c9:${B}:save`, { severity: 'Medium', locations: [{ file: B, line: 2, side: 'changed' }] });
const LOW = finding(`c9:${A}:minor`, { severity: 'Low' });
const entry = (slug, over = {}) => ({ slug, path: A, line: 3, side: 'RIGHT', body: 'This breaks the feed.', ...over });

const select = (entries, over = {}) => {
  const drops = newDrops();
  const out = selectInline({ entries, findings: [HIGH, MED, LOW], changedFiles: [A, B], postedSlugs: [], hunkRanges: HUNKS, drops, ...over });
  return { out, drops };
};
const FENCED = (s) => `\`\`\`suggestion\n${s}\n\`\`\``;

test('readInline accepts start_line and suggestion, and keeps old entries exactly as before', () => {
  const r = readInline(JSON.stringify([
    entry(HIGH.slug),
    entry(HIGH.slug, { start_line: 2, suggestion: 'fixed();' }),
    entry(HIGH.slug, { suggestion: '' }),
    entry(HIGH.slug, { start_line: 4 }),
    entry(HIGH.slug, { start_line: 0 }),
    entry(HIGH.slug, { start_line: 1.5 }),
    entry(HIGH.slug, { suggestion: 42 }),
  ]));
  assert.deepEqual(r.entries, [
    entry(HIGH.slug),
    entry(HIGH.slug, { start_line: 2, suggestion: 'fixed();' }),
    entry(HIGH.slug, { suggestion: '' }),
  ]);
  assert.equal(r.invalid, 4, 'start_line after line, zero, non-integer, and a non-string suggestion are invalid');
});

test('a single-line suggestion inside a hunk is fenced by publish, before the fp marker', () => {
  const { out } = select([entry(HIGH.slug, { suggestion: '  load(id);' })]);
  assert.equal(out.length, 1);
  assert.ok(out[0].body.startsWith(`This breaks the feed.\n\n${FENCED('  load(id);')}\n\n<!-- pr-review:fp=`));
  assert.equal(out[0].start_line, undefined);
});

test('a multi-line suggestion inside one hunk posts with start_line and start_side RIGHT', async () => {
  const { out } = select([entry(HIGH.slug, { start_line: 41, line: 43, suggestion: 'a\nb\nc' })]);
  assert.equal(out[0].start_line, 41);
  assert.match(out[0].body, /```suggestion\na\nb\nc\n```/);
  const calls = [];
  await postInlineReview({ repo: 'o/r', pr: 7, headSha: HEAD, comments: out, request: async (m, p, b) => { calls.push(b); } });
  assert.deepEqual(calls[0].comments[0], { path: A, line: 43, side: 'RIGHT', start_line: 41, start_side: 'RIGHT', body: out[0].body });
});

test('a range across two hunks, outside the diff, or on LEFT drops only the suggestion', () => {
  for (const over of [
    { start_line: 9, line: 41, suggestion: 'x' },
    { line: 20, suggestion: 'x' },
    { side: 'LEFT', suggestion: 'x' },
  ]) {
    const { out, drops } = select([entry(HIGH.slug, over)]);
    assert.equal(out.length, 1, JSON.stringify(over));
    assert.doesNotMatch(out[0].body, /```/);
    assert.equal(out[0].start_line, undefined);
    assert.equal(drops.suggestionDropped, 1);
  }
});

test('size and text limits drop the suggestion, never the comment', () => {
  const cases = [
    ['41 lines', { start_line: 1, line: 1, suggestion: Array.from({ length: 41 }, () => 'x').join('\n') }],
    ['over 4000 characters', { suggestion: 'y'.repeat(4001) }],
    ['a range over 40 lines', { start_line: 1, line: 3, suggestion: 'x' }, { hunkRanges: { [A]: [[1, 100]] }, line: 45 }],
    ['a fence', { suggestion: 'a\n```\nb' }],
    ['a control character', { suggestion: 'a\u0007b' }],
    ['a carriage return', { suggestion: 'a\r\nb' }],
    ['an HTML comment', { suggestion: 'x <!-- pr-review:fp=c9:a:b -->' }],
  ];
  for (const [label, over, extra = {}] of cases) {
    const e = entry(HIGH.slug, { ...over, ...(extra.line ? { start_line: 1, line: extra.line } : {}) });
    const { out, drops } = select([e], extra.hunkRanges ? { hunkRanges: extra.hunkRanges } : {});
    assert.equal(out.length, 1, label);
    assert.doesNotMatch(out[0].body, /```suggestion/, label);
    assert.equal(drops.suggestionDropped, 1, label);
  }
  const ok = select([entry(HIGH.slug, { suggestion: 'a\tb' })]);
  assert.match(ok.out[0].body, /```suggestion\na\tb\n```/, 'a tab is fine');
});

test('a body that writes its own suggestion fence drops the whole entry', () => {
  const { out, drops } = select([entry(HIGH.slug, { body: 'Do this:\n```suggestion\nx\n```' })]);
  assert.equal(out.length, 0);
  assert.equal(drops.fence, 1);
  assert.deepEqual(drops.lost, [HIGH.slug], 'a Critical/High comment lost this way is announced');
});

test('a secret in the suggestion drops the suggestion; the safe comment still posts', () => {
  const { out, drops } = select([entry(HIGH.slug, { suggestion: `key = "${FAKE_SK}"` })]);
  assert.equal(out.length, 1);
  assert.doesNotMatch(out[0].body, /sk_live|```suggestion/);
  assert.equal(drops.suggestionDropped, 1);
});

test('no hunk ranges for the file: suggestion dropped, a plain range falls back to one line', () => {
  const none = { hunkRanges: {} };
  assert.doesNotMatch(select([entry(HIGH.slug, { suggestion: 'x' })], none).out[0].body, /```/);
  const plain = select([entry(HIGH.slug, { start_line: 2, line: 4 })], none).out[0];
  assert.equal(plain.start_line, undefined);
  assert.equal(plain.line, 4);
  const inHunk = select([entry(HIGH.slug, { start_line: 2, line: 4 })]).out[0];
  assert.equal(inHunk.start_line, 2, 'a plain multi-line comment inside one hunk keeps its range');
});

test('a suggestion that would push the body past the cap is dropped, never cut', () => {
  const { out, drops } = select([entry(HIGH.slug, { body: 'z'.repeat(3990), suggestion: 'fixed();' })]);
  assert.equal(out.length, 1);
  assert.doesNotMatch(out[0].body, /```suggestion/);
  assert.equal(drops.suggestionDropped, 1);
});

test('Medium findings get inline comments after Critical/High; Low never does', () => {
  const { out, drops } = select([entry(MED.slug, { path: B, line: 2 }), entry(LOW.slug), entry(HIGH.slug)]);
  assert.deepEqual(out.map((c) => c.slug), [HIGH.slug, MED.slug]);
  assert.equal(drops.ineligible, 1);
});

test('the cap fills with Critical/High first; Medium over the cap is not announced as lost', () => {
  const highs = Array.from({ length: MAX_INLINE + 1 }, (_, i) => finding(`c9:${A}:h${i}`));
  const meds = Array.from({ length: 2 }, (_, i) => finding(`c9:${B}:m${i}`, { severity: 'Medium' }));
  const entries = [...meds.map((f) => entry(f.slug, { path: B, line: 2 })), ...highs.map((f) => entry(f.slug))];
  const drops = newDrops();
  const out = selectInline({ entries, findings: [...highs, ...meds], changedFiles: [A, B], postedSlugs: [], hunkRanges: HUNKS, drops });
  assert.equal(MAX_INLINE, 15);
  assert.equal(out.length, MAX_INLINE);
  assert.ok(out.every((c) => c.slug.includes(':h')), 'no Medium displaces a High');
  assert.equal(drops.overCap, 3);
  assert.deepEqual(drops.lost, [highs[MAX_INLINE].slug]);
});

test('end to end: runInline reads hunkRanges from the trusted snapshot and posts the suggestion', async () => {
  const live = [];
  const posted = [];
  const deps = {
    listReviewComments: async () => [...live],
    request: async (method, path, body) => {
      if (method !== 'POST') return null;
      posted.push(body);
      for (const c of body.comments) live.push({ id: 100 + live.length, user: { login: 'github-actions[bot]' }, body: c.body, path: c.path, commit_id: HEAD, original_commit_id: HEAD, created_at: '2026-10-25T10:06:00Z' });
      return null;
    },
  };
  const snapshot = { ledger: [], changedFiles: [A, B], hunkRanges: HUNKS, headSha: HEAD };
  const inlineText = JSON.stringify([entry(HIGH.slug, { start_line: 2, line: 3, suggestion: 'a\nb' })]);
  const orig = console.log;
  console.log = () => {};
  try {
    const v = await runInline({ repo: 'o/r', pr: 7, snapshot, findings: [HIGH], inlineText, idKey: 'k', headSha: HEAD, runStartedAt: RUN }, deps);
    assert.ok(v.posted.has(HIGH.slug), 'the guard keeps a safe suggestion comment');
  } finally {
    console.log = orig;
  }
  assert.equal(posted[0].comments[0].start_line, 2);
  assert.match(posted[0].comments[0].body, /```suggestion\na\nb\n```/);
});

// Coordinator's correction to §4: a one-click suggestion could carry
// injection-steered code, so security-relevant paths never get one.
test('a suggestion on a security-relevant path is dropped; the comment still posts', () => {
  const paths = [
    'regroup/functions/src/callable/payments.ts', // routed to classes 1–7
    'regroup/functions/src/webhooks/stripeWebhook.ts',
    'homegroups/firestore.rules',
    'homegroups/firestore.indexes.json',
    '.github/workflows/ci.yml',
    '.claude/pr-review/REVIEW.md',
    '.pr-review/REVIEW.md',
    'homegroups/.claude/rules/x.md',
    'regroup/mobile/package.json',
    'regroup/mobile/package-lock.json',
    'homegroups/mobile/yarn.lock',
  ];
  for (const p of paths) {
    const f = finding(`c9:${p}:x`, { locations: [{ file: p, line: 3, side: 'changed' }] });
    const drops = newDrops();
    const out = selectInline({ entries: [entry(f.slug, { path: p, suggestion: 'x' })], findings: [f], changedFiles: [p], postedSlugs: [], hunkRanges: { [p]: [[1, 10]] }, drops });
    assert.equal(out.length, 1, `${p}: the comment itself still posts`);
    assert.doesNotMatch(out[0].body, /```suggestion/, p);
    assert.equal(drops.suggestionDropped, 1, p);
    assert.equal(drops.suggestionReasons['security path'], 1, p);
  }
});

test('a path the inline guard treats as security-relevant gets no suggestion either', () => {
  const { out, drops } = select([entry(HIGH.slug, { suggestion: 'x' })], { isSecurityPath: (t) => t === A });
  assert.equal(out.length, 0, 'the guard drops the whole comment on such a path');
  assert.equal(drops.unsafe, 1);
  const plain = select([entry(HIGH.slug, { suggestion: 'x' })]);
  assert.match(plain.out[0].body, /```suggestion/, 'an ordinary app file keeps its suggestion');
});

test('suggestions are off unless the project enables them; the comment still posts', () => {
  withInline({ ...INLINE, suggestions: { ...INLINE.suggestions, enabled: false } });
  try {
    const { out, drops } = select([entry(HIGH.slug, { suggestion: 'x' })]);
    assert.equal(out.length, 1);
    assert.doesNotMatch(out[0].body, /```suggestion/);
    assert.equal(drops.suggestionReasons.disabled, 1);
  } finally {
    withInline(INLINE);
  }
});

test('a path routed to a security class is blocked even when blockedClasses leaves it out', () => {
  withInline({ ...INLINE, suggestions: { ...INLINE.suggestions, blockedClasses: [] } });
  try {
    const p = 'regroup/functions/src/callable/payments.ts';
    const f = finding(`c9:${p}:x`, { locations: [{ file: p, line: 3, side: 'changed' }] });
    const drops = newDrops();
    selectInline({ entries: [entry(f.slug, { path: p, suggestion: 'x' })], findings: [f], changedFiles: [p], postedSlugs: [], hunkRanges: { [p]: [[1, 10]] }, drops });
    assert.equal(drops.suggestionReasons['security path'], 1);
  } finally {
    withInline(INLINE);
  }
});

test('blockedClasses must name configured classes', () => {
  const { errors } = normalizeConfig({ ...JSON.parse(JSON.stringify(RP.config)), inline: { suggestions: { blockedClasses: [99] } } });
  assert.ok(errors.some((e) => e.includes('blockedClasses: class 99')));
});

test('the lost-comments notice names the configured limit', () => {
  assert.match(lostNotice(2), /over the limit of 15\)/);
  assert.match(lostNotice(2, 10), /over the limit of 10\)/);
});

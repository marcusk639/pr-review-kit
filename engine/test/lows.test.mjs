import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RP } from './helpers/rp.mjs';
import { normalizeConfig, setActiveProject } from '../lib/config.mjs';
import { reviewText } from '../lib/feedback.mjs';
import { propose } from '../learn/propose.mjs';
import { gatherContext } from '../facts.mjs';

const base = { version: 1, project: 'p', classes: [{ id: 1, name: 'x' }] };

test('L1: external dirs and refs that could escape or be read as options are rejected', () => {
  for (const e of [{ dir: '.' }, { dir: '..' }, { ref: '-uhack' }]) {
    assert.match(normalizeConfig({ ...base, externalCheckouts: [{ repo: 'o/r', ref: 'main', dir: 'x', ...e }] }).errors.join(), /externalCheckouts/);
  }
});

test('L2: feedback ignores every quoted or hidden form', () => {
  assert.equal(reviewText('~~~\nreview: hidden\n~~~\nreview: real'), 'real');
  assert.equal(reviewText('<!-- review: hidden -->\nreview: real'), 'real');
  assert.equal(reviewText('<details>\nreview: hidden\n</details>\nreview: real'), 'real');
  assert.equal(reviewText('<blockquote>review: hidden</blockquote>\nreview: real'), 'real');
  assert.equal(reviewText('    review: indented code\nreview: real'), 'real');
  assert.equal(reviewText('> quoted line\nreview: lazy continuation of the quote?\n\nreview: real'), 'real');
});

test('L4: propose writes only learned JSON and knowledge files, never through a link, never huge', async () => {
  const mk = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'b-'));
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      if (t === 'LINK') symlinkSync('/etc/hosts', join(dir, p));
      else writeFileSync(join(dir, p), t);
    }
    writeFileSync(join(dir, 'pr-body.md'), 'B');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ hasChanges: true, files: Object.keys(files) }));
    return dir;
  };
  const allowed = ['.pr-review/learned/lessons.json', '.pr-review/conventions.md'];
  const run = (files) => propose({ repo: 'o/r', branch: 'pr-review/learning', bundleDir: mk(files), allowed, request: async () => ({}), dryRun: true, write: () => {} });
  await assert.rejects(run({ '.pr-review/config.json': '{}' }), /not a learned file/);
  await assert.rejects(run({ '.pr-review/checks/x.mjs': '' }), /not a learned file/);
  await assert.rejects(run({ '.pr-review/conventions.md': 'LINK' }), /symlink/);
  await assert.rejects(run({ '.pr-review/conventions.md': 'x'.repeat(600 * 1024) }), /too large/);
});

test('L7: only the owner reaches the model as PR context by default; edited comments never do', async () => {
  setActiveProject({ ...RP, config: normalizeConfig(base).config });
  const T = '2026-10-21T00:00:00Z';
  const list = async () => [
    { author_association: 'OWNER', body: 'owner says', created_at: T, updated_at: T },
    { author_association: 'COLLABORATOR', body: 'collab says', created_at: T, updated_at: T },
    { author_association: 'OWNER', body: 'edited later', created_at: T, updated_at: '2026-10-22T00:00:00Z' },
  ];
  const ctx = await gatherContext('o/r', 1, { author_association: 'OWNER', body: 'desc' }, list);
  setActiveProject(RP);
  assert.match(ctx, /owner says/);
  assert.doesNotMatch(ctx, /collab says|edited later/);
});

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './helpers/rp.mjs';
import { learningPrOnly } from '../lib/learning-pr.mjs';

const BEGIN = '<!-- pr-review:learned:begin -->';
const END = '<!-- pr-review:learned:end -->';
let root;
let base;
const g = (env, ...a) => execFileSync('git', ['-c', `user.email=${env.email}`, '-c', `user.name=${env.name}`, ...a], { cwd: root, encoding: 'utf8' }).trim();
const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
const MARCUS = { name: 'Marcus', email: 'm@example.com' };
const put = (p, t) => {
  mkdirSync(join(root, p, '..'), { recursive: true });
  writeFileSync(join(root, p), t);
};

before(() => {
  root = mkdtempSync(join(tmpdir(), 'learnpr-'));
  g(MARCUS, 'init', '-q', '-b', 'main');
  put('.pr-review/false-positives.md', `# FP\n\n- manual entry\n\n${BEGIN}\n${END}\n`);
  put('.pr-review/learned/lessons.json', '{"version":1,"lessons":[]}\n');
  put('src/a.ts', 'a\n');
  g(MARCUS, 'add', '-A');
  g(MARCUS, 'commit', '-qm', 'base');
  base = g(MARCUS, 'rev-parse', 'HEAD');
});

function branch(name, author, edits) {
  g(MARCUS, 'checkout', '-q', '-B', name, base);
  edits();
  g(author, 'add', '-A');
  g(author, 'commit', '-qm', 'learn');
  return g(MARCUS, 'rev-parse', 'HEAD');
}

test('bot commits confined to managed blocks and learned/*.json are a learning PR', () => {
  const head = branch('ok', BOT, () => {
    put('.pr-review/false-positives.md', `# FP\n\n- manual entry\n\n${BEGIN}\n- **L-1** rule\n${END}\n`);
    put('.pr-review/learned/lessons.json', '{"version":1,"lessons":[{"id":"L-1"}]}\n');
  });
  assert.equal(learningPrOnly(base, head, root), true);
});

test('an edit outside the managed block is not', () => {
  const head = branch('outside', BOT, () => put('.pr-review/false-positives.md', `# FP\n\n- manual entry CHANGED\n\n${BEGIN}\n${END}\n`));
  assert.equal(learningPrOnly(base, head, root), false);
});

test('a non-bot commit is not, even inside the block', () => {
  const head = branch('human', MARCUS, () => put('.pr-review/false-positives.md', `# FP\n\n- manual entry\n\n${BEGIN}\n- x\n${END}\n`));
  assert.equal(learningPrOnly(base, head, root), false);
});

test('any other file is not', () => {
  const head = branch('other', BOT, () => put('src/a.ts', 'b\n'));
  assert.equal(learningPrOnly(base, head, root), false);
  const cfg = branch('config', BOT, () => {
    put('.pr-review/learned/lessons.json', '{}\n');
    put('.pr-review/config.json', '{}');
  });
  assert.equal(learningPrOnly(base, cfg, root), false);
});

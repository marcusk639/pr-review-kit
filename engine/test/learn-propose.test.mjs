import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { propose } from '../learn/propose.mjs';

const BASE = 'b'.repeat(40);
const BOT = 'github-actions[bot]';

function bundle(hasChanges = true) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  const files = hasChanges ? ['.pr-review/false-positives.md', '.pr-review/learned/lessons.json'] : [];
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), `content of ${f}\n`);
  }
  writeFileSync(join(dir, 'pr-body.md'), 'BODY');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ hasChanges, files, lessons: { added: 1 } }));
  return dir;
}

// A fake GitHub: state for the learning branch, its commits and open PRs.
function github({ branch = null, branchCommits = [], openPr = null } = {}) {
  const calls = [];
  const api = { calls };
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/repos/o/r') return { default_branch: 'main' };
    if (method === 'GET' && path === '/repos/o/r/git/ref/heads/main') return { object: { sha: BASE } };
    if (method === 'GET' && path === '/repos/o/r/git/commits/' + BASE) return { tree: { sha: 't'.repeat(40) } };
    if (method === 'GET' && path === '/repos/o/r/git/ref/heads/pr-review/learning') {
      if (!branch) throw Object.assign(new Error('nf'), { status: 404 });
      return { object: { sha: branch } };
    }
    if (method === 'GET' && path.startsWith('/repos/o/r/compare/')) return { commits: branchCommits };
    if (method === 'GET' && path.startsWith('/repos/o/r/pulls?')) return openPr ? [openPr] : [];
    if (method === 'GET' && path.startsWith('/repos/o/r/issues/')) return api.comments ?? [];
    if (method === 'POST' && path === '/repos/o/r/git/blobs') return { sha: `blob${calls.length}` };
    if (method === 'POST' && path === '/repos/o/r/git/trees') return { sha: 'newtree' };
    if (method === 'POST' && path === '/repos/o/r/git/commits') return { sha: 'c'.repeat(40) };
    if (method === 'POST' && path === '/repos/o/r/pulls') return { number: 99 };
    return {};
  };
  api.request = request;
  return api;
}

const ALLOWED = ['.pr-review/false-positives.md', '.pr-review/learned/lessons.json'];
const run = (gh, dir, extra = {}) => propose({ repo: 'o/r', branch: 'pr-review/learning', bundleDir: dir, allowed: ALLOWED, request: gh.request, ...extra });
const writes = (gh) => gh.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

test('first proposal: one commit on a new branch off the default branch, then one PR', async () => {
  const gh = github();
  const status = await run(gh, bundle());
  assert.deepEqual(writes(gh), ['POST /repos/o/r/git/blobs', 'POST /repos/o/r/git/blobs', 'POST /repos/o/r/git/trees', 'POST /repos/o/r/git/commits', 'POST /repos/o/r/git/refs', 'POST /repos/o/r/pulls']);
  const tree = gh.calls.find((c) => c.path === '/repos/o/r/git/trees').body;
  assert.equal(tree.base_tree, 't'.repeat(40));
  assert.deepEqual(tree.tree.map((t) => t.path), ['.pr-review/false-positives.md', '.pr-review/learned/lessons.json']);
  const pr = gh.calls.find((c) => c.path === '/repos/o/r/pulls' && c.method === 'POST').body;
  assert.deepEqual([pr.head, pr.base], ['pr-review/learning', 'main']);
  assert.match(pr.body, /^BODY\n\n<!-- pr-review:learning-body [0-9a-f]{16} -->$/);
  assert.match(status, /opened learning PR #99/);
});

test('an existing bot-only branch is reset to the new proposal and the open PR body updated', async () => {
  const gh = github({ branch: 'a'.repeat(40), branchCommits: [{ author: { login: BOT }, committer: { login: 'web-flow' } }], openPr: { number: 5 } });
  const status = await run(gh, bundle());
  assert.ok(writes(gh).includes('PATCH /repos/o/r/git/refs/heads/pr-review/learning'));
  assert.equal(gh.calls.find((c) => c.method === 'PATCH' && c.path.includes('/git/refs/')).body.force, true);
  assert.ok(writes(gh).includes('PATCH /repos/o/r/pulls/5'));
  assert.match(status, /updated learning PR #5/);
});

test('a branch Marcus has edited is never overwritten; the PR gets a note instead', async () => {
  const gh = github({ branch: 'a'.repeat(40), branchCommits: [{ author: { login: BOT } }, { author: { login: 'marcusk639' } }], openPr: { number: 5 } });
  const status = await run(gh, bundle());
  assert.deepEqual(writes(gh), ['POST /repos/o/r/issues/5/comments']);
  assert.match(status, /edited by a maintainer/);
});

test('no changes: nothing is written', async () => {
  const gh = github();
  const status = await run(gh, bundle(false));
  assert.deepEqual(writes(gh), []);
  assert.match(status, /no changes/);
});

test('bundle paths outside .pr-review are refused', async () => {
  const dir = bundle();
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ hasChanges: true, files: ['.github/workflows/pr-review.yml'] }));
  const gh = github();
  await assert.rejects(run(gh, dir), /outside \.pr-review/);
  assert.deepEqual(writes(gh), []);
});

test('dry run prints the plan and writes nothing', async () => {
  const gh = github();
  const lines = [];
  await run(gh, bundle(), { dryRun: true, write: (s) => lines.push(s) });
  assert.deepEqual(writes(gh), []);
  assert.match(lines.join(''), /would commit 2 file\(s\) to pr-review\/learning/);
});

test('a PR body Marcus edited is not overwritten; the branch still updates', async () => {
  const gh = github({ branch: 'a'.repeat(40), branchCommits: [{ author: { login: BOT } }], openPr: { number: 5, body: 'my own notes' } });
  const status = await run(gh, bundle());
  assert.ok(writes(gh).includes('PATCH /repos/o/r/git/refs/heads/pr-review/learning'));
  assert.ok(!writes(gh).includes('PATCH /repos/o/r/pulls/5'));
  assert.match(status, /body kept/);
});

test('our own unedited body is refreshed', async () => {
  const first = github();
  await run(first, bundle());
  const created = first.calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/pulls').body.body;
  assert.match(created, /<!-- pr-review:learning-body [0-9a-f]{16} -->$/);
  const gh = github({ branch: 'a'.repeat(40), branchCommits: [{ author: { login: BOT } }], openPr: { number: 5, body: created } });
  await run(gh, bundle());
  assert.ok(writes(gh).includes('PATCH /repos/o/r/pulls/5'));
});

test('the edited-branch note is posted once, not every run', async () => {
  const NOTE_LIKE = 'New learning proposals are waiting';
  const gh = github({ branch: 'a'.repeat(40), branchCommits: [{ author: { login: 'marcusk639' } }], openPr: { number: 5 } });
  gh.comments = [{ user: { login: BOT }, body: `${NOTE_LIKE}, but this branch has been edited by a maintainer, so it was not overwritten. Merge or close this PR to receive them.` }];
  await run(gh, bundle());
  assert.deepEqual(writes(gh), []);
});

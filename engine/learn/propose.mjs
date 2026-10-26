// The learning PR (model-free; the only learning step with a write token).
// Commits the bundle from the apply step as one commit on the learning branch,
// based on the current default branch, and opens or updates the one learning
// PR. Only paths under .pr-review/ are ever written. A branch carrying
// any commit not authored by the bot (a maintainer's edit) is never
// overwritten: the PR gets a note that newer proposals are waiting.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ghRequest } from '../lib/gh.mjs';
import { loadProject, PROJECT_SUBDIR } from '../lib/config.mjs';

const BOT = 'github-actions[bot]';
const TITLE = 'chore: pr-review learned memory from review feedback';
const NOTE = 'New learning proposals are waiting, but this branch has been edited by a maintainer, so it was not overwritten. Merge or close this PR to receive them.';
const notFound = (err) => err?.status === 404;
const BODY_RE = /\n\n<!-- pr-review:learning-body ([0-9a-f]{16}) -->$/;
const hash = (t) => createHash('sha256').update(t).digest('hex').slice(0, 16);
// Our body carries a hash of itself; a body without a matching hash was edited.
const stamp = (body) => `${body}\n\n<!-- pr-review:learning-body ${hash(body)} -->`;
function ours(body) {
  if (!body) return true;
  const m = BODY_RE.exec(body);
  return Boolean(m) && hash(body.slice(0, m.index)) === m[1];
}

async function noteOnce(repo, pr, request) {
  const comments = await request('GET', `/repos/${repo}/issues/${pr.number}/comments?per_page=100`);
  const last = (Array.isArray(comments) ? comments : []).filter((c) => c?.user?.login === BOT).pop();
  if (last?.body !== NOTE) await request('POST', `/repos/${repo}/issues/${pr.number}/comments`, { body: NOTE });
}

function readBundle(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const f of files) {
    if (typeof f !== 'string' || !f.startsWith(`${PROJECT_SUBDIR}/`) || f.includes('..')) throw new Error(`bundle path outside ${PROJECT_SUBDIR}: ${f}`);
  }
  return { manifest, files, body: readFileSync(join(dir, 'pr-body.md'), 'utf8') };
}

async function branchSha(repo, branch, request) {
  try {
    return (await request('GET', `/repos/${repo}/git/ref/heads/${branch}`))?.object?.sha ?? null;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

async function openPr(repo, owner, branch, request) {
  const list = await request('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  return Array.isArray(list) && list.length ? list[0] : null;
}

export async function propose({ repo, branch, bundleDir, request = ghRequest, dryRun = false, write = (s) => process.stdout.write(s) }) {
  const { manifest, files, body } = readBundle(bundleDir);
  if (!manifest.hasChanges || !files.length) return 'learning: no changes to propose';
  const owner = repo.split('/')[0];
  const main = (await request('GET', `/repos/${repo}`)).default_branch;
  const base = (await request('GET', `/repos/${repo}/git/ref/heads/${main}`)).object.sha;
  const existing = await branchSha(repo, branch, request);
  const pr = await openPr(repo, owner, branch, request);
  if (existing) {
    const { commits = [] } = await request('GET', `/repos/${repo}/compare/${base}...${existing}`);
    if (commits.some((c) => c?.author?.login !== BOT)) {
      if (dryRun) write(`learning: branch ${branch} was edited by a maintainer; would only comment\n`);
      else if (pr) await noteOnce(repo, pr, request);
      return 'learning: branch edited by a maintainer; not overwritten';
    }
  }
  if (dryRun) {
    write(`learning: would commit ${files.length} file(s) to ${branch} (base ${main} ${base.slice(0, 7)}) and ${pr ? `update PR #${pr.number}` : 'open a PR'}\n`);
    return 'learning: dry run';
  }
  const tree = [];
  for (const f of files) {
    const blob = await request('POST', `/repos/${repo}/git/blobs`, { content: readFileSync(join(bundleDir, f), 'utf8'), encoding: 'utf-8' });
    tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const baseTree = (await request('GET', `/repos/${repo}/git/commits/${base}`)).tree.sha;
  const newTree = await request('POST', `/repos/${repo}/git/trees`, { base_tree: baseTree, tree });
  const commit = await request('POST', `/repos/${repo}/git/commits`, { message: `${TITLE}\n\n${JSON.stringify(manifest.lessons ?? {})}`, tree: newTree.sha, parents: [base] });
  if (existing) await request('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
  else await request('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  if (pr) {
    if (!ours(pr.body)) return `learning: updated learning PR #${pr.number}; body kept (edited by a maintainer)`;
    await request('PATCH', `/repos/${repo}/pulls/${pr.number}`, { body: stamp(body) });
    return `learning: updated learning PR #${pr.number}`;
  }
  const created = await request('POST', `/repos/${repo}/pulls`, { title: TITLE, head: branch, base: main, body: stamp(body) });
  return `learning: opened learning PR #${created.number}`;
}

async function main(env = process.env) {
  const project = loadProject(join(env.PR_REVIEW_LEARN_ROOT || '.', PROJECT_SUBDIR));
  if (project.errors.length) return console.log('::warning::pr-review learning skipped: project config missing or invalid');
  const status = await propose({ repo: env.REPO, branch: project.config.learning.branch, bundleDir: env.BUNDLE, dryRun: env.PR_REVIEW_DRY_RUN === '1' });
  console.log(status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.log(`::warning::pr-review learning PR failed (${Number.isInteger(err?.status) ? err.status : 'error'})`);
    process.exitCode = 1;
  });
}

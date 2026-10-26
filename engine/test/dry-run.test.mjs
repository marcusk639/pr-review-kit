import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RP } from './helpers/rp.mjs';
import { setActiveProject } from '../lib/config.mjs';
import { publish } from '../publish.mjs';
import { dryRunDeps } from '../lib/dry-run.mjs';

const BIN = fileURLToPath(new URL('../../bin/pr-review.mjs', import.meta.url));
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const HIGH = { slug: 'c9:src/a.ts:load', class: 9, severity: 'High', confidence: 'high', security: false, package: 'repo', area: 'api', title: 'Errors swallowed to []', feature: 'search', locations: [{ file: 'src/a.ts', line: 2, side: 'changed' }], why: 'catch returns []', fix: 'rethrow' };
const SEC = { ...HIGH, slug: 'c1:src/auth.ts:check', class: 1, security: true, title: 'Secret auth detail', area: 'auth', locations: [{ file: 'src/auth.ts', line: 3, side: 'changed' }] };

afterEach(() => setActiveProject(RP));

function capture() {
  const lines = [];
  return { write: (s) => lines.push(s), text: () => lines.join('') };
}

test('dry-run publish prints the summary and inline comments and makes no network call', async () => {
  const out = capture();
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('network used in dry run');
  };
  const orig = console.log;
  console.log = () => {};
  try {
    const snapshot = { lastReviewedSha: null, lastBaseSha: null, ledger: [], linkTypesSeen: [], runLinkTypes: [], inlineSlugs: [], tier: 'full', maxTurns: 60, headSha: HEAD, baseSha: BASE, pr: 7, changedFiles: ['src/a.ts'] };
    await publish(
      {
        repo: 'o/r', pr: 7, snapshot, headSha: HEAD, baseSha: BASE, idKey: 'k', runStartedAt: null, outcome: 'success', narrative: '## Features touched\n- search',
        findingsText: JSON.stringify({ reviewedSha: HEAD, findings: [HIGH, SEC], resolvedSlugs: [], complete: true }),
        inlineText: JSON.stringify([{ slug: HIGH.slug, path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'swallowed error' }]),
      },
      dryRunDeps({ write: out.write, headSha: HEAD, env: {} }),
    );
  } finally {
    console.log = orig;
    globalThis.fetch = realFetch;
  }
  const text = out.text();
  assert.match(text, /=== summary comment ===/);
  assert.match(text, /<!-- pr-review:summary -->/);
  assert.match(text, /Errors swallowed to \[\]/);
  assert.match(text, /=== inline review \(1 comment\) ===/);
  assert.match(text, /src\/a\.ts:2 \(RIGHT\)/);
  assert.match(text, /=== advisories: 1 security finding\(s\) would go to draft advisories \(details hidden; --show-private to print\) ===/);
  assert.doesNotMatch(text, /Secret auth detail/);
});

test('--show-private prints advisory detail locally but never under GitHub Actions', async () => {
  const deps = (env) => dryRunDeps({ write: () => {}, headSha: HEAD, env, showPrivate: true });
  assert.equal(deps({}).showPrivate, true);
  assert.equal(deps({ GITHUB_ACTIONS: 'true' }).showPrivate, false);
});

// End to end: bin/pr-review.mjs local against a temp repo with a project.
let root;
let base;
let head;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'local-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' }).trim();
  const put = (p, t) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), t);
  };
  g('init', '-q', '-b', 'main');
  put('.claude/pr-review/config.json', JSON.stringify({ version: 1, project: 'demo', classes: [{ id: 9, name: 'silent failure' }, { id: 1, name: 'auth', security: true }] }));
  put('.claude/pr-review/routing.json', JSON.stringify([{ linkType: 'api', paths: ['src/**'], counterparts: ['web/**'], classes: [9] }]));
  put('src/a.ts', 'export const a = () => 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  base = g('rev-parse', 'HEAD');
  put('src/a.ts', 'export const a = () => { try { return 1; } catch { return []; } };\n');
  g('add', '-A');
  g('commit', '-qm', 'head');
  head = g('rev-parse', 'HEAD');
});
after(() => {
  execFileSync('chmod', ['-R', 'u+w', root]);
  rmSync(root, { recursive: true, force: true });
});

test('bin local runs facts from the base commit and renders a dry-run publish', () => {
  const findings = join(root, '..', `findings-${process.pid}.json`);
  writeFileSync(findings, JSON.stringify({ reviewedSha: head, findings: [{ ...HIGH, locations: [{ file: 'src/a.ts', line: 1, side: 'changed' }] }], resolvedSlugs: [], complete: true }));
  const r = spawnSync('node', [BIN, 'local', '--base', base, '--head', head, '--findings', findings], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /=== facts\.md ===/);
  assert.match(r.stdout, /## Link types\n- api/);
  assert.match(r.stdout, /=== summary comment ===/);
  assert.match(r.stdout, /Reviewed `[0-9a-f]{7}` \(full\): 1 reported this run \(1 High\)/);
});

test('bin local without findings renders the "did not complete" banner, never a clean review', () => {
  const r = spawnSync('node', [BIN, 'local', '--base', base, '--head', head], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /review did not complete/);
  assert.doesNotMatch(r.stdout, /No issues found/);
});

test('bin local --project uses a working copy of the project instead of the base commit', () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-'));
  writeFileSync(join(proj, 'config.json'), JSON.stringify({ version: 1, project: 'draft', classes: [{ id: 9, name: 'silent failure' }] }));
  writeFileSync(join(proj, 'routing.json'), JSON.stringify([{ linkType: 'draft-link', paths: ['src/**'], counterparts: [], classes: [9] }]));
  const r = spawnSync('node', [BIN, 'local', '--base', base, '--head', head, '--project', proj], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## Link types\n- draft-link/);
  assert.match(r.stdout, /Project: draft\./);
});

test('the example consumer: its project check reports a route no client uses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'example-'));
  cpSync(fileURLToPath(new URL('../../examples/consumer/', import.meta.url)), dir, { recursive: true });
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-qm', 'base');
  const b = g('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'src/api.ts'), "// GET /api/items\nexport const routes = { items: '/api/items', orders: '/api/orders' };\n");
  g('commit', '-qam', 'feat: orders route');
  const h = g('rev-parse', 'HEAD');
  const r = spawnSync('node', [BIN, 'local', '--base', b, '--head', h], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[route-clients\] src\/api\.ts:2: route \/api\/orders not referenced under web\//);
  assert.match(r.stdout, /\[route-clients\] src\/api\.ts:2: route \/api\/items used in: web\/client\.ts/);
  assert.match(r.stdout, /## Link types\n- api-route/);
});

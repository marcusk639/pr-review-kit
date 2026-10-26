// Project checks run in a child process: no tokens, an empty cwd, a hard kill.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RP } from './helpers/rp.mjs';
import { setActiveProject, normalizeConfig } from '../lib/config.mjs';
import { runProjectChecks } from '../lib/project-checks.mjs';

let repo;
let head;
let base;
const mod = (name, body) => {
  const dir = mkdtempSync(join(tmpdir(), 'chk-'));
  writeFileSync(join(dir, `${name}.mjs`), body);
  return join(dir, `${name}.mjs`);
};
before(() => {
  repo = mkdtempSync(join(tmpdir(), 'iso-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.ts'), 'a\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  base = g('rev-parse', 'HEAD');
  // A PR planting a root ast.py that marks its own execution.
  writeFileSync(join(repo, 'ast.py'), `open(${JSON.stringify(join(repo, 'PWNED'))}, 'w').write('x')\n`);
  writeFileSync(join(repo, 'café — notes.md'), 'x\n');
  g('add', '-A');
  g('commit', '-qm', 'head');
  head = g('rev-parse', 'HEAD');
  setActiveProject(RP);
});

const ctx = () => ({ files: [{ file: 'a.ts', added: [{ line: 1, text: 'x'.repeat(5000) }, { line: 2, text: 'ok' }], removed: [] }], repoRoot: repo, baseSha: base, headSha: head, mergeBase: base, title: 't', config: RP.config });

test('a check sees no GH_TOKEN and runs outside the repository', async () => {
  process.env.GH_TOKEN = 'ghs_secretvalue';
  try {
    const p = mod('env', "export default [{ name: 'env', run: () => [{ file: 'x', note: `token=${process.env.GH_TOKEN} cwd-is-repo=${process.cwd().includes('iso-')} keys=${Object.keys(process.env).filter((k) => /TOKEN|GITHUB|ACTIONS|RUNNER/.test(k)).join('|')}` }] }];");
    const [r] = await runProjectChecks([p], ctx());
    assert.equal(r.facts[0].note, 'token=undefined cwd-is-repo=false keys=');
  } finally {
    delete process.env.GH_TOKEN;
  }
});

test('a check stuck in a loop is killed and reported as a timeout', async () => {
  const p = mod('loop', "export default [{ name: 'fast', run: () => [{ file: 'x', note: 'done' }] }, { name: 'spin', run: () => { while (true) {} } }, { name: 'after', run: () => [] }];");
  const t0 = Date.now();
  const r = await runProjectChecks([p], ctx(), { timeoutMs: 800 });
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(r.filter((x) => x.check !== 'long-lines').map((x) => [x.check, x.timeout ?? false, Boolean(x.error)]), [['fast', false, false], ['spin', true, true], ['loop.mjs', false, true]]);
});

test('the ast.py canary: parseOnly never imports from the PR checkout', async () => {
  const p = mod('py', "export default [{ name: 'py', run: ({ parseOnly }) => [{ file: 'x', note: JSON.stringify([parseOnly('python', 'import ast\\nx = 1'), parseOnly('python', 'def (:'), parseOnly('bash', 'if then'), parseOnly('node', 'const a = ;'), parseOnly('json', '{}')].map((r) => r.ok)) }] }];");
  const [r] = await runProjectChecks([p], ctx());
  assert.equal(r.facts[0].note, '[true,false,false,false,true]');
  assert.ok(!existsSync(join(repo, 'PWNED')), 'the planted ast.py never ran');
});

test('ctx.git, readHead, listFiles and mergeBase work in the child; non-ASCII paths are unquoted', async () => {
  const p = mod('git', "export default [{ name: 'git', run: ({ git, readHead, listFiles, mergeBase, headSha }) => [{ file: 'x', note: [git(['diff', '--name-only', `${mergeBase}..${headSha}`]).trim().split('\\n').sort().join(','), readHead('a.ts').trim(), listFiles('*.md').join(','), mergeBase.length].join(' | ') }] }];");
  const [r] = await runProjectChecks([p], ctx());
  assert.equal(r.facts[0].note, 'ast.py,café — notes.md | a | café — notes.md | 40');
});

test('long added lines are skipped before checks see them, and counted', async () => {
  const p = mod('len', "export default [{ name: 'len', run: ({ files }) => [{ file: 'x', note: String(files[0].added.length) }] }];");
  const r = await runProjectChecks([p], ctx());
  assert.equal(r[0].facts[0].note, '1');
  assert.match(r.find((x) => x.check === 'long-lines').facts[0].note, /1 diff line\(s\) over 2000 characters were not given to project checks/);
});

test('notes are redacted, capped and never carry a withheld path', async () => {
  setActiveProject({ ...RP, config: normalizeConfig({ version: 1, project: 'p', classes: [{ id: 1, name: 'x' }], withheld: ['clients/**'] }).config });
  const secret = ['sk', 'live', 'Z'.repeat(20)].join('_');
  const p = mod('notes', `export default [{ name: 'notes', run: () => [{ file: 'clients/acme.md', note: 'see clients/acme.md key ${secret} ' + 'y'.repeat(900) }] }];`);
  const [r] = await runProjectChecks([p], ctx());
  setActiveProject(RP);
  const f = r.facts[0];
  assert.doesNotMatch(`${f.file} ${f.note}`, /acme|ZZZZZZZZ/);
  assert.match(f.file, /^withheld:[0-9a-f]{8}$/);
  assert.ok(f.note.length <= 300);
});

test('parseOnly reports the parser message with its line, and a missing interpreter separately', async () => {
  const { parseOnly } = await import('../lib/parse-only.mjs');
  const b = parseOnly('bash', 'echo ok\nif true; then\n');
  assert.equal(b.ok, false);
  assert.match(b.error, /line \d+/);
  const n = parseOnly('node', 'const a = 1;\nconst x = ;');
  assert.equal(n.ok, false);
  assert.match(n.error, /:2\b|line 2|SyntaxError/);
  assert.notEqual(n.error, 'parse error');
  const p = parseOnly('python', 'x = 1\ndef (:');
  assert.match(p.error, /line 2/);
  const old = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    assert.deepEqual(parseOnly('python', 'x=1'), { ok: false, error: 'interpreter missing: python3', missing: true });
  } finally {
    process.env.PATH = old;
  }
});

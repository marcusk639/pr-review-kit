import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RP } from './helpers/rp.mjs';
import { normalizeConfig, setActiveProject } from '../lib/config.mjs';
import { mergeFromBase, writeCollaborators } from '../lib/repo-facts.mjs';

let root;
const S = {};
before(() => {
  root = mkdtempSync(join(tmpdir(), 'merges-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a'), '1');
  g('add', '-A');
  g('commit', '-qm', 'base0');
  S.base0 = g('rev-parse', 'HEAD');
  g('checkout', '-q', '-b', 'pr');
  writeFileSync(join(root, 'b'), '1');
  g('add', '-A');
  g('commit', '-qm', 'pr work');
  g('checkout', '-q', 'main');
  writeFileSync(join(root, 'c'), '1');
  g('add', '-A');
  g('commit', '-qm', 'main moved');
  S.base1 = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'pr');
  g('merge', '-q', '--no-edit', 'main');
  S.head = g('rev-parse', 'HEAD');
});
afterEach(() => setActiveProject(RP));

test('merge commits that bring in the base branch are listed', () => {
  const facts = mergeFromBase(S.base1, S.head, root);
  assert.equal(facts.length, 1);
  assert.match(facts[0].note, /^merge from base: [0-9a-f]{7} /);
  assert.deepEqual(mergeFromBase(S.base0, S.base0, root), []);
});

const use = (wc) => setActiveProject({ ...RP, config: normalizeConfig({ version: 1, project: 'p', classes: [{ id: 1, name: 'x' }], checks: { writeCollaborators: wc } }).config });

test('write collaborators beyond the allowed list are counted, never named', async () => {
  use({ allowed: ['repository-owner'] });
  const request = async () => [{ login: 'o', permissions: { push: true } }, { login: 'eve', permissions: { push: true } }, { login: 'reader', permissions: { pull: true, push: false } }];
  const r = await writeCollaborators('o/r', request);
  assert.equal(r.facts.length, 1);
  assert.match(r.facts[0].note, /1 collaborator\(s\) other than the allowed ones can write/);
  assert.doesNotMatch(r.facts[0].note, /eve/);
  assert.equal(r.status, 1);
});

test('an unreadable collaborator list is a loud fact, not silence; off by default', async () => {
  use({ allowed: ['repository-owner'] });
  const r = await writeCollaborators('o/r', async () => {
    throw Object.assign(new Error('x'), { status: 403 });
  });
  assert.match(r.facts[0].note, /could not be listed/);
  assert.equal(r.status, 'unreadable');
  use(false);
  assert.deepEqual((await writeCollaborators('o/r', async () => [])).facts, []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig, loadProject, securityClasses, classIds } from '../lib/config.mjs';

const minimal = { version: 1, project: 'demo', classes: [{ id: 1, name: 'one' }] };

test('normalizeConfig fills the reference defaults', () => {
  const { config, errors } = normalizeConfig(minimal);
  assert.deepEqual(errors, []);
  assert.equal(config.visibility, 'public');
  assert.equal(config.securityChannel, 'advisory');
  assert.equal(config.inline.max, 10);
  assert.deepEqual(config.inline.severities, ['Critical', 'High']);
  assert.equal(config.tiers.set, 'all');
  assert.deepEqual(config.tiers.disabled, []);
  assert.deepEqual(config.tiers.maxTurns, { none: 0, 'base-drift': 15, light: 15, incremental: 40, 'incremental-new-links': 60, full: 60 });
  assert.equal(config.tiers.largeShare, 0.5);
  assert.equal(config.checks.newFileSize.maxLines, 300);
  assert.equal(config.checks.secrets, true);
  assert.equal(config.checks.titleScope, false);
  assert.equal(config.checks.verifyDiff, false);
  assert.deepEqual(config.trust.contextAssociations, ['OWNER']);
  assert.deepEqual(config.trust.feedbackAuthors, ['repository-owner']);
  assert.equal(config.workflowPath, '.github/workflows/pr-review.yml');
  assert.equal(config.learning.distill, 'model');
});

test('normalizeConfig merges a partial maxTurns over the defaults', () => {
  const { config } = normalizeConfig({ ...minimal, tiers: { maxTurns: { full: 30 } } });
  assert.equal(config.tiers.maxTurns.full, 30);
  assert.equal(config.tiers.maxTurns.incremental, 40);
});

test('normalizeConfig rejects unknown keys, bad visibility and bad channels', () => {
  assert.match(normalizeConfig({ ...minimal, bogus: 1 }).errors.join(), /unknown key: bogus/);
  assert.match(normalizeConfig({ ...minimal, visibility: 'internal' }).errors.join(), /visibility/);
  assert.match(normalizeConfig({ ...minimal, securityChannel: 'repo-comments' }).errors.join(), /securityChannel/);
  assert.match(normalizeConfig({ ...minimal, visibility: 'private', securityChannel: 'advisory' }).errors.join(), /advisory.*public/);
  assert.deepEqual(normalizeConfig({ ...minimal, visibility: 'private', securityChannel: 'none' }).errors, []);
});

test('a private repo defaults to the private-repo-issue channel', () => {
  assert.equal(normalizeConfig({ ...minimal, visibility: 'private' }).config.securityChannel, 'private-repo-issue');
});

test('normalizeConfig validates classes', () => {
  assert.match(normalizeConfig({ ...minimal, classes: [] }).errors.join(), /classes/);
  assert.match(normalizeConfig({ ...minimal, classes: [{ id: 0, name: 'x' }] }).errors.join(), /classes\[0\]\.id/);
  assert.match(normalizeConfig({ ...minimal, classes: [{ id: 2, name: 'a' }, { id: 2, name: 'b' }] }).errors.join(), /duplicate class/);
  assert.match(normalizeConfig({ version: 2, project: 'x', classes: minimal.classes }).errors.join(), /version/);
  assert.match(normalizeConfig({ ...minimal, project: 'has space' }).errors.join(), /project/);
});

test('security classes and class ids come from the config', () => {
  const { config } = normalizeConfig({ ...minimal, classes: [{ id: 3, name: 'a', security: true }, { id: 9, name: 'b' }] });
  assert.deepEqual([...securityClasses(config)], [3]);
  assert.deepEqual([...classIds(config)], [3, 9]);
});

test('loadProject reads config.json and routing.json and checks routing classes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proj-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(minimal));
  writeFileSync(join(dir, 'routing.json'), JSON.stringify([{ linkType: 'api', paths: ['src/**'], counterparts: [], classes: [1] }]));
  const p = loadProject(dir);
  assert.deepEqual(p.errors, []);
  assert.equal(p.config.project, 'demo');
  assert.deepEqual(p.linkTypes, ['api']);
  writeFileSync(join(dir, 'routing.json'), JSON.stringify([{ linkType: 'api', paths: ['src/**'], counterparts: [], classes: [7] }]));
  assert.match(loadProject(dir).errors.join(), /routing api: class 7 is not configured/);
});

test('loadProject reports a missing or unparsable config instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proj-'));
  assert.match(loadProject(dir).errors.join(), /config\.json/);
  writeFileSync(join(dir, 'config.json'), '{nope');
  assert.match(loadProject(dir).errors.join(), /config\.json/);
});

test('the recovery-platform fixture loads cleanly', () => {
  const p = loadProject(new URL('./fixtures/rp/', import.meta.url).pathname);
  assert.deepEqual(p.errors, []);
  assert.deepEqual([...securityClasses(p.config)], [1, 4, 7, 11, 14]);
});

test('malformed nested values are errors, never a throw', () => {
  for (const bad of [{ trust: null }, { inline: 'x' }, { tiers: 5 }, { learning: [] }, { secrets: { extraPatterns: 'x' } }, { checks: { verifyDiff: true } }, { checks: null }, { largePr: { files: -1 } }, { learning: { branch: '' } }, { learning: { windowDays: 'a' } }, { tiers: { maxTurns: null } }]) {
    let r;
    assert.doesNotThrow(() => {
      r = normalizeConfig({ ...minimal, ...bad });
    }, JSON.stringify(bad));
    assert.ok(r.errors.length > 0, `no error for ${JSON.stringify(bad)}`);
  }
});

test('a null or array config is an error', () => {
  assert.match(normalizeConfig(null).errors.join(), /JSON object/);
  assert.match(normalizeConfig([]).errors.join(), /JSON object/);
});

test('unknown nested keys are rejected', () => {
  assert.match(normalizeConfig({ ...minimal, inline: { max: 3, bogus: 1 } }).errors.join(), /unknown key: inline\.bogus/);
  assert.match(normalizeConfig({ ...minimal, checks: { piiLogs: { fields: 'x', nope: 1 } } }).errors.join(), /unknown key: checks\.piiLogs\.nope/);
});

test('invalid regexes in checks are errors', () => {
  assert.match(normalizeConfig({ ...minimal, checks: { piiLogs: { fields: '(', logCall: 'x' } } }).errors.join(), /checks\.piiLogs\.fields/);
});

test('the learning branch cannot be a default-branch name', () => {
  assert.match(normalizeConfig({ ...minimal, learning: { branch: 'main' } }).errors.join(), /learning\.branch/);
});

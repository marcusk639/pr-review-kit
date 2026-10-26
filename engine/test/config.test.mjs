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
  assert.equal(config.tiers.enabled, true);
  assert.deepEqual(config.tiers.maxTurns, { none: 0, 'base-drift': 15, light: 15, incremental: 40, 'incremental-new-links': 60, full: 60 });
  assert.equal(config.tiers.largeShare, 0.5);
  assert.equal(config.checks.newFileSize.maxLines, 300);
  assert.equal(config.checks.secrets, true);
  assert.equal(config.checks.titleScope, false);
  assert.equal(config.checks.verifyDiff, false);
  assert.deepEqual(config.trust.contextAssociations, ['OWNER', 'MEMBER', 'COLLABORATOR']);
  assert.deepEqual(config.trust.feedbackAuthors, []);
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
  assert.match(normalizeConfig({ ...minimal, securityChannel: 'repo-comments' }).errors.join(), /repo-comments.*private/);
  assert.match(normalizeConfig({ ...minimal, visibility: 'private', securityChannel: 'advisory' }).errors.join(), /advisory.*public/);
  assert.match(normalizeConfig({ ...minimal, visibility: 'private', securityChannel: 'repo-comments' }).errors.join(), /privateReaders/);
  assert.deepEqual(normalizeConfig({ ...minimal, visibility: 'private', securityChannel: 'repo-comments', privateReaders: ['me'] }).errors, []);
});

test('a private repo defaults to the none channel', () => {
  assert.equal(normalizeConfig({ ...minimal, visibility: 'private' }).config.securityChannel, 'none');
});

test('normalizeConfig validates classes', () => {
  assert.match(normalizeConfig({ ...minimal, classes: [] }).errors.join(), /classes/);
  assert.match(normalizeConfig({ ...minimal, classes: [{ id: 0, name: 'x' }] }).errors.join(), /class id/);
  assert.match(normalizeConfig({ ...minimal, classes: [{ id: 2, name: 'a' }, { id: 2, name: 'b' }] }).errors.join(), /duplicate class/);
  assert.match(normalizeConfig({ version: 2, project: 'x', classes: minimal.classes }).errors.join(), /version/);
  assert.match(normalizeConfig({ ...minimal, project: 'has space' }).errors.join(), /project/);
});

test('security classes and class ids come from the config', () => {
  const { config } = normalizeConfig({ ...minimal, classes: [{ id: 3, name: 'a', security: true }, { id: 9, name: 'b' }] });
  assert.deepEqual([...securityClasses(config)], [3]);
  assert.deepEqual([...classIds(config)], [3, 9]);
});

test('a private repo-comments channel keeps the configured security classes', () => {
  const { config } = normalizeConfig({ ...minimal, visibility: 'private', securityChannel: 'repo-comments', privateReaders: ['me'], classes: [{ id: 3, name: 'a', security: true }] });
  assert.deepEqual([...securityClasses(config)], [3]);
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

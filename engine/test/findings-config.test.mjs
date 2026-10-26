import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RP } from './helpers/rp.mjs';
import { normalizeConfig, setActiveProject } from '../lib/config.mjs';
import { validateFindings, isForcedSecurity } from '../lib/findings.mjs';
import { readInline, selectInline, inlineEligible } from '../lib/inline-post.mjs';

const SHA = 'a'.repeat(40);
const project = (raw, extra = {}) => ({ config: normalizeConfig({ version: 1, project: 'p', ...raw }).config, routing: [], linkTypes: [], errors: [], ...extra });
const finding = (cls, over = {}) => ({
  slug: `c${cls}:src/a.ts:fn`, class: cls, severity: 'High', confidence: 'high', security: false, package: 'repo', area: 'api',
  title: 't', feature: 'f', why: 'w', fix: 'x', locations: [{ file: 'src/a.ts', line: 3, side: 'changed' }], ...over,
});
const doc = (...findings) => ({ reviewedSha: SHA, findings, resolvedSlugs: [], complete: true });

afterEach(() => setActiveProject(RP));

test('class ids beyond 14 are valid when configured', () => {
  setActiveProject(project({ classes: [{ id: 21, name: 'x' }] }));
  const r = validateFindings(doc(finding(21)));
  assert.equal(r.ok, true, r.error);
});

test('a class the project does not configure is rejected', () => {
  setActiveProject(project({ classes: [{ id: 21, name: 'x' }] }));
  assert.match(validateFindings(doc(finding(3))).error, /class/);
});

test('forced security follows the configured security classes', () => {
  setActiveProject(project({ classes: [{ id: 2, name: 'a', security: true }, { id: 5, name: 'b' }] }));
  assert.equal(isForcedSecurity(5, 'c2:a.ts:x'), true);
  assert.equal(isForcedSecurity(2, 'c5:a.ts:x'), true);
  assert.equal(isForcedSecurity(5, 'c5:a.ts:x'), false);
  assert.equal(validateFindings(doc(finding(2))).value.findings[0].security, true);
});

test('a verified private channel withholds nothing by class', () => {
  setActiveProject(project({ visibility: 'private', securityChannel: 'repo-comments', privateReaders: ['me'], classes: [{ id: 2, name: 'a', security: true }] }, { privateVerified: true }));
  assert.equal(isForcedSecurity(2, 'c2:a.ts:x'), false);
});

test('inline slugs accept configured class ids beyond 14', () => {
  setActiveProject(project({ classes: [{ id: 21, name: 'x' }] }));
  const r = readInline(JSON.stringify([{ slug: 'c21:src/a.ts:fn', path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'b' }]));
  assert.equal(r.entries.length, 1);
});

test('inline severities and cap come from the config', () => {
  setActiveProject(project({ classes: [{ id: 3, name: 'x' }], inline: { max: 1, severities: ['Critical', 'High', 'Medium'] } }));
  const med = finding(3, { severity: 'Medium' });
  assert.equal(inlineEligible(med, []), true);
  const two = [finding(3, { slug: 'c3:src/a.ts:one' }), finding(3, { slug: 'c3:src/a.ts:two' })];
  const entries = two.map((f) => ({ slug: f.slug, path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'b' }));
  assert.equal(selectInline({ entries, findings: two, changedFiles: ['src/a.ts'], postedSlugs: [] }).length, 1);
});

test('a demoted class gets no inline comment', () => {
  setActiveProject(project({ classes: [{ id: 3, name: 'x' }] }, { demotedClasses: new Set([3]) }));
  assert.equal(inlineEligible(finding(3), []), false);
});

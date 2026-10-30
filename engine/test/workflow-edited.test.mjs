// claude-code-action runs the model only when the PR's workflow file is the
// default branch's copy, so a PR that edits the review workflow is never
// reviewed. Publish says so instead of reporting a failed review.
import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { composeBody } from '../publish.mjs';
import { workflowEdited } from '../facts.mjs';
import { completion, outcomeLabel, WORKFLOW_EDITED } from '../lib/completion.mjs';
import { WORKFLOW_EDITED_BANNER } from '../lib/render.mjs';
import { decodeLedger } from '../lib/markers.mjs';

const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const LEDGER = [{ id: '0123456789abcdef', slug: 'c9:a.ts:x', title: 'Swallowed error', severity: 'Medium', status: 'open', security: false, runsSinceResolved: 0 }];
const state = (over = {}) => ({ lastReviewedSha: null, lastBaseSha: null, ledger: LEDGER, linkTypesSeen: [], inlineSlugs: [], tier: 'full', maxTurns: 60, headSha: HEAD, baseSha: BASE, pr: 7, ...over });

test('workflowEdited: any difference, or a workflow missing on either side, counts as edited', () => {
  assert.equal(workflowEdited('a', 'a'), false);
  assert.equal(workflowEdited('a', 'b'), true);
  assert.equal(workflowEdited(null, 'a'), true, 'the PR adds the workflow');
  assert.equal(workflowEdited('a', null), true);
});

test('no findings on a workflow-editing PR: reason workflow-edited, its own banner, prior ledger kept', () => {
  const s = state({ workflowEdited: true });
  assert.equal(completion(s, null, 'success', null).reason, WORKFLOW_EDITED);
  const body = composeBody({ state: s, findingsText: null, narrative: null, outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: 'k' });
  assert.ok(body.includes(WORKFLOW_EDITED_BANNER));
  assert.doesNotMatch(body, /review did not complete/);
  assert.doesNotMatch(body, /will retry on next push/);
  assert.deepEqual(decodeLedger(body).ledger.map((e) => e.slug), ['c9:a.ts:x'], 'prior ledger kept');
  assert.equal(outcomeLabel(s, { findingsText: null, outcome: 'success', narrative: null }), 'not reviewed (the PR edits the review workflow)');
});

test('an unchanged workflow keeps the plain failure banner', () => {
  const body = composeBody({ state: state({ workflowEdited: false }), findingsText: null, narrative: null, outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: 'k' });
  assert.match(body, /review did not complete \(failed\)/);
  assert.ok(!body.includes(WORKFLOW_EDITED_BANNER));
});

test('a workflow-editing PR whose model did run (another action version) is published normally', () => {
  const findingsText = JSON.stringify({ reviewedSha: HEAD, findings: [], resolvedSlugs: [], complete: true });
  const s = state({ workflowEdited: true });
  assert.equal(completion(s, findingsText, 'success', '## Features touched\n- x').reason, null);
  const body = composeBody({ state: s, findingsText, narrative: '## Features touched\n- x', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: 'k' });
  assert.ok(!body.includes(WORKFLOW_EDITED_BANNER));
  assert.doesNotMatch(body, /did not complete/);
});

test('facts records the comparison of the base and head review workflow in the trusted snapshot', () => {
  const src = readFileSync(new URL('../facts.mjs', import.meta.url), 'utf8');
  assert.match(src, /state\.workflowEdited = workflowEdited\(readOr\(join\(baseDir, project\.config\.workflowPath\)\), readAt\(HEAD_SHA, project\.config\.workflowPath, repoRoot\)\);/);
});

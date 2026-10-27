import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksReady, kitPins, parseArgs, secretSources, wiringFrom, writerRisk } from '../enable/plan.mjs';

const SHA = 'a'.repeat(40);
const REVIEW = `
jobs:
  review:
    steps:
      - uses: marcusk639/pr-review-kit/actions/review@${SHA}
        with:
          claude_code_oauth_token: \${{ secrets.FIRM_CLAUDE_CODE_OAUTH_TOKEN }}
          redact_terms: \${{ secrets.PR_REVIEW_REDACT_TERMS }}
          # private_issue_token: \${{ secrets.COMMENTED_OUT }}
      - uses: marcusk639/pr-review-kit/actions/publish@${SHA}
        with:
          id_key: \${{ secrets.PR_REVIEW_ID_KEY }}
          private_repo: \${{ vars.PR_REVIEW_PRIVATE_REPO }}
          private_issue_token: \${{ secrets.PR_REVIEW_ISSUE_TOKEN }}
        env:
          OTHER: \${{ secrets.NOT_A_KIT_INPUT }}
`;

test('parseArgs: defaults, flags, validation', () => {
  const o = parseArgs(['--repo', 'o/r']);
  assert.deepEqual(o.steps, ['preflight', 'inbox', 'secrets', 'settings']);
  assert.equal(o.apply, false);
  assert.equal(o.branch, 'chore/pr-review');
  const p = parseArgs(['--repo', 'o/r', '--steps', 'merge,test-pr', '--merge-method', 'squash', '--apply', '--inbox', 'o/inbox', '--wait-minutes', '5']);
  assert.deepEqual(p.steps, ['merge', 'test-pr']);
  assert.equal(p.apply, true);
  assert.equal(p.mergeMethod, 'squash');
  assert.equal(p.waitMinutes, 5);
  assert.throws(() => parseArgs([]), /--repo/);
  assert.throws(() => parseArgs(['--repo', 'o/r', '--steps', 'nope']), /unknown step/);
  assert.throws(() => parseArgs(['--repo', 'o/r', '--steps', 'merge']), /--merge-method/);
  assert.throws(() => parseArgs(['--repo', 'o/r', '--inbox']), /needs a value/);
  assert.throws(() => parseArgs(['--repo', 'o/r', 'stray']), /unexpected argument/);
  assert.equal(parseArgs(['--help']).help, true);
});

test('wiring is read from the workflows: renamed secrets, the inbox variable, comments and non-kit secrets ignored', () => {
  const w = wiringFrom([REVIEW]);
  assert.deepEqual(w.secrets, [
    { name: 'FIRM_CLAUDE_CODE_OAUTH_TOKEN', role: 'claude_code_oauth_token' },
    { name: 'PR_REVIEW_REDACT_TERMS', role: 'redact_terms' },
    { name: 'PR_REVIEW_ID_KEY', role: 'id_key' },
    { name: 'PR_REVIEW_ISSUE_TOKEN', role: 'private_issue_token' },
  ]);
  assert.deepEqual(w.vars, [{ name: 'PR_REVIEW_PRIVATE_REPO', role: 'private_repo' }]);
  assert.deepEqual(kitPins([REVIEW]), [SHA]);
});

test('secret values: id key generated, redact terms from a file or optional, the rest from env or prompt', () => {
  const s = secretSources(wiringFrom([REVIEW]), { redactTermsFile: '/tmp/terms' });
  assert.deepEqual(s.map((x) => [x.name, x.source]), [
    ['FIRM_CLAUDE_CODE_OAUTH_TOKEN', 'env-or-prompt'],
    ['PR_REVIEW_REDACT_TERMS', 'file'],
    ['PR_REVIEW_ID_KEY', 'generate'],
    ['PR_REVIEW_ISSUE_TOKEN', 'env-or-prompt'],
  ]);
  assert.equal(secretSources(wiringFrom([REVIEW])).find((x) => x.role === 'redact_terms').source, 'env-or-skip');
});

test('other writers or a pending write invitation block; read-only ones do not', () => {
  const owner = 'marcus';
  const me = { login: 'Marcus', permissions: { admin: true, push: true } };
  assert.equal(writerRisk({ collaborators: [me], owner }).blocking, false);
  assert.equal(writerRisk({ collaborators: [me, { login: 'doug', permissions: { push: false, pull: true } }], owner }).blocking, false);
  const w = writerRisk({ collaborators: [me, { login: 'doug', permissions: { push: true } }], owner });
  assert.equal(w.blocking, true);
  assert.deepEqual(w.others, ['doug']);
  assert.equal(writerRisk({ collaborators: [me], invitations: [{ invitee: { login: 'chris' }, permissions: 'write' }], owner }).blocking, true);
  assert.equal(writerRisk({ collaborators: [me], invitations: [{ invitee: { login: 'chris' }, permissions: 'read' }], owner }).blocking, false);
});

test('checks are ready only when all finished and none failed', () => {
  assert.equal(checksReady([{ name: 'review', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'n', status: 'COMPLETED', conclusion: 'SKIPPED' }]).ready, true);
  assert.deepEqual(checksReady([{ name: 'review', status: 'IN_PROGRESS', conclusion: '' }]).pending, ['review']);
  assert.deepEqual(checksReady([{ name: 'audit', status: 'COMPLETED', conclusion: 'FAILURE' }]).failed, ['audit']);
  assert.equal(checksReady([{ context: 'netlify', state: 'PENDING' }]).ready, false);
  assert.equal(checksReady([{ context: 'netlify', state: 'SUCCESS' }]).ready, true);
  assert.equal(checksReady([]).ready, true);
});

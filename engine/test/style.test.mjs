import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RP } from './helpers/rp.mjs';
import { normalizeConfig, setActiveProject } from '../lib/config.mjs';
import { applyStyle } from '../lib/style.mjs';
import { checkWorkflow } from '../lib/workflow-check.mjs';
import { readFileSync } from 'node:fs';

afterEach(() => setActiveProject(RP));
const use = (style) => setActiveProject({ ...RP, config: normalizeConfig({ version: 1, project: 'p', classes: [{ id: 1, name: 'x' }], style }).config });

test('style rules: no emoji (votes become +1/-1), no em-dashes', () => {
  use({ noEmoji: true, noEmDash: true });
  assert.equal(applyStyle('👍/👎 a — b ⚠ done 🚀'), '+1/-1 a - b ! done');
  use({});
  assert.equal(applyStyle('a — b 👍'), 'a — b 👍');
});

test('validate: a closed trigger needs the merged guard', () => {
  const wf = readFileSync(new URL('../../examples/consumer/.github/workflows/pr-review.yml', import.meta.url), 'utf8').replaceAll('KIT_SHA', 'a'.repeat(40));
  const closed = wf.replace('types: [opened, synchronize, ready_for_review, reopened]', 'types: [opened, synchronize, ready_for_review, reopened, closed]');
  assert.match(checkWorkflow(closed).errors.join(), /closed PRs need the merged guard/);
  const guarded = closed.replace("      ${{ !github.event.pull_request.draft", "      ${{ (github.event.action != 'closed' || github.event.pull_request.merged)\n      && !github.event.pull_request.draft");
  assert.deepEqual(checkWorkflow(guarded).errors, []);
});

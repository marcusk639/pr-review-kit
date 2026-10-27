// P0.3 #2: the learn Distill model gets the same withheld Read denies as the
// review model, and runs only when they can be expressed (fail closed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../lib/config.mjs';
import { collectOutputs } from '../learn/run-learn.mjs';

const project = (extra) => ({ dir: '/x/.pr-review', config: normalizeConfig({ version: 1, project: 'p', classes: [{ id: 1, name: 'x' }], learning: { distill: 'model' }, ...extra }).config });

test('collect emits withheld Read denies for the distill model', () => {
  const o = collectOutputs(project({ withheld: ['docs/firm/**', '**/*.xlsx'] }), 3, '/ws');
  assert.equal(o.distill, 'model');
  assert.match(o.text, /^candidates=3$/m);
  assert.match(o.text, /^extra_deny=,Read\(\/\/ws\/docs\/firm\/\*\*\),Read\(\/\/ws\/docs\/firm\/\*\*\.pr-head\),Read\(\/\/ws\/\*\*\/\*\.xlsx\),Read\(\/\/ws\/\*\*\/\*\.xlsx\.pr-head\)$/m);
});

test('no withheld paths: empty extra_deny, model distill unchanged', () => {
  const o = collectOutputs(project({}), 0, '/ws');
  assert.match(o.text, /^extra_deny=$/m);
  assert.equal(o.distill, 'model');
});

test('a withheld glob that cannot be denied disables the model (fail closed)', () => {
  const p = project({});
  p.config.withheld = ['Café/**'];
  const o = collectOutputs(p, 2, '/ws');
  assert.equal(o.distill, 'deterministic');
  assert.match(o.text, /^distill=deterministic$/m);
  assert.ok(o.warning);
});

test('the learn action appends the collect step\'s withheld denies to the distill model', () => {
  const learn = readFileSync(fileURLToPath(new URL('../../actions/learn/action.yml', import.meta.url)), 'utf8');
  assert.match(learn, /\*\*\)\$\{\{ steps\.collect\.outputs\.extra_deny \}\}"/);
});

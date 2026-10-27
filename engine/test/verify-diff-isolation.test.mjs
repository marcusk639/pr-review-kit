// P0.3 #1: the trusted verify-diff script must not let PR-controlled git
// config (a committed .gitconfig or .config/git/config, .gitattributes
// drivers) execute anything, and it runs without job secrets.
import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerifyDiff } from '../hygiene.mjs';

function prRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'vd-'));
  const marker = join(repo, '..', `PWNED-${process.pid}-${Date.now()}`);
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  g('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  // The PR plants git config where a HOME of the repo would load it, plus a driver.
  const evil = join(repo, 'evil.sh');
  writeFileSync(evil, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(evil, 0o755);
  writeFileSync(join(repo, '.gitconfig'), `[diff]\n\texternal = ${evil}\n[core]\n\tfsmonitor = ${evil}\n`);
  mkdirSync(join(repo, '.config/git'), { recursive: true });
  writeFileSync(join(repo, '.config/git/config'), `[diff]\n\texternal = ${evil}\n`);
  writeFileSync(join(repo, '.gitattributes'), '* diff=evil\n');
  writeFileSync(join(repo, 'a.txt'), 'b\n');
  g('add', '-A');
  g('commit', '-qm', 'head');
  return { repo, base, head: g('rev-parse', 'HEAD'), marker };
}

test('PR git config never executes through the verify script, and the script sees no secrets', () => {
  const { repo, base, head, marker } = prRepo();
  const script = join(mkdtempSync(join(tmpdir(), 'vds-')), 'verify.sh');
  // A realistic gate: diffs the working tree and the objects, prints env names.
  writeFileSync(script, 'git diff "$1" >/dev/null 2>&1\ngit diff "$1" "$2" >/dev/null 2>&1\ngit -C "$PR_REVIEW_REPO" diff "$1" "$2" >/dev/null 2>&1\necho "[ENV] $(env | cut -d= -f1 | grep -E \'TOKEN|GITHUB|ACTIONS|RUNNER\' | tr \'\\n\' \' \')cwd-is-repo=$([ "$PWD" = "$PR_REVIEW_REPO" ] && echo yes || echo no)"\nexit 1\n');
  process.env.GH_TOKEN = 'ghs_x';
  try {
    const [f] = runVerifyDiff(base, repo, script, head);
    assert.ok(!existsSync(marker), 'the planted diff.external/fsmonitor never ran');
    assert.equal(f.note, '[ENV] cwd-is-repo=no');
  } finally {
    delete process.env.GH_TOKEN;
  }
});

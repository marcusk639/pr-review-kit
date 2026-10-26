#!/usr/bin/env node
// Consumer tooling for pr-review-kit. Run from the consumer repo's root.
//   local --base <sha> --head <sha> [--findings f.json] [--summary s.md] [--inline i.json]
//         [--show-private] [--assume-private-verified]
//     Facts against the local repo (offline: no GitHub, no prior state), with
//     the project read from the base commit, then publish in dry-run mode.
//   validate [--workflow <path>]
//     Checks .claude/pr-review/ and the review workflow (see engine/validate.mjs).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPublish } from '../engine/run-publish.mjs';
import { validateRepo } from '../engine/validate.mjs';

const ENGINE = fileURLToPath(new URL('../engine/', import.meta.url));

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else if (['--show-private', '--assume-private-verified'].includes(a)) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

const git = (a, cwd) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The base commit's .claude/pr-review and .github, as the workflow's base checkout would have them.
function baseCheckout(base, cwd, dir) {
  mkdirSync(dir, { recursive: true });
  for (const path of ['.claude/pr-review', '.github']) {
    try {
      const tar = execFileSync('git', ['archive', '--format=tar', base, path], { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
      execFileSync('tar', ['-x', '-C', dir], { input: tar });
    } catch {
      // absent on the base commit
    }
  }
}

async function local(o) {
  const cwd = process.cwd();
  if (!o.base || !o.head) throw new Error('local needs --base <sha> and --head <sha>');
  const base = git(['rev-parse', `${o.base}^{commit}`], cwd);
  const head = git(['rev-parse', `${o.head}^{commit}`], cwd);
  const tmp = mkdtempSync(join(tmpdir(), 'pr-review-local-'));
  const baseDir = join(tmp, 'base');
  baseCheckout(base, cwd, baseDir);
  const out = join(tmp, 'out');
  const ghOut = join(tmp, 'github-output');
  writeFileSync(ghOut, '');
  const env = {
    ...process.env, OUT: out, STATE_FILE: join(tmp, 'snapshot', 'state.json'), GITHUB_OUTPUT: ghOut,
    BASE_SHA: base, HEAD_SHA: head, PR: o.pr ?? '0', REPO: 'local/local', PR_TITLE: git(['log', '-1', '--format=%s', head], cwd),
    PR_REVIEW_BASE: baseDir, PR_REVIEW_PUBLISH: baseDir, PR_REVIEW_OFFLINE: '1', GITHUB_STEP_SUMMARY: '',
  };
  process.stdout.write(execFileSync('node', [join(ENGINE, 'facts.mjs')], { cwd, env, encoding: 'utf8' }));
  const tier = /tier=(\S+)/.exec(readFileSync(ghOut, 'utf8'))?.[1] ?? 'none';
  try {
    process.stdout.write(`\n=== facts.md ===\n${readFileSync(join(out, 'facts.md'), 'utf8')}`);
  } catch {
    process.stdout.write(`\n=== facts.md ===\n(not written: tier ${tier})\n`);
  }
  if (o.findings) {
    mkdirSync(out, { recursive: true });
    copyFileSync(o.findings, join(out, 'findings.json'));
    if (o.summary) copyFileSync(o.summary, join(out, 'summary.md'));
    else writeFileSync(join(out, 'summary.md'), '');
    if (o.inline) copyFileSync(o.inline, join(out, 'inline.json'));
  }
  const outcome = o.findings ? 'success' : tier === 'none' ? 'skipped' : 'failure';
  await runPublish({ ...env, ACTION_OUTCOME: outcome }, { dryRun: true, showPrivate: o['show-private'], assumePrivateVerified: o['assume-private-verified'] });
  process.stdout.write(`\n(local run: tier ${tier}, outcome ${outcome}; material in ${tmp})\n`);
}

async function main() {
  const o = args(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === 'local') return local(o);
  if (cmd === 'validate') {
    const { errors, warnings } = validateRepo(process.cwd(), { workflow: o.workflow });
    for (const w of warnings) process.stdout.write(`warning: ${w}\n`);
    for (const e of errors) process.stdout.write(`error: ${e}\n`);
    process.stdout.write(errors.length ? `validate: ${errors.length} error(s)\n` : 'validate: ok\n');
    process.exitCode = errors.length ? 1 : 0;
    return;
  }
  process.stdout.write('usage: pr-review.mjs local --base <sha> --head <sha> [...] | validate [--workflow <path>]\n');
  process.exitCode = 2;
}

main().catch((err) => {
  process.stderr.write(`pr-review: ${err.message}\n`);
  process.exitCode = 1;
});

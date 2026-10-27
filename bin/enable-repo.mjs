#!/usr/bin/env node
// Enable the PR reviewer on one consumer repository, step by step, with the
// gh CLI (authenticated as the repository owner). Dry run unless --apply.
//
//   node bin/enable-repo.mjs --repo owner/name [--steps a,b,...] [--apply] [options]
//
// Steps (default: preflight,inbox,secrets,settings; merge and test-pr are opt-in):
//   preflight  repo, Actions, .pr-review/config.json, kit pin on the kit's main,
//              writers and pending invitations (other writers block every later step)
//   inbox      private-repo-issue only: the owner-only private inbox repo and the
//              repository variable that names it (--inbox, --create-inbox)
//   secrets    every secret the workflows map to a kit input, read from the workflows
//              (so a renamed secret such as FIRM_CLAUDE_CODE_OAUTH_TOKEN needs no flag).
//              Values: PR_REVIEW_ID_KEY is generated; others come from an environment
//              variable of the same name or a hidden prompt; redact terms from
//              --redact-terms-file. Existing secrets are kept unless --rotate.
//   settings   "Allow GitHub Actions to create and approve pull requests" (learning PR)
//   merge      merge the setup PR (--pr, or the open PR from --branch) once every check
//              has finished green; needs --merge-method merge|squash|rebase
//   test-pr    open a throwaway docs PR, wait for the review run (--wait-minutes),
//              report the summary comment, then close it (--keep-test-pr to keep)
//
// Other options: --branch (setup branch, default chore/pr-review),
//   --allow-other-writers (proceed although others can write; not recommended).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DEFAULT_STEPS, STEPS, checksReady, kitPins, parseArgs, secretSources, wiringFrom, writerRisk } from '../engine/enable/plan.mjs';
import { BOT_AUTHOR, SUMMARY_MARKER } from '../engine/lib/markers.mjs';

const KIT = 'marcusk639/pr-review-kit';
const say = (m) => console.log(m);
const warn = (m) => console.log(`  ! ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);

function gh(args, { input } = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }).trim();
}
const ghJson = (args) => JSON.parse(gh(args) || 'null');
const tryJson = (args) => {
  try {
    return ghJson(args);
  } catch {
    return null;
  }
};

function readAt(repo, path, ref) {
  const r = tryJson(['api', `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`]);
  return r?.content ? Buffer.from(r.content, 'base64').toString('utf8') : null;
}

function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error('no terminal to prompt on; export the value as an environment variable instead'));
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') process.exit(130);
        value = ch === '\u007f' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on('data', onData);
  });
}

const HINTS = {
  claude_code_oauth_token: 'Claude subscription token (`claude setup-token`, signed in to the account this repo should bill)',
  advisory_token: 'fine-grained PAT: this repository only, "Repository security advisories: Read and write", nothing else',
  private_issue_token: 'fine-grained PAT: the inbox repository only, "Issues: Read and write", nothing else',
};

// Everything later steps need, gathered once (read-only).
function context(opts) {
  const info = ghJson(['api', `repos/${opts.repo}`]);
  const owner = info.owner.login;
  const main = info.default_branch;
  const onMain = readAt(opts.repo, '.pr-review/config.json', main);
  const ref = onMain ? main : opts.branch;
  const raw = onMain ?? readAt(opts.repo, '.pr-review/config.json', opts.branch);
  const config = raw ? JSON.parse(raw) : null;
  const workflowPath = config?.workflowPath ?? '.github/workflows/pr-review.yml';
  const learnPath = config?.learnWorkflowPath ?? '.github/workflows/pr-review-learn.yml';
  const workflows = [readAt(opts.repo, workflowPath, ref), readAt(opts.repo, learnPath, ref)].filter(Boolean);
  return {
    info, owner, main, ref, config, workflowPath, workflows,
    hasLearn: workflows.length > 1,
    channel: config?.securityChannel ?? 'advisory',
    wiring: wiringFrom(workflows),
    secretsSet: new Set((tryJson(['secret', 'list', '-R', opts.repo, '--json', 'name']) ?? []).map((s) => s.name)),
    varsSet: new Map((tryJson(['variable', 'list', '-R', opts.repo, '--json', 'name,value']) ?? []).map((v) => [v.name, v.value])),
    blocked: false,
  };
}

async function preflight(opts, c) {
  say(`\n[preflight] ${opts.repo}`);
  ok(`${c.info.visibility} repository, default branch ${c.main}${c.info.archived ? ' (ARCHIVED)' : ''}`);
  const actions = tryJson(['api', `repos/${opts.repo}/actions/permissions`]);
  if (actions?.enabled) ok(`Actions enabled (allowed: ${actions.allowed_actions})`);
  else (warn('Actions is disabled for this repository'), (c.blocked = true));
  if (!c.config) {
    warn(`no .pr-review/config.json on ${c.main} or ${opts.branch}: nothing to enable`);
    c.blocked = true;
    return;
  }
  ok(`config read from ${c.ref}${c.ref === c.main ? '' : ' (setup branch; not merged yet)'}: visibility ${c.config.visibility ?? '?'}, channel ${c.channel}`);
  ok(`workflow secrets: ${c.wiring.secrets.map((s) => `${s.name} (${s.role})`).join(', ') || 'none found'}; variables: ${c.wiring.vars.map((v) => v.name).join(', ') || 'none'}`);
  const pins = kitPins(c.workflows);
  if (pins.length !== 1) (warn(`expected one kit pin across the workflows, found ${pins.length}`), (c.blocked = true));
  else {
    const status = tryJson(['api', `repos/${KIT}/compare/${pins[0]}...main`])?.status;
    if (['ahead', 'identical'].includes(status)) ok(`kit pin ${pins[0].slice(0, 7)} is on ${KIT} main`);
    else (warn(`kit pin ${pins[0].slice(0, 7)} is not on ${KIT} main (compare: ${status ?? 'unavailable'})`), (c.blocked = true));
  }
  const collaborators = tryJson(['api', `repos/${opts.repo}/collaborators?affiliation=all&per_page=100`]) ?? [];
  const invitations = tryJson(['api', `repos/${opts.repo}/invitations`]) ?? [];
  const risk = writerRisk({ collaborators, invitations, owner: c.owner, visibility: c.info.visibility });
  if (!risk.blocking) ok('no writer other than the owner, no pending write invitation');
  else {
    if (risk.others.length) warn(`others can write: ${risk.others.join(', ')} (set them to Read: Settings → Collaborators)`);
    for (const i of risk.invited) warn(`pending invitation: ${i.login} (${i.permission}); cancel it or re-invite as Read`);
    warn('any writer can read this repo\'s secrets by pushing a branch that edits the workflow');
    if (opts.allowOtherWriters) warn('--allow-other-writers given: continuing anyway');
    else c.blocked = true;
  }
}

async function inbox(opts, c) {
  if (c.channel !== 'private-repo-issue') return;
  say('\n[inbox] private security channel');
  const v = c.wiring.vars.find((x) => x.role === 'private_repo');
  if (!v) return warn('the publish step takes no private_repo variable; check the workflow');
  const name = opts.inbox ?? c.varsSet.get(v.name);
  if (!name) return (warn(`no inbox named: pass --inbox owner/name (sets ${v.name})`), (c.blocked = true));
  let repo = tryJson(['api', `repos/${name}`]);
  if (!repo && !opts.createInbox) return (warn(`${name} does not exist; pass --create-inbox to create it`), (c.blocked = true));
  if (!repo && !opts.apply) say(`  [dry-run] would create private repo ${name} (owner only)`);
  if (!repo && opts.apply) {
    gh(['repo', 'create', name, '--private', '--description', 'Private inbox for pr-review security findings (owner only)']);
    ok(`created private repo ${name}`);
    repo = ghJson(['api', `repos/${name}`]);
  }
  if (repo) {
    if (repo.visibility !== 'private') return (warn(`${name} is ${repo.visibility}; the inbox must be private`), (c.blocked = true));
    const risk = writerRisk({ collaborators: tryJson(['api', `repos/${name}/collaborators?affiliation=all&per_page=100`]) ?? [], invitations: tryJson(['api', `repos/${name}/invitations`]) ?? [], owner: c.owner, visibility: 'private' });
    if (risk.blocking || risk.invited.length) return (warn(`${name} has other collaborators or invitations; it must be owner-only`), (c.blocked = true));
    ok(`${name} is private and owner-only`);
  }
  if (c.varsSet.get(v.name) === name) return ok(`variable ${v.name} already set`);
  if (!opts.apply) return say(`  [dry-run] would set variable ${v.name}=${name}`);
  gh(['variable', 'set', v.name, '-R', opts.repo, '--body', name]);
  ok(`set variable ${v.name}`);
}

async function secrets(opts, c) {
  say('\n[secrets]');
  if (c.blocked) return warn('skipped: preflight or inbox found a blocker');
  for (const s of secretSources(c.wiring, { redactTermsFile: opts.redactTermsFile })) {
    if (c.secretsSet.has(s.name) && !opts.rotate) {
      ok(`${s.name} already set (kept; --rotate to replace)`);
      continue;
    }
    let from;
    if (s.source === 'generate') from = 'a generated 32-byte key';
    else if (s.source === 'file') from = s.file;
    else if (process.env[s.name]) from = `$${s.name}`;
    else if (s.source === 'env-or-skip') {
      warn(`${s.name}: optional; not set (export ${s.name} or pass --redact-terms-file)`);
      continue;
    } else from = 'a hidden prompt';
    if (!opts.apply) {
      say(`  [dry-run] would set ${s.name} (${s.role}) from ${from}`);
      continue;
    }
    let value;
    if (s.source === 'generate') value = randomBytes(32).toString('hex');
    else if (s.source === 'file') value = readFileSync(s.file, 'utf8').trim();
    else value = process.env[s.name] || (await askHidden(`  ${s.name}: ${HINTS[s.role] ?? s.role}\n  value (hidden): `));
    if (!value) {
      warn(`${s.name}: empty value, skipped`);
      continue;
    }
    gh(['secret', 'set', s.name, '-R', opts.repo], { input: value });
    ok(`set ${s.name}`);
  }
}

async function settings(opts, c) {
  say('\n[settings]');
  if (!c.hasLearn) return ok('no learning workflow: nothing to change');
  const cur = tryJson(['api', `repos/${opts.repo}/actions/permissions/workflow`]);
  if (cur?.can_approve_pull_request_reviews) return ok('Actions may already create pull requests');
  if (!opts.apply) return say('  [dry-run] would allow GitHub Actions to create and approve pull requests (default token stays read-only)');
  gh(['api', '-X', 'PUT', `repos/${opts.repo}/actions/permissions/workflow`, '-f', `default_workflow_permissions=${cur?.default_workflow_permissions ?? 'read'}`, '-F', 'can_approve_pull_request_reviews=true']);
  ok('Actions may create pull requests (learning PR)');
}

async function merge(opts, c) {
  say('\n[merge] setup PR');
  if (c.blocked) return warn('skipped: an earlier step found a blocker');
  const number = opts.pr ?? tryJson(['pr', 'list', '-R', opts.repo, '--head', opts.branch, '--state', 'open', '--json', 'number'])?.[0]?.number;
  if (!number) return warn(`no open PR from ${opts.branch}`);
  const pr = ghJson(['pr', 'view', String(number), '-R', opts.repo, '--json', 'isDraft,baseRefName,mergeable,statusCheckRollup,url']);
  const checks = checksReady(pr.statusCheckRollup ?? []);
  if (pr.isDraft || pr.baseRefName !== c.main || pr.mergeable === 'CONFLICTING' || !checks.ready) {
    return warn(`#${number} not ready: draft=${pr.isDraft} base=${pr.baseRefName} mergeable=${pr.mergeable} pending=[${checks.pending}] failed=[${checks.failed}]`);
  }
  const missing = c.wiring.secrets.filter((s) => s.role !== 'redact_terms' && !c.secretsSet.has(s.name)).map((s) => s.name);
  if (missing.length) warn(`secrets still missing (set them before the first real review): ${missing.join(', ')}`);
  const how = { merge: 'with a merge commit', squash: 'squashed', rebase: 'rebased' }[opts.mergeMethod];
  if (!opts.apply) return say(`  [dry-run] would merge ${pr.url} ${how}`);
  gh(['pr', 'merge', String(number), '-R', opts.repo, `--${opts.mergeMethod}`]);
  ok(`merged ${pr.url}`);
}

async function testPr(opts, c) {
  say('\n[test-pr]');
  if (c.blocked) return warn('skipped: an earlier step found a blocker');
  if (!readAt(opts.repo, '.pr-review/config.json', c.main)) return warn(`the reviewer is not on ${c.main} yet: merge the setup PR first`);
  const branch = `pr-review/smoke-${new Date().toISOString().replace(/\D/g, '').slice(0, 12)}`;
  if (!opts.apply) return say(`  [dry-run] would open a docs-only PR from ${branch}, wait up to ${opts.waitMinutes} min for the review, report the summary, then close it`);
  const sha = ghJson(['api', `repos/${opts.repo}/git/ref/heads/${c.main}`]).object.sha;
  gh(['api', '-X', 'POST', `repos/${opts.repo}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`]);
  const body = `# pr-review smoke test\n\nA throwaway file to check the PR reviewer end to end (${new Date().toISOString()}). Do not merge.\n`;
  gh(['api', '-X', 'PUT', `repos/${opts.repo}/contents/docs/pr-review-smoke-test.md`, '-f', 'message=chore: pr-review smoke test (do not merge)', '-f', `content=${Buffer.from(body).toString('base64')}`, '-f', `branch=${branch}`]);
  const url = gh(['pr', 'create', '-R', opts.repo, '--base', c.main, '--head', branch, '--title', 'chore: pr-review smoke test (do not merge)', '--body', 'Throwaway PR opened by pr-review-kit/bin/enable-repo.mjs to check the reviewer end to end. It is closed automatically.']);
  ok(`opened ${url}`);
  const number = url.split('/').pop();
  const deadline = Date.now() + opts.waitMinutes * 60000;
  let run = null;
  while (Date.now() < deadline) {
    const runs = tryJson(['api', `repos/${opts.repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=20`])?.workflow_runs ?? [];
    run = runs.find((r) => r.path === c.workflowPath && r.event === 'pull_request');
    if (run?.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 15000));
  }
  if (run?.status !== 'completed') warn(`the review run did not finish within ${opts.waitMinutes} min${run ? `: ${run.html_url}` : ''}`);
  else (run.conclusion === 'success' ? ok : warn)(`review run ${run.conclusion}: ${run.html_url}`);
  const comments = tryJson(['api', `repos/${opts.repo}/issues/${number}/comments?per_page=100`]) ?? [];
  const summary = comments.find((x) => x.user?.login === BOT_AUTHOR && String(x.body).includes(SUMMARY_MARKER));
  if (summary) ok(`summary posted: ${String(summary.body).split('\n').find((l) => l.trim() && !l.startsWith('<!--'))?.slice(0, 160)}`);
  else warn('no summary comment found (check the run log, the secrets and the Actions setting)');
  if (opts.keepTestPr) return ok(`kept ${url}`);
  gh(['pr', 'close', number, '-R', opts.repo, '--delete-branch']);
  ok('closed the test PR and deleted its branch');
}

const RUN = { preflight, inbox, secrets, settings, merge, 'test-pr': testPr };

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`enable-repo: ${err.message}\n(see the header of bin/enable-repo.mjs; --help)`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  say(`${opts.apply ? 'APPLY' : 'DRY RUN (pass --apply to make changes)'}: ${opts.repo}, steps ${opts.steps.join(', ')}`);
  const c = context(opts);
  // Preflight always runs first: later steps rely on its blockers.
  const steps = ['preflight', ...opts.steps.filter((s) => s !== 'preflight')].sort((a, b) => STEPS.indexOf(a) - STEPS.indexOf(b));
  for (const s of steps) await RUN[s](opts, c);
  say(c.blocked ? '\nBLOCKED: fix the items marked ! above, then re-run.' : `\n${opts.apply ? 'Done.' : 'Dry run complete.'}`);
  process.exit(c.blocked ? 1 : 0);
}

if (!DEFAULT_STEPS.every((s) => STEPS.includes(s))) throw new Error('step list out of sync');
main().catch((err) => {
  console.error(`enable-repo: ${err.message}`);
  process.exit(1);
});

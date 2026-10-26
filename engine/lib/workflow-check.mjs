// Text checks on a consumer's review (or learning) workflow and on the kit
// commit it pins. No YAML parser (Node built-ins only), so comment lines are
// dropped first and every rule is written against GitHub's accepted forms.
import { execFileSync } from 'node:child_process';

const SHA_RE = /^[0-9a-f]{40}$/;
// Which kit action input each secret role may be mapped to.
const ROLES = {
  claude_code_oauth_token: { actions: ['review', 'learn'], what: 'the review or learn action' },
  id_key: { actions: ['publish'], what: 'the publish action' },
  advisory_token: { actions: ['publish'], what: 'the publish action' },
  private_issue_token: { actions: ['publish'], what: 'the publish action' },
  redact_terms: { actions: ['review', 'publish', 'learn'], what: 'the review, publish or learn action' },
};

export const stripComments = (yml) => String(yml ?? '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// Every step chunk, from every steps: block (any indentation).
export function stepsOf(yml) {
  const lines = yml.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*steps:\s*$/.test(lines[i])) continue;
    const base = lines[i].search(/\S/);
    const first = lines.slice(i + 1).find((l) => /^\s*- /.test(l));
    const indent = first ? first.search(/-/) : -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() && l.search(/\S/) <= base) break;
      if (l.search(/\S/) === indent && l.trimStart().startsWith('- ')) out.push(l);
      else if (out.length && l.trim()) out[out.length - 1] += `\n${l}`;
    }
  }
  return out;
}

export const kitAction = (step) => /uses:\s*[\w.-]+\/pr-review-kit\/actions\/([\w-]+)@/.exec(step)?.[1] ?? null;

function checkUses(text, errors) {
  for (const m of text.matchAll(/uses:\s*['"]?([^\s'"]+)/g)) {
    const ref = m[1];
    if (ref.startsWith('./') || ref.startsWith('../')) errors.push(`${ref} is a local action; pin a repository action by SHA`);
    else if (ref.startsWith('docker://')) errors.push(`${ref}: docker actions are not allowed here`);
    else if (!SHA_RE.test(ref.split('@')[1] ?? '')) errors.push(`${ref} is not pinned to a full commit SHA`);
  }
  const pins = [...text.matchAll(/pr-review-kit\/actions\/[\w-]+@([0-9a-f]{40})/g)].map((m) => m[1]);
  if (new Set(pins).size > 1) errors.push('every pr-review-kit action must pin the same kit SHA');
  return pins[0] ?? null;
}

const SECRET = /secrets\.([A-Za-z_][A-Za-z0-9_]*)/g;
const NOT_MAPPED = (name) => `secret ${name} is not mapped to a kit input (only claude_code_oauth_token, id_key, advisory_token, private_issue_token, redact_terms)`;

function checkSecrets(text, steps, errors) {
  const names = (t) => [...t.matchAll(SECRET)].map((m) => m[1]).filter((n) => n !== 'GITHUB_TOKEN');
  const outside = names(text);
  for (const step of steps) {
    for (const line of step.split('\n')) {
      for (const name of names(line)) {
        outside.splice(outside.indexOf(name), 1);
        const key = new RegExp(`^\\s*([\\w-]+):\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}\\s*$`).exec(line)?.[1];
        const role = key ? ROLES[key] : null;
        if (!role || !kitAction(step)) errors.push(NOT_MAPPED(name));
        else if (!role.actions.includes(kitAction(step))) errors.push(`${key} may only be passed to ${role.what}`);
      }
    }
  }
  for (const name of outside) errors.push(NOT_MAPPED(name));
}

function checkReviewShape(text, steps, { securityChannel }, errors, warnings) {
  if (/pull_request_target/.test(text)) errors.push('the review workflow must not use pull_request_target (secrets would reach every PR event)');
  if (!/^\s{2}pull_request:/m.test(text) && !/^on:\s*\[?[^\n]*\bpull_request\b/m.test(text)) errors.push('the review workflow must trigger on pull_request');
  if (!text.includes('github.event.pull_request.head.repo.full_name == github.repository')) errors.push('the job needs the same-repo guard (forks get no secrets)');
  if (!text.includes('!github.event.pull_request.draft')) errors.push('the job must skip draft PRs');
  if (!text.includes("github.actor != 'dependabot[bot]'")) warnings.push('the job does not skip Dependabot (its runs get no secrets)');
  if (/write-all/.test(text)) errors.push('permissions: write-all is not allowed');
  if (/^\s+contents:\s*write\s*$/m.test(text)) errors.push('the review workflow must not grant contents: write');
  if (!/^\s+pull-requests:\s*write\s*$/m.test(text)) errors.push('permissions need pull-requests: write (to post)');
  if (!/timeout-minutes:\s*\d+/.test(text)) errors.push('the job needs timeout-minutes (spend is bounded)');
  const checkouts = steps.filter((s) => /uses:\s*actions\/checkout@/.test(s));
  if (!checkouts.length) errors.push('the job must check out the PR head');
  if (checkouts.some((s) => !/persist-credentials:\s*false/.test(s))) errors.push('every checkout needs persist-credentials: false');
  if (checkouts[0] && !/fetch-depth:\s*0/.test(checkouts[0])) errors.push('the PR head checkout needs fetch-depth: 0 (facts diffs base...head)');
  for (const a of ['review', 'publish']) if (!steps.some((s) => kitAction(s) === a)) errors.push(`the workflow does not use pr-review-kit/actions/${a}`);
  const pub = steps.find((s) => kitAction(s) === 'publish');
  if (pub && !/if:\s*(\$\{\{\s*)?(always\(\)|!cancelled\(\))/.test(pub)) errors.push('the publish step must run with if: always() (a failed review must never look clean)');
  if (pub && !/trust_sha:\s*\$\{\{\s*steps\.[\w-]+\.outputs\.trust_sha\s*\}\}/.test(pub)) errors.push("publish must receive the review action's trust_sha output");
  if (securityChannel !== 'advisory' && /advisory_token:/.test(pub ?? '')) warnings.push(`advisory_token is passed but the security channel is ${securityChannel}`);
  if (securityChannel === 'private-repo-issue' && !/private_repo:\s*\$\{\{\s*vars\./.test(pub ?? '')) errors.push('private-repo-issue needs private_repo from a repository variable (vars.*), never a literal');
}

// kind: "review" (all rules) or "learn" (pins and secret roles only).
export function checkWorkflow(yml, { kind = 'review', securityChannel = 'advisory' } = {}) {
  const errors = [];
  const warnings = [];
  const text = stripComments(yml);
  const steps = stepsOf(text);
  const kitSha = checkUses(text, errors);
  checkSecrets(text, steps, errors);
  if (kind === 'review') checkReviewShape(text, steps, { securityChannel }, errors, warnings);
  return { errors, warnings, kitSha, steps, text };
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// The kit commit a consumer pins: it exists, is on the kit's main branch (no
// imposter commit from a fork), and its actions carry the sandbox.
export function checkKitPin(sha, kitDir) {
  const errors = [];
  try {
    git(['cat-file', '-e', `${sha}^{commit}`], kitDir);
  } catch {
    return [`kit pin ${sha} is not a commit in the kit repository`];
  }
  try {
    git(['merge-base', '--is-ancestor', sha, 'main'], kitDir);
  } catch {
    errors.push(`kit pin ${sha} is not reachable from the kit's main branch`);
  }
  const show = (p) => {
    try {
      return git(['show', `${sha}:${p}`], kitDir);
    } catch {
      return '';
    }
  };
  const review = show('actions/review/action.yml');
  const required = [
    ['--setting-sources user', 'the review model must run with --setting-sources user'],
    ['- name: Neutralize PR head', 'the review action must neutralize the PR head'],
    [',Skill,', 'the review model must be denied the Skill tool'],
    ['Read(./.claude-pr/**)', 'the review model must be denied .claude-pr/'],
    ['--strict-mcp-config', 'the review model must run with --strict-mcp-config'],
    ['"disableAllHooks": true', 'hooks must be disabled for the review model'],
  ];
  for (const [needle, msg] of required) if (!review.includes(needle)) errors.push(`kit ${sha.slice(0, 7)}: ${msg}`);
  for (const a of ['review', 'publish', 'learn', 'propose']) {
    const yml = show(`actions/${a}/action.yml`);
    for (const m of yml.matchAll(/uses:\s*([^\s#]+)/g)) if (!SHA_RE.test(m[1].split('@')[1] ?? '')) errors.push(`kit ${sha.slice(0, 7)}: actions/${a} uses ${m[1]} unpinned`);
  }
  return errors;
}

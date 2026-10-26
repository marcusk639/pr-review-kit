// Consumer self-check (bin/pr-review.mjs validate): the project's
// .claude/pr-review/ and its review workflow keep the properties the engine
// relies on. Text checks only (no YAML parser: Node built-ins only), so they
// are deliberately strict about the example workflow's shape.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_SUBDIR, loadProject } from './lib/config.mjs';
import { validateLearnWorkflow } from './learn/validate-learn.mjs';

const PATH_RE = /^[\w.-]+\/[\w./ -]+\.\w+(:\d+(-\d+)?)?$/;
const PIN_RE = /uses:\s*[\w.-]+\/pr-review-kit\/actions\/([\w-]+)@(\S+)/g;
const SHA_RE = /^[0-9a-f]{40}$/;
const OWNERS = { CLAUDE_CODE_OAUTH_TOKEN: 'review', PR_REVIEW_ID_KEY: 'publish', SECURITY_ADVISORY_TOKEN: 'publish' };

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

function checkKnowledge(root, project, errors) {
  const dir = join(root, PROJECT_SUBDIR);
  const { config } = project;
  if (!existsSync(join(dir, 'REVIEW.md'))) errors.push('.claude/pr-review/REVIEW.md (the project addendum) is missing');
  const texts = {};
  for (const name of config.knowledge) {
    const t = read(join(dir, name));
    if (t == null) errors.push(`knowledge file ${name} is missing`);
    else texts[name] = t;
  }
  const checklist = read(join(dir, 'checklist.md')) ?? '';
  for (const k of config.classes) if (!new RegExp(`^## ${k.id}\\. `, 'm').test(checklist)) errors.push(`checklist.md has no "## ${k.id}. " heading for class ${k.id}`);
  for (const t of project.linkTypes) {
    const n = Object.values(texts).filter((x) => new RegExp(`^## ${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(x)).length;
    if (n === 0) errors.push(`link type ${t} has no "## ${t}" section in any knowledge file`);
    if (n > 1) errors.push(`link type ${t} has a section in ${n} knowledge files (want exactly one)`);
  }
  for (const [name, text] of Object.entries(texts)) {
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const token = m[1].trim();
      if (!PATH_RE.test(token)) continue;
      const path = token.replace(/:\d+(-\d+)?$/, '');
      if (!existsSync(join(root, path)) && !existsSync(join(dir, path))) errors.push(`${name}: ${path} does not exist`);
    }
  }
  for (const rel of config.checks.project) if (!existsSync(join(dir, rel))) errors.push(`project check ${rel} is missing`);
}

// Splits a job's steps into chunks, one per "- " item at the steps' indent.
export function stepsOf(yml) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^\s*steps:\s*$/.test(l));
  if (start < 0) return [];
  const indent = (lines.slice(start + 1).find((l) => /^\s*- /.test(l)) ?? '').search(/-/);
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() && l.search(/\S/) < indent) break;
    if (l.search(/\S/) === indent && l.trimStart().startsWith('- ')) out.push(l);
    else if (out.length) out[out.length - 1] += `\n${l}`;
  }
  return out;
}

const kitAction = (step) => /pr-review-kit\/actions\/([\w-]+)@/.exec(step)?.[1] ?? null;

function checkPins(wf, errors, wanted) {
  const pins = [...wf.matchAll(PIN_RE)].map((m) => ({ action: m[1], ref: m[2] }));
  for (const a of wanted) if (!pins.some((p) => p.action === a)) errors.push(`workflow does not use pr-review-kit/actions/${a}`);
  for (const p of pins) if (!SHA_RE.test(p.ref)) errors.push(`pr-review-kit/actions/${p.action}@${p.ref} is not pinned to a full commit SHA`);
  if (new Set(pins.map((p) => p.ref)).size > 1) errors.push('review and publish must pin the same kit SHA');
  return pins[0]?.ref ?? null;
}

const SECRET = /secrets\.([A-Za-z_][A-Za-z0-9_]*)/g;

function checkSecrets(wf, steps, project, errors, warnings) {
  const inSteps = steps.flatMap((s) => [...s.matchAll(SECRET)].map((m) => ({ name: m[1], step: s })));
  const all = [...wf.matchAll(SECRET)].map((m) => m[1]);
  const outside = [...all];
  for (const { name } of inSteps) outside.splice(outside.indexOf(name), 1);
  for (const name of outside) errors.push(OWNERS[name] ? `${name} may only be passed to the ${OWNERS[name]} step` : `secret ${name} is passed to the review job; it needs only ${Object.keys(OWNERS).join(', ')}`);
  for (const { name, step } of inSteps) {
    const owner = OWNERS[name];
    if (!owner) errors.push(`secret ${name} is passed to the review job; it needs only ${Object.keys(OWNERS).join(', ')}`);
    else if (kitAction(step) !== owner) errors.push(`${name} may only be passed to the ${owner} step`);
  }
  if (project.config.securityChannel !== 'advisory') {
    for (const s of ['SECURITY_ADVISORY_TOKEN', 'PR_REVIEW_ID_KEY']) {
      if (all.includes(s)) warnings.push(`${s} is passed but the security channel is ${project.config.securityChannel}; advisories need a public repo`);
    }
  }
}

function checkReviewWorkflow(root, project, errors, warnings) {
  const path = project.config.workflowPath;
  const wf = read(join(root, path));
  if (wf == null) return errors.push(`workflow ${path} is missing`);
  const steps = stepsOf(wf);
  checkPins(wf, errors, ['review', 'publish']);
  if (/pull_request_target/.test(wf)) errors.push('the review workflow must not use pull_request_target (secrets would reach every PR event)');
  if (!/^\s{2}pull_request:/m.test(wf)) errors.push('the review workflow must trigger on pull_request');
  if (!wf.includes('github.event.pull_request.head.repo.full_name == github.repository')) errors.push('the job needs the same-repo guard (forks get no secrets)');
  if (!wf.includes('!github.event.pull_request.draft')) errors.push('the job must skip draft PRs');
  if (!wf.includes("github.actor != 'dependabot[bot]'")) warnings.push('the job does not skip Dependabot (its runs get no secrets)');
  if (!/^\s+contents: read\s*$/m.test(wf) || /contents: write/.test(wf)) errors.push('permissions must be contents: read');
  if (!/^\s+pull-requests: write\s*$/m.test(wf)) errors.push('permissions need pull-requests: write (to post)');
  if (!/timeout-minutes:\s*\d+/.test(wf)) errors.push('the job needs timeout-minutes (spend is bounded)');
  const checkouts = steps.filter((s) => /uses: actions\/checkout@/.test(s));
  if (!checkouts.length) errors.push('the job must check out the PR head');
  if (checkouts.some((s) => !/persist-credentials: false/.test(s))) errors.push('every checkout needs persist-credentials: false');
  if (checkouts[0] && !/fetch-depth: 0/.test(checkouts[0])) errors.push('the PR head checkout needs fetch-depth: 0 (facts diffs base...head)');
  const pub = steps.find((s) => kitAction(s) === 'publish');
  if (pub && !/if: always\(\)/.test(pub)) errors.push('the publish step must run with if: always() (a failed review must never look clean)');
  checkSecrets(wf, steps, project, errors, warnings);
}

export function validateRepo(root, { workflow } = {}) {
  const errors = [];
  const warnings = [];
  const project = loadProject(join(root, PROJECT_SUBDIR));
  errors.push(...project.errors.map((e) => `config: ${e}`));
  if (workflow) project.config.workflowPath = workflow;
  checkKnowledge(root, project, errors);
  checkReviewWorkflow(root, project, errors, warnings);
  validateLearnWorkflow(root, project, { errors, warnings, stepsOf, checkPins });
  return { errors, warnings };
}

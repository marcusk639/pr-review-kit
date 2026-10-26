// Consumer self-check (bin/pr-review.mjs validate): the project's
// .pr-review/ and its review workflow keep the properties the engine
// relies on. Text checks only (no YAML parser: Node built-ins only), so they
// are deliberately strict about the example workflow's shape.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_SUBDIR, loadProject } from './lib/config.mjs';
import { fileURLToPath } from 'node:url';
import { validateLearnWorkflow } from './learn/validate-learn.mjs';
import { checkKitPin, checkWorkflow } from './lib/workflow-check.mjs';
import { matches } from './lib/glob.mjs';

const PATH_RE = /^[\w.-]+\/[\w./ -]+\.\w+(:\d+(-\d+)?)?$/;
const KIT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

function checkKnowledge(root, project, errors, warnings) {
  const dir = join(root, PROJECT_SUBDIR);
  const { config } = project;
  if (!existsSync(join(dir, 'REVIEW.md'))) errors.push('.pr-review/REVIEW.md (the project addendum) is missing');
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
  for (const rel of config.checks.project) {
    const src = read(join(dir, rel));
    if (src == null) errors.push(`project check ${rel} is missing`);
    // Checks run token-free in a child; spawning from one would reintroduce the PR-code risk.
    else if (/(['"`])(node:)?child_process\1/.test(src)) errors.push(`${rel} imports child_process; use ctx.git or ctx.parseOnly`);
  }
  for (const g of config.learning.forbidden) if (/[*?]/.test(g) && !config.knowledge.some((k) => matches(k, g))) warnings.push(`learning.forbidden ${g} matches no knowledge file`);
}

function checkReviewWorkflow(root, project, errors, warnings, kitDir) {
  const path = project.config.workflowPath;
  const wf = read(join(root, path));
  if (wf == null) return errors.push(`workflow ${path} is missing`);
  const r = checkWorkflow(wf, { kind: 'review', securityChannel: project.config.securityChannel });
  errors.push(...r.errors);
  warnings.push(...r.warnings);
  if (!r.kitSha) return;
  if (kitDir === false) warnings.push('kit pin not checked against a kit repository');
  else if (!existsSync(join(kitDir, '.git'))) warnings.push(`kit pin not checked: ${kitDir} is not a git checkout of the kit`);
  else errors.push(...checkKitPin(r.kitSha, kitDir));
}

// kitDir: a git checkout of pr-review-kit to verify the pin against (default:
// the kit this file belongs to); false skips that check with a warning.
export function validateRepo(root, { workflow, kitDir = KIT_ROOT } = {}) {
  const errors = [];
  const warnings = [];
  const project = loadProject(join(root, PROJECT_SUBDIR));
  errors.push(...project.errors.map((e) => `config: ${e}`));
  if (workflow) project.config.workflowPath = workflow;
  checkKnowledge(root, project, errors, warnings);
  checkReviewWorkflow(root, project, errors, warnings, kitDir);
  validateLearnWorkflow(root, project, { errors, warnings });
  return { errors, warnings };
}

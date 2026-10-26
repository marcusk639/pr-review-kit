// validate for the optional learning workflow: the job holding the Claude
// token has no write permission, the job with the write token has no secret
// and no model, and both pin the same kit SHA as the review workflow.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkWorkflow } from '../lib/workflow-check.mjs';

// The text of each job, split at two-space-indented job ids under "jobs:".
function jobsOf(yml) {
  const start = yml.search(/^jobs:\s*$/m);
  if (start < 0) return [];
  return yml.slice(start).split(/\n(?= {2}[\w-]+:\s*$)/m).slice(1);
}

export function validateLearnWorkflow(root, project, { errors }) {
  const path = project.config.learnWorkflowPath;
  if (!path || !existsSync(join(root, path))) return;
  const r = checkWorkflow(readFileSync(join(root, path), 'utf8'), { kind: 'learn' });
  errors.push(...r.errors.map((e) => `learning workflow: ${e}`));
  const wf = r.text;
  const sha = r.kitSha;
  for (const a of ['learn', 'propose']) if (!new RegExp(`pr-review-kit/actions/${a}@`).test(wf)) errors.push(`the learning workflow does not use pr-review-kit/actions/${a}`);
  const review = existsSync(join(root, project.config.workflowPath)) ? readFileSync(join(root, project.config.workflowPath), 'utf8') : '';
  const reviewSha = /pr-review-kit\/actions\/review@(\S+)/.exec(review)?.[1];
  if (sha && reviewSha && sha !== reviewSha) errors.push('the learning workflow must pin the same kit SHA as the review workflow');
  if (/pull_request/.test(wf)) errors.push('the learning workflow must not run on pull_request events (memory changes land only through its own PR)');
  for (const step of r.steps.filter((x) => /uses:\s*actions\/checkout@/.test(x))) {
    if (!/ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/.test(step)) errors.push('learning workflow: every checkout needs ref: ${{ github.event.repository.default_branch }}');
  }
  for (const job of jobsOf(wf)) {
    if (/pr-review-kit\/actions\/learn@/.test(job) && /^\s+[\w-]+: write\s*$/m.test(job.replace(/^\s+id-token: write\s*$/m, ''))) errors.push('the learn job must not have write permissions (it runs the model)');
    if (/pr-review-kit\/actions\/propose@/.test(job) && /secrets\./.test(job)) errors.push('the propose job must not receive secrets');
    if (/pr-review-kit\/actions\/propose@/.test(job) && /claude-code-action|actions\/learn@/.test(job)) errors.push('the propose job must not run a model');
  }
}

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
  // Line-based (no backtracking regex): the block under a top-level key.
  const block = (key) => {
    const lines = wf.split('\n');
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at < 0) return { inline: '', body: [] };
    const body = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() && !/^\s/.test(l)) break;
      body.push(l);
    }
    return { inline: lines[at].slice(key.length + 1).trim(), body };
  };
  const on = block('on');
  const triggers = on.inline ? on.inline.replace(/[[\]]/g, '').split(',').map((t) => t.trim()).filter(Boolean) : on.body.map((l) => /^ {2}([\w-]+):/.exec(l)?.[1]).filter(Boolean);
  if (!triggers.length || triggers.some((t) => !['schedule', 'workflow_dispatch'].includes(t))) errors.push('the learning workflow must trigger on schedule and workflow_dispatch only');
  if (/write-all/.test(wf)) errors.push('learning workflow: permissions: write-all is not allowed');
  const perms = block('permissions');
  if (/write/.test(perms.inline) || perms.body.some((l) => /write/.test(l))) errors.push('learning workflow: no workflow-level write permission (grant contents/pull-requests write to the propose job only)');
  for (const step of r.steps.filter((x) => /uses:\s*actions\/checkout@/.test(x))) {
    if (!/ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/.test(step)) errors.push('learning workflow: every checkout needs ref: ${{ github.event.repository.default_branch }}');
    if (!/persist-credentials:\s*false/.test(step)) errors.push('learning workflow: every checkout needs persist-credentials: false');
  }
  for (const job of jobsOf(wf)) {
    if (/pr-review-kit\/actions\/learn@/.test(job) && /\b(?!id-token)[\w-]+:\s*write\b/.test(job.replace(/id-token:\s*write/g, ''))) errors.push('the learn job must not have write permissions (it runs the model)');
    if (/pr-review-kit\/actions\/propose@/.test(job) && /secrets\./.test(job)) errors.push('the propose job must not receive secrets');
    if (/pr-review-kit\/actions\/propose@/.test(job) && /claude-code-action|actions\/learn@/.test(job)) errors.push('the propose job must not run a model');
  }
}

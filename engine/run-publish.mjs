// Publish entry point. Loads the project from a fresh base checkout
// (PR_REVIEW_PUBLISH, default .review-publish) and publishes, or with
// --dry-run (PR_REVIEW_DRY_RUN=1) prints what it would post. Secrets
// (PR_REVIEW_ID_KEY, ADVISORY_TOKEN) are read here and nowhere else. Always
// exits 0; logs status codes only.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ghRequest, listIssueComments, listReviewComments, upsertSummary } from './lib/gh.mjs';
import { runPaths } from './lib/paths.mjs';
import { stepSummary, warn } from './lib/status.mjs';
import { PROJECT_SUBDIR, setActiveProject } from './lib/config.mjs';
import { loadReviewProject } from './lib/project.mjs';
import { dryRunDeps } from './lib/dry-run.mjs';
import { publish } from './publish.mjs';
import { statusOf } from './lib/summary-post.mjs';

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// Reads facts' snapshot (STATE_FILE, outside the model's --add-dir), never
// OUT/state.json, which the model can overwrite.
function readState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// opts: { dryRun, write, showPrivate, assumePrivateVerified, findingsPath, summaryPath, inlinePath }
export async function runPublish(env = process.env, opts = {}) {
  const projectDir = join(resolve(env.PR_REVIEW_PUBLISH || '.review-publish'), PROJECT_SUBDIR);
  const project = loadReviewProject(projectDir);
  if (project.errors.length) {
    // No trusted config means no trusted classes or channel: post nothing.
    warn('project config missing or invalid on the base branch; nothing published');
    stepSummary('skipped: project config missing or invalid on the base branch');
    return 'skipped: project config';
  }
  setActiveProject(project);
  const { REPO, PR, HEAD_SHA, BASE_SHA, ACTION_OUTCOME, EXECUTION_FILE, PR_REVIEW_ID_KEY, ADVISORY_TOKEN, RUN_STARTED_AT } = env;
  // Fail closed without OUT and STATE_FILE: no snapshot, no model output, so
  // the failure banner (prior state from the comment) or nothing at all.
  const run = runPaths(env);
  if (!run) warn('OUT or STATE_FILE unset; publishing the failure banner only');
  const fromOut = (name, override) => (override !== undefined ? (override ? readOptional(override) : null) : run ? readOptional(join(run.out, name)) : null);
  const deps = opts.dryRun
    ? dryRunDeps({ write: opts.write, headSha: HEAD_SHA, env, showPrivate: opts.showPrivate, assumePrivateVerified: opts.assumePrivateVerified })
    : { listIssueComments, upsertSummary, listReviewComments, request: ghRequest };
  return publish({
    repo: REPO,
    pr: PR,
    snapshot: run ? readState(run.stateFile) : null,
    findingsText: fromOut('findings.json', opts.findingsPath),
    inlineText: fromOut('inline.json', opts.inlinePath),
    // null when the model never wrote it: the review is then not complete.
    narrative: fromOut('summary.md', opts.summaryPath),
    outcome: ACTION_OUTCOME,
    executionLog: EXECUTION_FILE ? readOptional(EXECUTION_FILE) : null,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    runStartedAt: RUN_STARTED_AT || null,
    idKey: PR_REVIEW_ID_KEY || null,
    // Advisory requests only; never passed to the summary comment calls.
    advisoryToken: ADVISORY_TOKEN || null,
  }, deps);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run') || process.env.PR_REVIEW_DRY_RUN === '1';
  try {
    await runPublish(process.env, { dryRun, showPrivate: process.argv.includes('--show-private') });
  } catch (err) {
    // Never log bodies, tokens or messages; status only.
    warn(`publish failed (${statusOf(err)})`);
    stepSummary(`publish failed (${statusOf(err)})`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

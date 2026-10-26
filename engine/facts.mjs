// Facts step: runs from the kit's pinned action path, against the PR-head
// working tree, with the project (config, routing, project checks, learned
// precision) read from the base checkout at PR_REVIEW_BASE. Writes the model's
// material into OUT and a read-only trusted snapshot to STATE_FILE. Never
// fails the job: a broken pre-check is "unavailable", a missing or invalid
// project config means tier "none" (no review).
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prDiff } from './lib/diff.mjs';
import { route } from './lib/routing.mjs';
import { redact } from './lib/redact.mjs';
import { ghRequest, listIssueComments, listReactions, listReviewComments } from './lib/gh.mjs';
import { loadState } from './lib/state.mjs';
import { classify, maxTurnsFor } from './lib/tier.mjs';
import { computeIncrement } from './lib/increment.mjs';
import { writeMaterial } from './lib/material.mjs';
import { SUMMARY_MARKER } from './lib/markers.mjs';
import { runPaths } from './lib/paths.mjs';
import { PROJECT_SUBDIR, activeProject, setActiveProject } from './lib/config.mjs';
import { loadReviewProject } from './lib/project.mjs';
import { loadProjectChecks, runProjectChecks } from './lib/project-checks.mjs';
import { buildFacts } from './lib/facts-render.mjs';
import { checkSecrets, checkPiiLogs, checkNewFileSize, checkTitleScope, checkSelfEdit, checkEnginePin, runVerifyDiff } from './hygiene.mjs';

export { buildFacts };

const MAX_COMMENT = 2000;
const MAX_CHANGED = 3000;
const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));

// Only maintainers' words reach the model (config.trust.contextAssociations):
// in a public repo any other commenter could otherwise plant instructions.
const trusted = (x) => activeProject().config.trust.contextAssociations.includes(x?.author_association);

export async function gatherContext(repo, pr, pull, list = listIssueComments) {
  try {
    const body = trusted(pull)
      ? `PR description:\n${redact(String(pull?.body ?? ''))}`
      : 'PR description withheld: the PR author is not a repository maintainer.';
    const comments = (await list(repo, pr)).filter((c) => trusted(c) && !String(c.body ?? '').startsWith(SUMMARY_MARKER));
    const parts = [body];
    for (const c of comments) parts.push(`Comment:\n${redact(String(c.body ?? '')).slice(0, MAX_COMMENT)}`);
    return parts.join('\n\n');
  } catch {
    return 'PR context unavailable';
  }
}

const readOr = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

function runChecks({ files, repoRoot, baseSha, headSha, title, baseDir, projectChecks }) {
  const config = activeProject().config;
  const verify = config.checks.verifyDiff ? join(baseDir, config.checks.verifyDiff.script) : null;
  const checks = [
    ['checkSecrets', () => checkSecrets(files)],
    ['checkPiiLogs', () => checkPiiLogs(files)],
    ['checkNewFileSize', () => checkNewFileSize(files, repoRoot)],
    ['checkTitleScope', () => checkTitleScope(title)],
    ['checkSelfEdit', () => checkSelfEdit(files)],
    ['checkEnginePin', () => checkEnginePin({ base: readOr(join(baseDir, config.workflowPath)), head: readOr(join(repoRoot, config.workflowPath)) })],
    ['runVerifyDiff', () => runVerifyDiff(baseSha, repoRoot, verify, headSha)],
  ];
  const builtin = checks.map(([check, fn]) => {
    try {
      return { check, facts: fn() };
    } catch (error) {
      return { check, error };
    }
  });
  return [...builtin, ...runProjectChecks(projectChecks, { files, repoRoot, baseSha, headSha, title, config })];
}

function tierOutput(tier, maxTurns) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tier=${tier}\nmax_turns=${maxTurns}\n`);
}

const UNAVAILABLE_RE = /(^|\s)unavailable(:|$)/;

// Checks that did not run: they threw, or reported themselves unavailable.
export function unavailableChecks(results) {
  return results.filter((r) => r.error || (r.facts ?? []).some((f) => UNAVAILABLE_RE.test(String(f.note ?? '')))).map((r) => r.check);
}

// The snapshot (STATE_FILE) is a copy outside the model's --add-dir: publish
// trusts only this one, since the model can Write OUT/state.json.
function writeOutputs({ out, stateFile }, text, state) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'facts.md'), text);
  writeFileSync(join(out, 'state.json'), JSON.stringify(state, null, 2));
  // The kit's generic procedure, from the pinned engine (the model reads it from OUT).
  copyFileSync(join(ENGINE_DIR, 'REVIEW.md'), join(out, 'REVIEW.md'));
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state));
    // Read-only from here on; the workflow's cleanup restores write before rm.
    chmodSync(stateFile, 0o444);
    chmodSync(dirname(stateFile), 0o555);
  } catch {
    process.stdout.write('facts: state snapshot unavailable\n');
  }
  tierOutput(state.tier, state.maxTurns);
}

// This run's routed link types (the files it considered) ride in both
// OUT/state.json and the snapshot; publish adds them to linkTypesSeen on success.
export function recordRun(state, tier, routeResult, results = []) {
  return Object.assign(state, { tier, maxTurns: maxTurnsFor(tier), runLinkTypes: [...(routeResult?.linkTypes ?? [])], unavailableChecks: unavailableChecks(results) });
}

function recordMaterial(state, m) {
  state.prDiffAvailable = m.prDiff;
  state.prDiffTruncated = m.prDiffTruncated;
}

// PR_REVIEW_OFFLINE (local runs and tests): no GitHub calls, prior state empty.
function githubDeps(env) {
  if (env.PR_REVIEW_OFFLINE) return { listIssueComments: async () => [], listReviewComments: async () => [], listReactions: async () => [], pull: async () => null };
  return { listIssueComments, listReviewComments, listReactions, pull: (repo, pr) => ghRequest('GET', `/repos/${repo}/pulls/${pr}`) };
}

// The project from the base checkout, or null (then: tier none, no review).
export async function prepareProject(baseDir) {
  const dir = join(baseDir, PROJECT_SUBDIR);
  if (!existsSync(join(dir, 'config.json'))) return { project: null, why: 'no .claude/pr-review/config.json on the base branch yet' };
  const project = loadReviewProject(dir);
  if (project.errors.length) return { project: null, why: `invalid project config: ${project.errors.slice(0, 5).join('; ')}` };
  const loaded = await loadProjectChecks(dir, project.config.checks.project);
  project.projectChecks = loaded.checks;
  project.loadErrors = loaded.errors;
  return { project };
}

async function main() {
  const env = process.env;
  const { REPO, PR, BASE_SHA, HEAD_SHA, PR_TITLE } = env;
  const run = runPaths();
  if (!run) {
    // Fail closed: no material, no snapshot, and the review step is skipped.
    process.stdout.write('facts failed: OUT or STATE_FILE unset\n');
    return tierOutput('none', 0);
  }
  const baseDir = resolve(env.PR_REVIEW_BASE || '.review-base');
  const { project, why } = await prepareProject(baseDir);
  if (!project) {
    process.stdout.write(`pr-review: ${redact(why)}; review skipped\n`);
    return tierOutput('none', 0);
  }
  setActiveProject(project);
  const deps = githubDeps(env);
  const { out } = run;
  const state = {
    lastReviewedSha: null,
    lastBaseSha: null,
    ledger: [],
    linkTypesSeen: [],
    runLinkTypes: [],
    inlineSlugs: [],
    // The PR's changed paths: publish posts inline comments only on these.
    changedFiles: [],
    tier: 'full',
    maxTurns: maxTurnsFor('full'),
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    pr: Number(PR),
    visibility: project.config.visibility,
    securityChannel: project.config.securityChannel,
    // The inline guard's fallback run start when the workflow's is missing.
    runStartedAt: new Date().toISOString(),
    // Whether OUT/pr.diff holds the real, whole diff; otherwise the review is labelled partial.
    prDiffAvailable: false,
    prDiffTruncated: false,
  };
  const loadFailures = (project.loadErrors ?? []).map((e) => ({ check: 'projectChecks', error: new Error(e) }));
  try {
    Object.assign(state, await loadState(REPO, PR, deps));
    const repoRoot = process.cwd();
    const prFiles = prDiff(BASE_SHA, HEAD_SHA, repoRoot);
    const paths = [...new Set(prFiles.flatMap((f) => [f.oldFile, f.file]).filter(Boolean))];
    state.changedFiles = paths.slice(0, MAX_CHANGED);
    const inc = computeIncrement({ ...state, baseSha: BASE_SHA, headSha: HEAD_SHA, prPaths: paths, cwd: repoRoot });
    const tier = classify({ ...state, ...inc, prFileCount: paths.length });
    const files = tier === 'full' ? prFiles : inc.incrementDiff;
    const factPaths = [...new Set(files.flatMap((f) => [f.oldFile, f.file]).filter(Boolean))];
    const checked = tier === 'none' ? [] : runChecks({ files, repoRoot, baseSha: BASE_SHA, headSha: HEAD_SHA, title: PR_TITLE, baseDir, projectChecks: project.projectChecks });
    const results = [...checked, ...(tier === 'none' ? [] : loadFailures)];
    let pull = null;
    try {
      pull = await deps.pull(REPO, PR);
    } catch {
      pull = null;
    }
    const prContext = pull ? await gatherContext(REPO, PR, pull, deps.listIssueComments) : 'PR context unavailable';
    mkdirSync(out, { recursive: true });
    if (tier !== 'none') recordMaterial(state, writeMaterial(out, { baseSha: BASE_SHA, headSha: HEAD_SHA, tier, incrementText: inc.incrementText, cwd: repoRoot }));
    const routeResult = route(factPaths);
    recordRun(state, tier, routeResult, results);
    const text = buildFacts({ files, routeResult, results, prContext, title: PR_TITLE, tier, driftFiles: inc.driftFiles, project, feedback: state.feedback });
    writeOutputs(run, text, state);
  } catch (err) {
    process.stdout.write(`facts failed: ${err?.name ?? 'Error'}\n`);
    const empty = { packages: [], linkTypes: [], classes: [] };
    recordRun(state, 'full', empty, [{ check: 'facts', error: err }]);
    try {
      mkdirSync(out, { recursive: true });
      recordMaterial(state, writeMaterial(out, { baseSha: BASE_SHA, headSha: HEAD_SHA, tier: 'full', cwd: process.cwd() }));
    } catch {
      // the model reports the missing material
    }
    writeOutputs(run, buildFacts({ routeResult: empty, results: [{ check: 'facts', error: err }], prContext: 'PR context unavailable', title: PR_TITLE, tier: 'full', project }), state);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(() => process.stdout.write('facts failed: Error\n')).finally(() => { process.exitCode = 0; });
}

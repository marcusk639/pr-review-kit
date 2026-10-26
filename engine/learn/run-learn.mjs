// Learning job entry points, run from the kit's pinned action path in a
// checkout of the default branch (the project is read from there):
//   collect  model-free: trusted feedback → candidates. Writes the model's
//            material to OUT and a trusted snapshot (LEARN_STATE) outside it.
//   apply    model-free: validates OUT/proposals.json (or distills
//            deterministically) against the snapshot, never against OUT, and
//            writes the proposed files plus the PR body to OUT/bundle.
// Neither step holds a write token; the propose action opens the PR.
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROJECT_SUBDIR, loadProject, setActiveProject } from '../lib/config.mjs';
import { ghRequest, listIssueComments, listReactions, listReviewComments } from '../lib/gh.mjs';
import { collect } from './collect.mjs';
import { buildCandidates } from './candidates.mjs';
import { applyProposals, deterministicProposals } from './apply.mjs';
import { mergePrecision, readPrecision, renderPrecision } from './precision.mjs';
import { renderKnowledge, renderPrBody } from './render.mjs';

const ENGINE = dirname(dirname(fileURLToPath(import.meta.url)));
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const readJson = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};
const lessonsOf = (dir) => {
  const l = readJson(join(dir, 'learned/lessons.json'), null);
  return Array.isArray(l?.lessons) ? l.lessons : [];
};

export function prepareLearn({ project, records, recordsByPr, out, snapshot }) {
  const { candidates, unresolved } = buildCandidates(records, project.config, lessonsOf(project.dir));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'candidates.json'), json(candidates));
  writeFileSync(join(out, 'knowledge-files.json'), json(project.config.knowledge));
  copyFileSync(join(ENGINE, 'DISTILL.md'), join(out, 'DISTILL.md'));
  mkdirSync(dirname(snapshot), { recursive: true });
  rmSync(snapshot, { force: true });
  writeFileSync(snapshot, JSON.stringify({ candidates, unresolved, recordsByPr }));
  chmodSync(snapshot, 0o444);
  return { candidates: candidates.length, unresolved: unresolved.length };
}

function proposalsFor(distill, out, candidates, config, notes) {
  if (distill !== 'model' || !candidates.length) return deterministicProposals(candidates, config);
  const p = readJson(join(out, 'proposals.json'), null);
  if (Array.isArray(p)) return p;
  notes.push('model proposals unusable; deterministic distillation used');
  return deterministicProposals(candidates, config);
}

// files: the repository's tracked files (pruning); root: the checkout.
export function finishLearn({ project, root, out, snapshot, files, today, distill = project.config.learning.distill }) {
  const { config, dir } = project;
  const snap = readJson(snapshot, { candidates: [], unresolved: [], recordsByPr: {} });
  const notes = [];
  const before = lessonsOf(dir);
  const result = applyProposals({ lessons: before, candidates: snap.candidates, proposals: proposalsFor(distill, out, snap.candidates, config, notes), config, files, today });
  if (config.visibility === 'public') {
    // Held security lessons are committed without their text in a public repo.
    for (const l of result.lessons) if (l.status === 'needs-decision' && /security/.test(l.why ?? '')) l.rule = '(withheld: see the sources)';
  }
  const priorPrecision = readPrecision(dir);
  const precision = mergePrecision(priorPrecision, snap.recordsByPr);
  const texts = Object.fromEntries(config.knowledge.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
  const rendered = renderKnowledge(texts, result.lessons);
  const proposed = {
    [`${PROJECT_SUBDIR}/learned/lessons.json`]: [json({ version: 1, lessons: result.lessons }), JSON.stringify(before) !== JSON.stringify(result.lessons)],
    [`${PROJECT_SUBDIR}/learned/precision.json`]: [json(precision), JSON.stringify(priorPrecision.byPr) !== JSON.stringify(precision.byPr)],
    ...Object.fromEntries(Object.entries(rendered).map(([f, t]) => [`${PROJECT_SUBDIR}/${f}`, [t, t !== texts[f]]])),
  };
  const changed = Object.entries(proposed).filter(([, [, c]]) => c).map(([p]) => p);
  const body = renderPrBody({ ...result, unresolved: [...snap.unresolved, ...result.unresolved], precisionMd: renderPrecision(precision, config), config, notes });
  const bundle = join(out, 'bundle');
  rmSync(bundle, { recursive: true, force: true });
  for (const p of changed) {
    mkdirSync(dirname(join(bundle, p)), { recursive: true });
    writeFileSync(join(bundle, p), proposed[p][0]);
  }
  const manifest = { hasChanges: changed.length > 0, files: changed, lessons: { added: result.added.length, replaced: result.replaced.length, pruned: result.pruned.length, flagged: result.flagged.length } };
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'pr-body.md'), body);
  writeFileSync(join(bundle, 'manifest.json'), json(manifest));
  return { manifest, body, root };
}

const DAY = 86400000;
// PRs by most recent update, stopping once past the window.
async function listPulls(repo, windowDays, now = Date.now()) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const items = await ghRequest('GET', `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`);
    if (!Array.isArray(items) || !items.length) break;
    all.push(...items);
    if (items.length < 100 || Date.parse(items[items.length - 1].updated_at) < now - windowDays * DAY) break;
  }
  return all;
}

async function main(cmd, env = process.env) {
  const root = resolve(env.PR_REVIEW_LEARN_ROOT || '.');
  const project = loadProject(join(root, PROJECT_SUBDIR));
  if (project.errors.length) {
    console.log('::warning::pr-review learning skipped: project config missing or invalid');
    return;
  }
  setActiveProject(project);
  const out = env.OUT;
  const snapshot = env.LEARN_STATE;
  if (!out || !snapshot) throw new Error('OUT and LEARN_STATE are required');
  if (cmd === 'collect') {
    const deps = { listPulls: (repo) => listPulls(repo, project.config.learning.windowDays), listIssueComments, listReviewComments, listReactions };
    const { records, recordsByPr, pulls } = await collect({ repo: env.REPO, project, deps });
    const r = prepareLearn({ project, records, recordsByPr, out, snapshot });
    console.log(`learn collect: ${pulls} PR(s), ${records.length} trusted feedback record(s), ${r.candidates} candidate(s), ${r.unresolved} unresolved`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `candidates=${r.candidates}\ndistill=${project.config.learning.distill}\n`);
  } else if (cmd === 'apply') {
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
    const { manifest, body } = finishLearn({ project, root, out, snapshot, files, today: new Date().toISOString().slice(0, 10) });
    console.log(`learn apply: ${JSON.stringify(manifest.lessons)}; ${manifest.files.length} file(s) changed`);
    if (env.PR_REVIEW_DRY_RUN === '1') process.stdout.write(`\n=== learning PR body ===\n${body}\n`);
  } else throw new Error(`unknown learn command ${cmd}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch((err) => {
    // Status only: never bodies or tokens.
    console.log(`::warning::pr-review learning failed (${Number.isInteger(err?.status) ? err.status : err?.message?.slice(0, 80) ?? 'error'})`);
    process.exitCode = 1;
  });
}

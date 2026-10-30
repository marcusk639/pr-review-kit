#!/usr/bin/env node
// Helpers for the review action's opt-in Serena step, run as the runner user
// with the project from the trust checkout (PR_REVIEW_BASE):
//   files            NUL-separated tracked paths for Serena's source copy, on stdout
//   project-files    NUL-separated .pr-review/ paths of the trust checkout for the
//                    copy (relative to it): no .serena/, no withheld paths
//   check            the lockdown rules validate enforces on .pr-review/serena/
//   warmup <dir>     one throwaway file per language server in the base
//                    .pr-review/serena/project.yml, written into <dir>
// Exits non-zero on any problem; the step then reviews without Serena.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from './lib/diff.mjs';
import { matches } from './lib/glob.mjs';
import { PROJECT_SUBDIR, loadProject } from './lib/config.mjs';
import { checkSerenaConfig, languageServers, warmupFiles } from './lib/serena-check.mjs';

export { languageServers, warmupFiles, WARMUP } from './lib/serena-check.mjs';

// Never copied, whatever the config: Serena's own state, the reviewer project
// (the base copy is added separately) and the action's checkouts.
const ALWAYS_EXCLUDED = [/(^|\/)\.serena\//, new RegExp(`^${PROJECT_SUBDIR.replace('.', '\\.')}/`), /^\.review-(base|publish)\//, /^\.pr-review-external\//, /^\.claude-pr\//];

// Tracked paths minus the always-excluded ones, any path with a segment in
// config.serena.exclude, and config.withheld paths (Serena would show them).
export function copyList(paths, config) {
  const segments = new Set(config.serena.exclude);
  return paths.filter((p) => p && !ALWAYS_EXCLUDED.some((re) => re.test(p)) && !p.split('/').slice(0, -1).some((s) => segments.has(s)) && !config.withheld.some((g) => matches(p, g)));
}

// The trust checkout's own .pr-review/ files (tracked there): no Serena state,
// no withheld paths. Paths are relative to the trust checkout root.
export function projectCopyList(paths, config) {
  const prefix = `${PROJECT_SUBDIR}/`;
  return paths.filter((p) => p.startsWith(prefix) && !/(^|\/)\.serena\//.test(p) && !config.withheld.some((g) => matches(p, g)));
}

function main() {
  const [cmd, dir] = process.argv.slice(2);
  const projectDir = join(resolve(process.env.PR_REVIEW_BASE || '.review-base'), PROJECT_SUBDIR);
  const project = loadProject(projectDir);
  if (project.errors.length) throw new Error('project config invalid');
  if (cmd === 'check') {
    const errors = checkSerenaConfig(join(projectDir, 'serena'));
    for (const e of errors) process.stderr.write(`serena-prep: ${e}\n`);
    if (errors.length) process.exitCode = 1;
  } else if (cmd === 'project-files') {
    const paths = git(['ls-files', '-z', '--', PROJECT_SUBDIR], resolve(process.env.PR_REVIEW_BASE || '.review-base')).split('\0');
    process.stdout.write(projectCopyList(paths, project.config).map((p) => `${p}\0`).join(''));
  } else if (cmd === 'files') {
    const paths = git(['ls-files', '-z'], process.cwd()).split('\0');
    process.stdout.write(copyList(paths, project.config).map((p) => `${p}\0`).join(''));
  } else if (cmd === 'warmup' && dir) {
    const files = warmupFiles(languageServers(readFileSync(join(projectDir, 'serena', 'project.yml'), 'utf8')));
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of files) writeFileSync(join(dir, name), text);
  } else {
    throw new Error('usage: serena-prep.mjs files | project-files | check | warmup <dir>');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`serena-prep: ${err?.message ?? 'Error'}\n`);
    process.exitCode = 1;
  }
}

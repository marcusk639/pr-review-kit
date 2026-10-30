#!/usr/bin/env node
// Helpers for the review action's opt-in Serena step, run as the runner user
// with the project from the trust checkout (PR_REVIEW_BASE):
//   files            NUL-separated tracked paths for Serena's source copy, on stdout
//   warmup <dir>     one throwaway file per language server in the base
//                    .pr-review/serena/project.yml, written into <dir>
// Exits non-zero on any problem; the step then reviews without Serena.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from './lib/diff.mjs';
import { matches } from './lib/glob.mjs';
import { PROJECT_SUBDIR, loadProject } from './lib/config.mjs';

// Never copied, whatever the config: Serena's own state, the reviewer project
// (the base copy is added separately) and the action's checkouts.
const ALWAYS_EXCLUDED = [/(^|\/)\.serena\//, new RegExp(`^${PROJECT_SUBDIR.replace('.', '\\.')}/`), /^\.review-(base|publish)\//, /^\.pr-review-external\//, /^\.claude-pr\//];

// A file per language server, so each server is downloaded while the network
// is still on; none can be fetched once it is blocked.
export const WARMUP = {
  typescript: ['warmup.ts', 'export const warmup = 1;\n'],
  markdown: ['warmup.md', '# Warmup\n\nText.\n'],
  yaml: ['warmup.yaml', 'warmup: true\n'],
  json: ['warmup.json', '{ "warmup": true }\n'],
  python: ['warmup.py', 'warmup = 1\n'],
  bash: ['warmup.sh', 'warmup=1\n'],
};

// Tracked paths minus the always-excluded ones, any path with a segment in
// config.serena.exclude, and config.withheld paths (Serena would show them).
export function copyList(paths, config) {
  const segments = new Set(config.serena.exclude);
  return paths.filter((p) => p && !ALWAYS_EXCLUDED.some((re) => re.test(p)) && !p.split('/').slice(0, -1).some((s) => segments.has(s)) && !config.withheld.some((g) => matches(p, g)));
}

// language_servers from project.yml, inline ([a, b]) or as a block list.
export function languageServers(yml) {
  const text = String(yml ?? '');
  const inline = /^language_servers:[ \t]*\[([^\]\n]*)\]/m.exec(text);
  const raw = inline
    ? inline[1].split(',')
    : (/^language_servers:[ \t]*\n((?:[ \t]*-[^\n]*\n?)+)/m.exec(text)?.[1] ?? '').split('\n').map((l) => l.replace(/^\s*-\s*/, ''));
  return raw.map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

export function warmupFiles(languages) {
  if (!languages.length) throw new Error('project.yml lists no language_servers');
  const unknown = languages.filter((l) => !(l in WARMUP));
  if (unknown.length) throw new Error(`no warmup file for language server(s): ${unknown.join(', ')}`);
  return languages.map((l) => WARMUP[l]);
}

function main() {
  const [cmd, dir] = process.argv.slice(2);
  const projectDir = join(resolve(process.env.PR_REVIEW_BASE || '.review-base'), PROJECT_SUBDIR);
  const project = loadProject(projectDir);
  if (project.errors.length) throw new Error('project config invalid');
  if (cmd === 'files') {
    const paths = git(['ls-files', '-z'], process.cwd()).split('\0');
    process.stdout.write(copyList(paths, project.config).map((p) => `${p}\0`).join(''));
  } else if (cmd === 'warmup' && dir) {
    const files = warmupFiles(languageServers(readFileSync(join(projectDir, 'serena', 'project.yml'), 'utf8')));
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of files) writeFileSync(join(dir, name), text);
  } else {
    throw new Error('usage: serena-prep.mjs files | warmup <dir>');
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

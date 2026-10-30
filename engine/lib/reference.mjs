// config.referenceFiles: base-branch copies of files the knowledge cites as a
// source of truth but the model may not load as instructions (CLAUDE.md,
// AGENTS.md, .claude/rules/). Read from git objects at the trust SHA (never a
// symlink), they land under <OUT>/reference/ with a .ref suffix and any
// .claude segment renamed dot-claude, so no tool treats them as config. The
// model reads them as data. Withheld paths are never copied.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listAt, readAt } from './git-read.mjs';
import { isWithheld } from './withheld.mjs';
import { matches } from './glob.mjs';

export const MAX_REFERENCE_FILES = 200;
export const MAX_REFERENCE_BYTES = 256 * 1024;
export const MAX_REFERENCE_TOTAL = 2 * 1024 * 1024;

export const referenceName = (path) => `${path.split('/').map((s) => (s === '.claude' ? 'dot-claude' : s)).join('/')}.ref`;

// Returns { files: [{ path, ref }], skipped } (ref relative to OUT).
export function writeReference(out, baseSha, cwd, project) {
  const globs = project.config.referenceFiles;
  const files = [];
  let skipped = 0;
  if (!globs.length) return { files, skipped };
  // One listing of the trust tree, matched against every glob.
  const paths = listAt(baseSha, '**', cwd).filter((p) => globs.some((g) => matches(p, g)) && !isWithheld(p, project)).sort();
  const used = new Set();
  let total = 0;
  for (const path of paths) {
    // Two paths can map to one name (.claude/x and dot-claude/x): keep the first.
    if (used.has(referenceName(path))) {
      skipped++;
      continue;
    }
    const text = files.length < MAX_REFERENCE_FILES ? readAt(baseSha, path, cwd) : null;
    const size = text == null ? 0 : Buffer.byteLength(text);
    if (text == null || size > MAX_REFERENCE_BYTES || total + size > MAX_REFERENCE_TOTAL) {
      skipped++;
      continue;
    }
    const ref = join('reference', referenceName(path));
    mkdirSync(dirname(join(out, ref)), { recursive: true });
    writeFileSync(join(out, ref), text);
    total += size;
    used.add(referenceName(path));
    files.push({ path, ref });
  }
  return { files, skipped };
}

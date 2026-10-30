// RIGHT-side hunk ranges of the PR diff, per changed file (new path). facts
// stores them in the trusted snapshot; publish posts a suggestion only when
// its lines sit inside one of them (spec addendum §4.2). A range covers the
// hunk's added and context lines: [newStart, newStart + newCount - 1].
import { parseUnifiedDiff, prDiffText } from './diff.mjs';

export const MAX_HUNKS_PER_FILE = 500;
const MAX_FILES = 3000;
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function hunkRanges(text) {
  const out = {};
  let files = 0;
  for (const chunk of String(text ?? '').split(/(?=^diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const [f] = parseUnifiedDiff(chunk);
    if (!f || f.status === 'D' || f.binary || !f.file) continue;
    const ranges = [];
    for (const line of chunk.split('\n')) {
      const m = HUNK_RE.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0 && start > 0 && ranges.length < MAX_HUNKS_PER_FILE) ranges.push([start, start + count - 1]);
    }
    if (!ranges.length) continue;
    if (files++ >= MAX_FILES) break;
    out[f.file] = ranges;
  }
  return out;
}

const isPair = (r) => Array.isArray(r) && r.length === 2 && r.every((n) => Number.isInteger(n) && n > 0) && r[0] <= r[1];

// The snapshot is trusted, but publish reads it defensively anyway.
export function sanitizeHunkRanges(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [file, ranges] of Object.entries(v)) {
    if (!Array.isArray(ranges)) continue;
    const ok = ranges.filter(isPair).slice(0, MAX_HUNKS_PER_FILE);
    if (ok.length) out[file] = ok;
  }
  return out;
}

export const insideOneHunk = (ranges, start, end) => (ranges ?? []).some(([s, e]) => s <= start && end <= e);

// facts' single read of the PR diff: the parsed files and their hunk ranges,
// from one git call.
export function readPrDiff(baseSha, headSha, cwd) {
  const text = prDiffText(baseSha, headSha, cwd);
  return { files: parseUnifiedDiff(text), hunkRanges: hunkRanges(text) };
}

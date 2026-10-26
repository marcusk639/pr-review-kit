// The git material the model reads instead of running git itself (it has no
// shell): OUT/pr.diff, OUT/commits.txt and, for increment tiers, OUT/increment.diff.
// git runs here through execFileSync argument arrays, never a shell.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, prDiffText } from './diff.mjs';

export const MAX_DIFF = 1.5 * 1024 * 1024;
const MAX_COMMITS = 200 * 1024;
const INCREMENT_TIERS = new Set(['incremental', 'incremental-new-links', 'light', 'base-drift']);

export function capText(text, max) {
  const buf = Buffer.from(String(text ?? ''));
  if (buf.length <= max) return String(text ?? '');
  const kept = buf.subarray(0, max).toString('utf8').replace(/�+$/, '');
  const more = buf.length - Buffer.byteLength(kept);
  return `${kept}\n[truncated: ${more} more bytes not shown; read the changed files directly]\n`;
}

function attempt(fn, what) {
  try {
    return { text: fn(), ok: true };
  } catch {
    return { text: `[${what} unavailable]\n`, ok: false };
  }
}

// Returns { prDiff, prDiffTruncated }: whether pr.diff holds the real diff
// (not the "unavailable" stand-in) and whether it was cut at MAX_DIFF. facts
// records both so publish can label the review partial.
export function writeMaterial(out, { baseSha, headSha, tier, incrementText = '', cwd }) {
  const pr = attempt(() => prDiffText(baseSha, headSha, cwd) || '[no changes]\n', 'pr diff');
  writeFileSync(join(out, 'pr.diff'), capText(pr.text, MAX_DIFF));
  const log = attempt(() => git(['log', '--no-color', '--format=%h %s', `${baseSha}..${headSha}`], cwd) || '[no commits]\n', 'commit list');
  writeFileSync(join(out, 'commits.txt'), capText(log.text, MAX_COMMITS));
  const incPath = join(out, 'increment.diff');
  if (INCREMENT_TIERS.has(tier)) {
    writeFileSync(incPath, capText(incrementText || '[no changes in this PR\'s files since the last reviewed commit]\n', MAX_DIFF));
  } else {
    rmSync(incPath, { force: true });
  }
  return { prDiff: pr.ok, prDiffTruncated: pr.ok && Buffer.byteLength(String(pr.text)) > MAX_DIFF };
}

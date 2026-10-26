import { createHash } from 'node:crypto';
import { filterDiffText, git, parseUnifiedDiff } from './diff.mjs';
import { matches } from './glob.mjs';
import { route } from './routing.mjs';
import { activeProject } from './config.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const lines = (s) => s.split('\n').filter(Boolean);

// Exact-diff hash (not patch-id: that strips whitespace, hiding re-indents).
function diffHash(range, cwd) {
  try {
    const diff = git(['diff', '--text', '--no-textconv', '--no-color', '-M', range], cwd);
    return diff ? createHash('sha256').update(diff).digest('hex') : null;
  } catch {
    return null;
  }
}

function baseDriftChanged(lastBaseSha, baseSha, prLinkTypes, cwd) {
  if (!lastBaseSha || lastBaseSha === baseSha) return false;
  try {
    const patterns = activeProject().routing.filter((e) => prLinkTypes.includes(e.linkType)).flatMap((e) => e.counterparts ?? []);
    const drift = lines(git(['diff', '--text', '--no-textconv', '--name-only', lastBaseSha, baseSha], cwd));
    return drift.filter((f) => patterns.some((p) => matches(f, p)));
  } catch {
    return true; // cannot tell: treat as changed
  }
}

// Every git failure degrades safely: unreachable -> full; diff-hash/drift failure -> treated as changed.
export function computeIncrement({ lastReviewedSha, lastBaseSha, baseSha, headSha, prPaths, cwd }) {
  const last = SHA_RE.test(lastReviewedSha ?? '') ? lastReviewedSha : null;
  const lastBase = SHA_RE.test(lastBaseSha ?? '') ? lastBaseSha : null;
  const none = { reachable: false, incrementFiles: [], incrementDiff: [], incrementText: '', incrementLinkTypes: [], prDiffUnchanged: false, baseDriftCounterpartsChanged: false, driftFiles: [] };
  if (!last) return none;
  try {
    git(['merge-base', '--is-ancestor', last, headSha], cwd);
  } catch {
    return none;
  }
  try {
    // Only this PR's files: a merge from base pulls other PRs' files into last..head.
    // Union with the previously reviewed set so a file reverted to base content stays in.
    // If that set cannot be computed, keep last..head unfiltered (safe side).
    let inPr = () => true;
    try {
      const prSet = new Set([
        ...lines(git(['diff', '--text', '--no-textconv', '--name-only', `${baseSha}...${headSha}`], cwd)),
        ...lines(git(['diff', '--text', '--no-textconv', '--name-only', `${lastBase}...${last}`], cwd)),
      ]);
      inPr = (f) => prSet.has(f);
    } catch {
      // unfiltered
    }
    const incrementFiles = lines(git(['diff', '--text', '--no-textconv', '--name-only', `${last}..${headSha}`], cwd)).filter(inPr);
    const rawIncrement = git(['diff', '--text', '--no-textconv', '-M', '--no-color', `${last}..${headSha}`], cwd);
    const incrementDiff = parseUnifiedDiff(rawIncrement).filter((f) => inPr(f.file));
    // The same filtered increment as text, for the model's OUT/increment.diff.
    const incrementText = filterDiffText(rawIncrement, inPr);
    // Same base + non-empty increment can never be "PR unchanged".
    const comparable = lastBase && lastBase !== baseSha;
    const before = comparable ? diffHash(`${lastBase}...${last}`, cwd) : null;
    const after = before ? diffHash(`${baseSha}...${headSha}`, cwd) : null;
    const drift = baseDriftChanged(lastBase, baseSha, route(prPaths).linkTypes, cwd);
    return {
      reachable: true,
      incrementFiles,
      incrementDiff,
      incrementText,
      incrementLinkTypes: route(incrementFiles).linkTypes,
      prDiffUnchanged: Boolean(before && after && before === after),
      baseDriftCounterpartsChanged: drift === true || (Array.isArray(drift) && drift.length > 0),
      driftFiles: Array.isArray(drift) ? drift : [],
    };
  } catch {
    return none;
  }
}

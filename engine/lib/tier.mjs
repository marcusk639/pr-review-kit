import { matches } from './glob.mjs';
import { activeProject } from './config.mjs';

export function maxTurnsFor(tier, config = activeProject().config) {
  const n = config.tiers.maxTurns[tier];
  return Number.isInteger(n) ? n : 0;
}

const isLight = (f, config) => config.lightFiles.some((p) => matches(String(f), p));

// tiers.enabled false (small repos): no incremental tiers and no base-drift
// check; a push with changes gets a full review, a push without gets none.
export function classify(
  {
    lastReviewedSha,
    reachable,
    incrementFiles = [],
    incrementLinkTypes = [],
    linkTypesSeen = [],
    prDiffUnchanged,
    prFileCount = 0,
    baseDriftCounterpartsChanged,
  },
  config = activeProject().config,
) {
  if (!lastReviewedSha || !reachable) return 'full';
  if (!config.tiers.enabled) return incrementFiles.length === 0 || prDiffUnchanged ? 'none' : 'full';
  // A merge from base leaves this PR's own increment empty yet can still need base-drift.
  if (incrementFiles.length === 0 && !(prDiffUnchanged && baseDriftCounterpartsChanged)) return 'none';
  if (prDiffUnchanged) return baseDriftCounterpartsChanged ? 'base-drift' : 'none';
  if (incrementLinkTypes.length === 0 && incrementFiles.every((f) => isLight(f, config))) return 'light';
  const unseen = incrementLinkTypes.some((t) => !linkTypesSeen.includes(t));
  if (unseen || incrementFiles.length >= config.tiers.largeShare * prFileCount) return 'incremental-new-links';
  return 'incremental';
}

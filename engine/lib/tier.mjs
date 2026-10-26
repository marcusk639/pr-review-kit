import { matches } from './glob.mjs';
import { activeProject } from './config.mjs';

export function maxTurnsFor(tier, config = activeProject().config) {
  const n = config.tiers.maxTurns[tier];
  return Number.isInteger(n) ? n : 0;
}

// Light: a light-file pattern matches and no lightExclude pattern does
// (behavioural docs such as prompts or SKILL.md are never light).
export const isLight = (f, config) => config.lightFiles.some((p) => matches(String(f), p)) && !config.lightExclude.some((p) => matches(String(f), p));

// A disabled tier widens to the next one; "none" and "full" are always available.
const WIDER = { 'base-drift': 'none', light: 'incremental', incremental: 'incremental-new-links', 'incremental-new-links': 'full' };
function allowed(tier, config) {
  let t = tier;
  while (config.tiers.disabled.includes(t)) t = WIDER[t];
  return t;
}

// tiers.set: "all" (every tier), "none-light-full" (no incremental tiers and
// no base-drift: light or full), "full" (a push with changes is a full
// review). Without changes since the last review the tier is always none.
// A tier's maxTurns of 0 means the model does not run on it.
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
  const set = config.tiers.set;
  const lightOnly = incrementLinkTypes.length === 0 && incrementFiles.every((f) => isLight(f, config));
  if (set !== 'all') {
    if (incrementFiles.length === 0 || prDiffUnchanged) return 'none';
    return set === 'none-light-full' && lightOnly && !config.tiers.disabled.includes('light') ? 'light' : 'full';
  }
  // A merge from base leaves this PR's own increment empty yet can still need base-drift.
  if (incrementFiles.length === 0 && !(prDiffUnchanged && baseDriftCounterpartsChanged)) return 'none';
  if (prDiffUnchanged) return baseDriftCounterpartsChanged ? allowed('base-drift', config) : 'none';
  if (lightOnly) return allowed('light', config);
  const unseen = incrementLinkTypes.some((t) => !linkTypesSeen.includes(t));
  if (unseen || incrementFiles.length >= config.tiers.largeShare * prFileCount) return allowed('incremental-new-links', config);
  return allowed('incremental', config);
}

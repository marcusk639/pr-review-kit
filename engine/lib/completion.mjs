// Whether a run produced a completed review, and how publish labels it.
import { validateFindings } from './render.mjs';
import { isObject, strings } from './prior.mjs';

const RATE_RE = /rate.?limit|usage limit/i;
// Only the tail holds the final result; earlier turns may quote PR code about rate limiting.
const LOG_TAIL = 4000;

export function failureReason(executionLog) {
  const tail = String(executionLog ?? '').slice(-LOG_TAIL);
  return RATE_RE.test(tail) ? 'rate-limited' : 'failed';
}

// The validated findings of a completed review, or null when publish will show
// the failure banner instead (reason: why, when it is not the action's own
// failure). Completed means the action succeeded on a tier that ran the model,
// findings.json parses and says complete: true (the model's last write, so a
// run cut off at its turn limit never passes), and summary.md exists
// (narrative null means it does not). Shared by composeBody, inline posting
// and advisory delivery.
export function completion(state, findingsText, outcome, narrative) {
  if (!isObject(state) || outcome !== 'success' || state.tier === 'none') return { findings: null, reason: null };
  const parsed = validateFindings(findingsText ?? '');
  if (!parsed.ok) return { findings: null, reason: null };
  if (parsed.value.complete !== true || narrative === null) return { findings: null, reason: 'incomplete' };
  return { findings: parsed.value, reason: null };
}

export const completedFindings = (...args) => completion(...args).findings;

// Facts failed, or OUT/pr.diff holds only the "unavailable" stand-in or was
// cut at its size cap: the model reviewed without all of the material, so the
// review is labelled partial.
export const isPartial = (s) => s.prDiffAvailable === false || s.prDiffTruncated === true || strings(s.unavailableChecks).includes('facts');

export function outcomeLabel(snapshot, rest) {
  if (!isObject(snapshot)) return 'review did not complete (no trusted state)';
  if (snapshot.tier === 'none' && rest.outcome === 'skipped') return 'no change since the last review';
  const { findings, reason } = completion(snapshot, rest.findingsText, rest.outcome, rest.narrative);
  if (!findings) return `review did not complete (${reason ?? failureReason(rest.executionLog)})`;
  return isPartial(snapshot) ? 'partial review' : 'complete review';
}

// Inline comments, posted by publish (the model has no inline tool). The model
// writes OUT/inline.json: [{slug, path, line, side: "RIGHT"|"LEFT", body,
// start_line?, suggestion?}]. Publish keeps an entry only when its slug is a
// non-security finding of a config.inline.severities severity in
// findings.json that the summary would not withhold, its path is one of the
// PR's changed files (facts' trusted list), the slug has no fp comment yet,
// and the guard's predicate passes on the exact body to be posted; at most
// config.inline.max, Critical/High first. A suggestion
// (config.inline.suggestions) is fenced by publish and posted only inside one
// trusted hunk (suggestion.mjs); otherwise the comment posts without it. It
// appends the fp marker itself. It does not check the ledger: leaving out
// slugs already in it is the model's job.
import { ghRequest } from './gh.mjs';
import { redact } from './redact.mjs';
import { fpMarker } from './markers.mjs';
import { securitySlugsOf, unsafeInline } from './inline-guard.mjs';
import { securityNeedles, touchesSecurityFile } from './needles.mjs';
import { SLUG_RE } from './findings.mjs';
import { activeProject } from './config.mjs';
import { isWithheld } from './withheld.mjs';
import { applyStyle } from './style.mjs';
import { fenced, hasSuggestionFence, keepsRange, MAX_SUGGESTION_READ, suggestionProblem } from './suggestion.mjs';

// Defaults; the project's config.inline overrides both.
export const MAX_INLINE = 10;
const MAX_BODY = 4000;
const MAX_PATH = 300;
const SIDES = new Set(['RIGHT', 'LEFT']);
const FIRST = new Set(['Critical', 'High']);

const REVIEW_BODY = 'pr-review (advisory): inline comments for this commit. The summary comment has the full review.';

const isStr = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

function valid(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  if (!isStr(e.slug, 300) || !SLUG_RE.test(e.slug) || !isStr(e.path, MAX_PATH)) return false;
  if (!(Number.isInteger(e.line) && e.line > 0 && SIDES.has(e.side) && typeof e.body === 'string' && e.body.trim() !== '')) return false;
  if (e.start_line !== undefined && !(Number.isInteger(e.start_line) && e.start_line > 0 && e.start_line <= e.line)) return false;
  return e.suggestion === undefined || (typeof e.suggestion === 'string' && e.suggestion.length <= MAX_SUGGESTION_READ);
}

// Entries read from one inline.json, bounded so a huge file stays cheap.
export const MAX_ENTRIES = 100;
const pick = ({ slug, path, line, side, body, start_line: start, suggestion }) => ({
  slug, path, line, side, body,
  ...(start === undefined ? {} : { start_line: start }),
  ...(suggestion === undefined ? {} : { suggestion }),
});

// Validates every entry before anything is capped, so a bad entry never pushes
// a good one out. Malformed file or entries are dropped, never fatal; the
// caller counts them. present: the model wrote the file at all.
export function readInline(text) {
  const none = { entries: [], invalidSlugs: [], invalid: 0, malformed: false, present: text != null };
  if (text == null) return none;
  let v;
  try {
    v = JSON.parse(String(text));
  } catch {
    return { ...none, malformed: true };
  }
  if (!Array.isArray(v)) return { ...none, malformed: true };
  const entries = [];
  const invalidSlugs = [];
  let invalid = Math.max(0, v.length - MAX_ENTRIES);
  for (const e of v.slice(0, MAX_ENTRIES)) {
    if (valid(e)) entries.push(pick(e));
    else {
      invalid++;
      if (typeof e?.slug === 'string') invalidSlugs.push(e.slug);
    }
  }
  return { entries, invalidSlugs, invalid, malformed: false, present: true };
}

export function parseInline(text) {
  return readInline(text).entries;
}

// HTML comments are neutralised so model text cannot plant another fp marker.
const neutralise = (s) => s.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');

// A finding that may get a public inline comment: the same withholding
// predicate as the summary, so a finding it would withhold never gets one.
// A class the learning loop demoted (low precision) loses its inline comments.
export function inlineEligible(f, needles, project = activeProject()) {
  const severities = new Set(project.config.inline.severities);
  const demoted = project.demotedClasses ?? new Set();
  return Boolean(f) && !f.security && severities.has(f.severity) && !demoted.has(f.class) && !touchesSecurityFile(f, needles);
}

export const newDrops = () => ({ notFinding: 0, ineligible: 0, path: 0, duplicate: 0, unsafe: 0, overCap: 0, fence: 0, suggestionDropped: 0, suggestionReasons: {}, lost: [] });

// Critical/High comments dropped for a reason the maintainer should hear about
// are listed in drops.lost (the summary announces them); Medium ones are not,
// because the summary lists every finding anyway.
export const announced = (f) => FIRST.has(f?.severity);

// Critical/High entries are considered before the rest, stable otherwise, so a
// Medium comment never takes a Critical/High comment's place under the cap.
function ordered(entries, bySlug) {
  const first = (e) => announced(bySlug.get(e.slug));
  return [...entries.filter(first), ...entries.filter((e) => !first(e))];
}

// The comment publish would post for e, with or without its suggestion.
function build(e, text, suggestion, ranges) {
  const range = suggestion !== undefined ? e.start_line !== undefined && e.start_line < e.line : keepsRange(e, ranges);
  const shown = suggestion === undefined ? text : `${text}\n\n${fenced(suggestion)}`;
  return { slug: e.slug, path: e.path, line: e.line, side: e.side, ...(range ? { start_line: e.start_line } : {}), body: `${shown}\n\n${fpMarker(e.slug)}` };
}

// The suggestion survives only when it passes suggestionProblem, the guard
// predicate on the exact posted text, redaction unchanged, and the body cap.
function withSuggestion(e, text, ranges, unsafe, drops, isSecurityPath) {
  if (e.suggestion === undefined) return build(e, text, undefined, ranges);
  const s = e.suggestion;
  const c = build(e, text, s, ranges);
  const fits = applyStyle(redact(text)).length + 2 + fenced(s).length <= MAX_BODY;
  const reason = suggestionProblem(e, ranges, isSecurityPath) ?? (!fits ? 'size' : redact(s) !== s || unsafe(c) ? 'guard' : null);
  if (!reason) return c;
  drops.suggestionDropped++;
  drops.suggestionReasons[reason] = (drops.suggestionReasons[reason] ?? 0) + 1;
  return build(e, text, undefined, ranges);
}

// needles: the summary's security-file needles (runNeedles), for touchesSecurityFile.
// drops (optional) counts every entry left out, by reason; drops.lost lists the
// slugs of Critical/High findings whose comment was dropped for a reason the
// maintainer should hear about (not in the changed files, its own suggestion
// fence, over the cap). hunkRanges: facts' trusted RIGHT-side hunk ranges per
// file (sanitizeHunkRanges).
export function selectInline({ entries, findings, changedFiles, postedSlugs, hunkRanges = {}, isSecurityPath = () => false, needles = securityNeedles(findings), drops = newDrops() }) {
  const bySlug = new Map((findings ?? []).map((f) => [f.slug, f]));
  const files = new Set(changedFiles ?? []);
  const seen = new Set(postedSlugs ?? []);
  const securitySlugs = securitySlugsOf(findings);
  const unsafe = (c) => unsafeInline(c, securitySlugs, isSecurityPath);
  const out = [];
  for (const e of ordered(entries ?? [], bySlug)) {
    const f = bySlug.get(e.slug);
    const lose = () => announced(f) && drops.lost.push(e.slug);
    if (!f) drops.notFinding++;
    else if (!inlineEligible(f, needles)) drops.ineligible++;
    else if (seen.has(e.slug)) drops.duplicate++;
    else if (isWithheld(e.path)) drops.ineligible++;
    else if (!files.has(e.path)) {
      drops.path++;
      lose();
    } else if (hasSuggestionFence(e.body)) {
      drops.fence++;
      lose();
    } else {
      const text = neutralise(e.body.trim());
      const c = withSuggestion(e, text, hunkRanges[e.path], unsafe, drops, isSecurityPath);
      // The guard predicate sees the whole unredacted body (a quoted secret drops the comment).
      if (unsafe(c)) drops.unsafe++;
      else if (out.length >= activeProject().config.inline.max) {
        drops.overCap++;
        lose();
      } else {
        seen.add(e.slug);
        const [shown] = c.body.split(`\n\n${fpMarker(e.slug)}`);
        // Redacted before the cap, so a secret straddling the cut cannot survive as
        // a fragment. A suggestion is never cut or restyled: withSuggestion dropped
        // it if it did not fit, and style rules would change the code.
        const capped = shown === text ? applyStyle(redact(text)).slice(0, MAX_BODY) : `${applyStyle(redact(text))}${shown.slice(text.length)}`;
        out.push({ ...c, body: redact(`${capped}\n\n${fpMarker(e.slug)}`) });
      }
    }
  }
  return out;
}

const status = (err) => (Number.isInteger(err?.status) ? err.status : 'unknown');

// One COMMENT review on the head (GH_TOKEN, as github-actions[bot]). GitHub
// rejects the whole review when one line is outside the diff (422), so only
// then is the batch retried one comment per review. Any other failure (5xx, a
// timeout) may have posted the review anyway, so it is not retried: a retry
// could post every comment twice.
export async function postInlineReview({ repo, pr, headSha, comments, request = ghRequest }) {
  if (!comments?.length) return { posted: [], failed: 0 };
  if (!headSha) return { posted: [], failed: comments.length };
  const path = `/repos/${repo}/pulls/${pr}/reviews`;
  const toComment = ({ path: p, line, side, start_line: start, body }) =>
    start === undefined ? { path: p, line, side, body } : { path: p, line, side, start_line: start, start_side: 'RIGHT', body };
  const payload = (cs) => ({ commit_id: headSha, event: 'COMMENT', body: REVIEW_BODY, comments: cs.map(toComment) });
  try {
    await request('POST', path, payload(comments));
    return { posted: comments.map((c) => c.slug), failed: 0 };
  } catch (err) {
    console.log(`inline post: review failed: ${status(err)}`);
    if (err?.status !== 422) return { posted: [], failed: comments.length };
  }
  const posted = [];
  let failed = 0;
  for (const c of comments) {
    try {
      await request('POST', path, payload([c]));
      posted.push(c.slug);
    } catch (err) {
      failed++;
      console.log(`inline post: comment failed: ${status(err)}`);
    }
  }
  return { posted, failed };
}

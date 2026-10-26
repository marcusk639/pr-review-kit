// Inline comments, posted by publish (the model has no inline tool). The model
// writes OUT/inline.json: [{slug, path, line, side: "RIGHT"|"LEFT", body}].
// Publish keeps an entry only when its slug is a non-security Critical/High
// finding in findings.json that the summary would not withhold, its path is
// one of the PR's changed files (facts' trusted list), the slug has no fp
// comment yet, and the guard's predicate passes on the exact body to be
// posted; at most MAX_INLINE. It appends the fp marker itself. It does not
// check the ledger: leaving out slugs already in it is the model's job.
import { ghRequest } from './gh.mjs';
import { redact } from './redact.mjs';
import { fpMarker } from './markers.mjs';
import { securitySlugsOf, unsafeInline } from './inline-guard.mjs';
import { securityNeedles, touchesSecurityFile } from './needles.mjs';
import { SLUG_RE } from './findings.mjs';
import { activeProject } from './config.mjs';
import { isWithheld } from './withheld.mjs';
import { applyStyle } from './style.mjs';

// Defaults; the project's config.inline overrides both.
export const MAX_INLINE = 10;
const MAX_BODY = 4000;
const MAX_PATH = 300;
const SIDES = new Set(['RIGHT', 'LEFT']);

const REVIEW_BODY = 'pr-review (advisory): inline comments for this commit. The summary comment has the full review.';

const isStr = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

function valid(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  if (!isStr(e.slug, 300) || !SLUG_RE.test(e.slug) || !isStr(e.path, MAX_PATH)) return false;
  return Number.isInteger(e.line) && e.line > 0 && SIDES.has(e.side) && typeof e.body === 'string' && e.body.trim() !== '';
}

// Entries read from one inline.json, bounded so a huge file stays cheap.
export const MAX_ENTRIES = 100;
const pick = ({ slug, path, line, side, body }) => ({ slug, path, line, side, body });

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

export const newDrops = () => ({ notFinding: 0, ineligible: 0, path: 0, duplicate: 0, unsafe: 0, overCap: 0, lost: [] });

// needles: the summary's security-file needles (runNeedles), for touchesSecurityFile.
// drops (optional) counts every entry left out, by reason; drops.lost lists the
// slugs of eligible findings whose comment was dropped for a reason the
// maintainer should hear about (not in the changed files, over the cap).
export function selectInline({ entries, findings, changedFiles, postedSlugs, isSecurityPath = () => false, needles = securityNeedles(findings), drops = newDrops() }) {
  const bySlug = new Map((findings ?? []).map((f) => [f.slug, f]));
  const files = new Set(changedFiles ?? []);
  const seen = new Set(postedSlugs ?? []);
  const securitySlugs = securitySlugsOf(findings);
  const out = [];
  for (const e of entries ?? []) {
    const f = bySlug.get(e.slug);
    if (!f) drops.notFinding++;
    else if (!inlineEligible(f, needles)) drops.ineligible++;
    else if (seen.has(e.slug)) drops.duplicate++;
    else if (isWithheld(e.path)) drops.ineligible++;
    else if (!files.has(e.path)) {
      drops.path++;
      drops.lost.push(e.slug);
    } else {
      const text = neutralise(e.body.trim());
      const c = { slug: e.slug, path: e.path, line: e.line, side: e.side, body: `${text}\n\n${fpMarker(e.slug)}` };
      // The guard predicate sees the whole unredacted body (a quoted secret drops the comment).
      if (unsafeInline(c, securitySlugs, isSecurityPath)) drops.unsafe++;
      else if (out.length >= activeProject().config.inline.max) {
        drops.overCap++;
        drops.lost.push(e.slug);
      } else {
        seen.add(e.slug);
        // Redacted before the cap, so a secret straddling the cut cannot survive as a fragment.
        out.push({ ...c, body: redact(`${applyStyle(redact(text)).slice(0, MAX_BODY)}\n\n${fpMarker(e.slug)}`) });
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
  const payload = (cs) => ({ commit_id: headSha, event: 'COMMENT', body: REVIEW_BODY, comments: cs.map(({ path: p, line, side, body }) => ({ path: p, line, side, body })) });
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

// Suggested changes on inline comments (config.inline.suggestions, off by
// default). The model writes only the replacement text; publish checks it here
// and adds the fence itself. A failing suggestion is dropped and its comment
// still posts.
import { insideOneHunk } from './hunks.mjs';
import { matches } from './glob.mjs';
import { activeProject, PROJECT_SUBDIR, securityClasses } from './config.mjs';

// The longest suggestion inline.json may carry at all; longer entries are invalid.
export const MAX_SUGGESTION_READ = 20000;

// A ``` fence whose info string starts with "suggestion": only publish writes one.
const FENCE_RE = /```[ \t]*suggestion/i;
// Control characters other than tab and newline (a CR included).
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;

export const hasSuggestionFence = (body) => FENCE_RE.test(String(body ?? ''));

export const fenced = (suggestion) => `\`\`\`suggestion\n${suggestion}\n\`\`\``;

// The [start, end] range an entry covers: start_line..line, or line alone.
export const rangeOf = (e) => [Number.isInteger(e.start_line) ? e.start_line : e.line, e.line];

// Files a one-click suggestion never touches, in every project: a suggestion
// can carry code that prompt injection in the PR steered the model to write,
// and maintainers tend to trust suggestions. CI, reviewer and agent config,
// manifests and lockfiles. config.inline.suggestions.blockedPaths adds more.
const ALWAYS_BLOCKED = [
  /^\.github\//,
  new RegExp(`^${PROJECT_SUBDIR.replace('.', '\\.')}/`),
  /(^|\/)\.claude\//,
  /(^|\/)package\.json$/,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Podfile\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/,
];

// Classes routed to a path (routing entries only, not the always-classes).
const routedClasses = (path, project) => project.routing.filter((e) => e.paths.some((g) => matches(path, g))).flatMap((e) => e.classes);

// Blocked: always-blocked files, configured globs, and any path routed to a
// security class or to a configured blocked class.
export function suggestionPathBlocked(path, isSecurityPath = () => false, project = activeProject()) {
  const p = String(path ?? '');
  const cfg = project.config.inline.suggestions;
  if (ALWAYS_BLOCKED.some((re) => re.test(p))) return true;
  if (cfg.blockedPaths.some((g) => matches(p, g))) return true;
  const blocked = new Set([...securityClasses(project.config), ...cfg.blockedClasses]);
  if (routedClasses(p, project).some((c) => blocked.has(c))) return true;
  return Boolean(isSecurityPath(p));
}

// Why the suggestion cannot be posted, or null when it can. ranges: this
// file's trusted hunk ranges.
export function suggestionProblem(e, ranges, isSecurityPath, project = activeProject()) {
  const cfg = project.config.inline.suggestions;
  const s = e.suggestion;
  if (!cfg.enabled) return 'disabled';
  if (suggestionPathBlocked(e.path, isSecurityPath, project)) return 'security path';
  const [start, end] = rangeOf(e);
  if (e.side !== 'RIGHT') return 'side';
  if (end - start + 1 > cfg.maxRangeLines) return 'range';
  if (!insideOneHunk(ranges, start, end)) return 'hunk';
  if (s.length > cfg.maxChars || s.split('\n').length > cfg.maxLines) return 'size';
  if (s.includes('```')) return 'fence';
  if (CONTROL_RE.test(s)) return 'control';
  // No HTML comment: it could plant an fp marker, and neutralising it would change the code.
  if (s.includes('<!--') || s.includes('-->')) return 'comment';
  return null;
}

// A plain (suggestion-free) multi-line comment keeps its range only inside one
// hunk; otherwise it falls back to a single-line comment on `line`.
export const keepsRange = (e, ranges) => Number.isInteger(e.start_line) && e.start_line < e.line && e.side === 'RIGHT' && insideOneHunk(ranges, e.start_line, e.line);

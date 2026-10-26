// Applying lesson proposals (deterministic; the gate between a distiller,
// model or not, and the knowledge files). A proposal must cite one candidate,
// stay inside that candidate's scope, target a configured knowledge file and
// carry a short rule that is not itself instruction-shaped. A lesson that
// would narrow security coverage is kept as "needs-decision" and never
// rendered into the knowledge. A newer lesson replaces an older one with the
// same scope key; lessons whose paths no longer exist are pruned; memory is
// capped at learning.maxLessons.
import { createHash } from 'node:crypto';
import { matches } from '../lib/glob.mjs';
import { redact } from '../lib/redact.mjs';
import { securityClasses } from '../lib/config.mjs';
import { instructionShaped } from './candidates.mjs';

const MAX_RULE = 400;
const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 10);
const SUPPRESS_SECURITY = /\b(don'?t|do not|never|stop|no need to|skip|ignore|not needed|no \w+ needed|needs? no)\b[^.\n]{0,60}\b(secur\w*|auth\w*|secrets?|tokens?|credentials?|pii|privacy|permissions?|vulnerab\w*|inject\w*)|\b(auth\w*|secur\w*|permissions?)\b[^.\n]{0,20}\b(not needed|unnecessary|isn'?t needed|no need)\b|\bno auth\b/i;

const TARGETS = [
  [/\b(intentional\w*|deliberate\w*|by design|on purpose|expected|not a bug|false positive|don'?t flag|do not flag|safe here|fine here)\b/i, 'false-positives.md'],
  [/\b(counterpart|other side|also check|consumers?|callers?)\b|\bwhen .{1,40} changes\b/i, 'contract-map'],
  [/\b(conventions?|we always|we never|we prefer|house style)\b/i, 'conventions.md'],
];

function pickTarget(c, config) {
  const has = (f) => config.knowledge.includes(f);
  const fallback = has('learned-lessons.md') ? 'learned-lessons.md' : config.knowledge[config.knowledge.length - 1];
  if (c.kind === 'pattern') return fallback;
  for (const [re, t] of TARGETS) {
    if (!re.test(c.text)) continue;
    const file = t === 'contract-map' ? config.knowledge.find((f) => /^contract-map/.test(f)) : has(t) ? t : null;
    if (file) return file;
  }
  return fallback;
}

const ruleOf = (c) => (c.kind === 'pattern' ? c.text : `In \`${c.scope.paths[0]}\` (class ${c.scope.class}): ${c.text}`);

// Without a model (learning.distill "deterministic", or the model failed):
// the feedback text itself is the rule, placed by keywords.
export function deterministicProposals(candidates, config) {
  return candidates.map((c) => ({ candidate: c.id, target: pickTarget(c, config), rule: ruleOf(c), scope: c.scope }));
}

// A proposed path must sit inside one of the candidate's paths.
function within(path, allowed) {
  return allowed.some((a) => path === a || (a.endsWith('/**') && (path.startsWith(a.slice(0, -2)) || path === a.slice(0, -3))) || (!/[*?]/.test(path) && matches(path, a)));
}

function narrowsSecurity(c, rule, config) {
  if (securityClasses(config).has(c.scope.class)) return `class ${c.scope.class} is a security class`;
  if (c.security) return 'the feedback was on a security finding';
  if (config.classes.some((k) => k.id === c.scope.class && k.protected)) return `class ${c.scope.class} is protected`;
  if (SUPPRESS_SECURITY.test(rule) || SUPPRESS_SECURITY.test(c.text ?? '')) return 'the rule would suppress security, auth, secret or PII findings';
  return null;
}

function validate(p, c, config) {
  if (!c) return 'proposal cites no known feedback';
  if (p.unresolved) return `ambiguous: ${redact(String(p.unresolved)).slice(0, 200)}`;
  if (!config.knowledge.includes(p.target) || config.learning.forbidden.includes(p.target)) return 'target is not a configured knowledge file the learning loop may edit';
  const rule = typeof p.rule === 'string' ? p.rule.trim() : '';
  if (!rule || rule.length > MAX_RULE) return 'rule missing or too long';
  if (instructionShaped(rule)) return 'instruction-shaped rule';
  const paths = Array.isArray(p.scope?.paths) && p.scope.paths.length ? p.scope.paths : c.scope.paths;
  if (!paths.every((x) => typeof x === 'string' && within(x, c.scope.paths))) return 'scope wider than the feedback';
  return null;
}

const exists = (paths, files) => paths.some((p) => files.some((f) => f === p || matches(f, p)));

export function applyProposals({ lessons = [], consumed = [], candidates = [], proposals = [], config, files = [], today }) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  let current = lessons.map((l) => ({ ...l }));
  const out = { added: [], replaced: [], flagged: [], unresolved: [], pruned: [] };
  const used = new Set();
  for (const p of proposals ?? []) {
    const c = byId.get(p?.candidate);
    if (c && used.has(c.id)) continue;
    const why = validate(p ?? {}, c, config);
    if (why) {
      out.unresolved.push({ candidate: p?.candidate ?? null, reason: why, url: c?.sources?.[0]?.url ?? null, pr: c?.sources?.[0]?.pr ?? null, text: c?.text ?? null });
      continue;
    }
    used.add(c.id);
    const rule = redact(p.rule.trim());
    const paths = Array.isArray(p.scope?.paths) && p.scope.paths.length ? p.scope.paths : c.scope.paths;
    const lesson = { id: `L-${hash(c.id)}`, kind: c.kind, status: 'active', target: p.target, rule, scope: { paths, class: c.scope.class, linkTypes: c.scope.linkTypes }, scopeKey: c.scopeKey, sources: c.sources, date: today };
    const flag = narrowsSecurity(c, rule, config);
    if (flag) {
      Object.assign(lesson, { status: 'needs-decision', why: flag });
      out.flagged.push(lesson);
      current = [...current.filter((l) => l.id !== lesson.id), lesson];
      continue;
    }
    const older = current.filter((l) => l.scopeKey === lesson.scopeKey && l.id !== lesson.id);
    out.replaced.push(...older);
    current = [...current.filter((l) => !older.includes(l) && l.id !== lesson.id), lesson];
    out.added.push(lesson);
  }
  out.pruned = current.filter((l) => !exists(l.scope?.paths ?? [], files));
  current = current.filter((l) => !out.pruned.includes(l));
  const activeCount = () => current.filter((l) => l.status === 'active').length;
  const byAge = [...current].filter((l) => l.status === 'active').sort((a, b) => (a.kind === b.kind ? String(a.date).localeCompare(String(b.date)) : a.kind === 'pattern' ? -1 : 1));
  while (activeCount() > config.learning.maxLessons && byAge.length) {
    const drop = byAge.shift();
    current = current.filter((l) => l !== drop);
    out.pruned.push(drop);
  }
  const gone = [...out.replaced, ...out.pruned].flatMap((l) => (l.sources ?? []).map((s) => s.id));
  return { lessons: current, consumed: [...new Set([...consumed, ...gone])].slice(-2000), ...out };
}

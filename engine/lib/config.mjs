// The consumer's engine config (.claude/pr-review/config.json) and routing
// table, both read from a base-branch checkout, never the PR head. Defaults
// reproduce the recovery-platform reference wherever it had one. Validation
// returns errors instead of throwing: facts and publish fail closed on them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const PROJECT_RE = /^[A-Za-z0-9._-]{1,60}$/;

export const DEFAULTS = Object.freeze({
  version: 1,
  project: 'project',
  visibility: 'public',
  securityChannel: null,
  privateReaders: [],
  workflowPath: '.github/workflows/pr-review.yml',
  learnWorkflowPath: '.github/workflows/pr-review-learn.yml',
  packages: [],
  knowledge: ['checklist.md', 'conventions.md', 'false-positives.md'],
  classes: [],
  tiers: { enabled: true, maxTurns: { none: 0, 'base-drift': 15, light: 15, incremental: 40, 'incremental-new-links': 60, full: 60 }, largeShare: 0.5 },
  lightFiles: ['**/*.md', '**/*.txt', '**/*.png', '**/*.jpg', '**/*.svg', '**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock'],
  largePr: { files: 60, lines: 5000 },
  inline: { max: 10, severities: ['Critical', 'High'] },
  secrets: { extraPatterns: [] },
  checks: {
    secrets: true,
    piiLogs: { fields: 'email|phone|address|password|token', logCall: '\\b(?:logger|console)\\.' },
    newFileSize: { maxLines: 300, pattern: '\\.(?:ts|tsx|js|jsx|mjs)$' },
    titleScope: false,
    selfEdit: true,
    verifyDiff: false,
    project: [],
  },
  trust: { contextAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'], feedbackAuthors: [] },
  learning: { windowDays: 45, repeatThreshold: 2, maxLessons: 40, demote: { minVotes: 5, maxPrecision: 0.4 }, distill: 'model', branch: 'pr-review/learning' },
});

const KEYS = new Set(Object.keys(DEFAULTS));
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const strs = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

// One level of merge for object-valued keys, two for tiers.maxTurns and learning.demote.
function merge(raw) {
  const c = structuredClone(DEFAULTS);
  for (const [k, v] of Object.entries(raw)) {
    if (!KEYS.has(k)) continue;
    if (isObj(c[k]) && isObj(v)) {
      for (const [k2, v2] of Object.entries(v)) c[k][k2] = isObj(c[k][k2]) && isObj(v2) ? { ...c[k][k2], ...v2 } : v2;
    } else c[k] = v;
  }
  if (c.securityChannel == null) c.securityChannel = c.visibility === 'private' ? 'none' : 'advisory';
  return c;
}

function checkClasses(classes, errors) {
  if (!Array.isArray(classes) || !classes.length) return errors.push('classes: at least one bug class is required');
  const seen = new Set();
  for (const k of classes) {
    if (!isObj(k) || !Number.isInteger(k.id) || k.id < 1 || k.id > 999) errors.push(`class id must be an integer 1-999: ${JSON.stringify(k?.id)}`);
    else if (seen.has(k.id)) errors.push(`duplicate class id ${k.id}`);
    else if (typeof k.name !== 'string' || !k.name.trim()) errors.push(`class ${k.id}: name required`);
    if (isObj(k)) seen.add(k.id);
  }
}

export function normalizeConfig(raw) {
  const errors = [];
  if (!isObj(raw)) return { config: merge({}), errors: ['config must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) errors.push(`unknown key: ${k}`);
  const c = merge(raw);
  if (c.version !== 1) errors.push('version must be 1');
  if (typeof c.project !== 'string' || !PROJECT_RE.test(c.project)) errors.push('project must match [A-Za-z0-9._-]{1,60}');
  if (!['public', 'private'].includes(c.visibility)) errors.push('visibility must be "public" or "private"');
  if (!['advisory', 'repo-comments', 'none'].includes(c.securityChannel)) errors.push('securityChannel must be advisory, repo-comments or none');
  if (c.securityChannel === 'repo-comments' && c.visibility !== 'private') errors.push('securityChannel repo-comments requires visibility private');
  if (c.securityChannel === 'advisory' && c.visibility !== 'public') errors.push('securityChannel advisory requires visibility public (advisories are public-repo only)');
  if (c.securityChannel === 'repo-comments' && (!strs(c.privateReaders) || !c.privateReaders.length)) errors.push('securityChannel repo-comments requires privateReaders');
  checkClasses(c.classes, errors);
  if (!strs(c.packages) || !strs(c.knowledge) || !strs(c.lightFiles)) errors.push('packages, knowledge and lightFiles must be string arrays');
  if (!strs(c.inline.severities) || c.inline.severities.some((s) => !SEVERITIES.includes(s))) errors.push('inline.severities must list severities');
  if (!Number.isInteger(c.inline.max) || c.inline.max < 0 || c.inline.max > 50) errors.push('inline.max must be 0-50');
  for (const [t, n] of Object.entries(c.tiers.maxTurns)) if (!Number.isInteger(n) || n < 0 || n > 200) errors.push(`tiers.maxTurns.${t} must be 0-200`);
  if (!strs(c.trust.feedbackAuthors) || !strs(c.trust.contextAssociations)) errors.push('trust lists must be string arrays');
  if (!strs(c.checks.project)) errors.push('checks.project must be a string array');
  if (!['model', 'deterministic'].includes(c.learning.distill)) errors.push('learning.distill must be model or deterministic');
  for (const p of c.secrets.extraPatterns ?? []) {
    try {
      new RegExp(p);
    } catch {
      errors.push(`secrets.extraPatterns: invalid regex ${JSON.stringify(p)}`);
    }
  }
  return { config: c, errors };
}

export const securityClasses = (config) => new Set(config.classes.filter((k) => k.security).map((k) => k.id));
export const classIds = (config) => new Set(config.classes.map((k) => k.id));
export const alwaysClasses = (config) => config.classes.filter((k) => k.always).map((k) => k.id);
export const lightClasses = (config) => config.classes.filter((k) => k.light).map((k) => k.id);

function readJson(path, label, errors) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    errors.push(`${label} missing or not valid JSON`);
    return null;
  }
}

function checkRouting(routing, config, errors) {
  if (!Array.isArray(routing)) return errors.push('routing.json must be an array');
  const ids = classIds(config);
  for (const e of routing) {
    if (!isObj(e) || typeof e.linkType !== 'string' || !strs(e.paths) || !strs(e.counterparts ?? []) || !Array.isArray(e.classes)) {
      errors.push(`routing entry malformed: ${JSON.stringify(e?.linkType)}`);
      continue;
    }
    for (const k of e.classes) if (!ids.has(k)) errors.push(`routing ${e.linkType}: class ${k} is not configured`);
  }
}

// dir: the project's .claude/pr-review directory inside a base checkout.
export function loadProject(dir) {
  const errors = [];
  const raw = readJson(join(dir, 'config.json'), 'config.json', errors);
  const { config, errors: cfgErrors } = normalizeConfig(raw ?? {});
  if (raw) errors.push(...cfgErrors);
  const routing = readJson(join(dir, 'routing.json'), 'routing.json', errors) ?? [];
  if (raw) checkRouting(routing, config, errors);
  const table = Array.isArray(routing) ? routing.filter((e) => isObj(e) && typeof e.linkType === 'string' && strs(e.paths)) : [];
  return { dir, config, routing: table, linkTypes: table.map((e) => e.linkType), errors };
}

// The project the engine runs against: set once by each entry point (facts,
// publish, the learning steps) after loading it; tests set a fixture.
let active = null;
export function setActiveProject(p) {
  active = p;
}
export function activeProject() {
  if (!active) active = { dir: null, config: merge({}), routing: [], linkTypes: [], errors: ['no project loaded'] };
  return active;
}

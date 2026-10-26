// The consumer's engine config (.pr-review/config.json) and routing
// table, both read from a base-branch checkout, never the PR head. Defaults
// reproduce the recovery-platform reference wherever it had one. Validation
// returns errors instead of throwing: facts and publish fail closed on them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, bool, custom, int, list, map, num, obj, oneOf, orFalse, regex, str } from './config-schema.mjs';

// Where a consumer keeps its reviewer project, relative to a checkout root.
export const PROJECT_SUBDIR = '.pr-review';


const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const TIERS = ['none', 'base-drift', 'light', 'incremental', 'incremental-new-links', 'full'];
const PROJECT_RE = /^[A-Za-z0-9._-]{1,60}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk', 'production']);

export const DEFAULTS = Object.freeze({
  version: 1,
  project: 'project',
  visibility: 'public',
  securityChannel: null,
  workflowPath: '.github/workflows/pr-review.yml',
  learnWorkflowPath: '.github/workflows/pr-review-learn.yml',
  packages: [],
  knowledge: ['checklist.md', 'conventions.md', 'false-positives.md'],
  classes: [],
  tiers: { set: 'all', disabled: [], maxTurns: { none: 0, 'base-drift': 15, light: 15, incremental: 40, 'incremental-new-links': 60, full: 60 }, largeShare: 0.5 },
  lightFiles: ['**/*.md', '**/*.txt', '**/*.png', '**/*.jpg', '**/*.svg', '**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock'],
  lightExclude: [],
  withheld: [],
  externalCheckouts: [],
  largePr: { files: 60, lines: 5000 },
  inline: { max: 10, severities: ['Critical', 'High'] },
  secrets: { extraPatterns: [], allowPaths: [], allowPatterns: [] },
  issueBody: { extraPatterns: [] },
  style: { noEmoji: false, noEmDash: false },
  checks: {
    secrets: true,
    piiLogs: { fields: 'email|phone|address|password|token', logCall: '\\b(?:logger|console)\\.' },
    newFileSize: { maxLines: 300, pattern: '\\.(?:ts|tsx|js|jsx|mjs)$' },
    titleScope: false,
    selfEdit: true,
    verifyDiff: false,
    writeCollaborators: false,
    project: [],
  },
  trust: { contextAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'], feedbackAuthors: ['repository-owner'] },
  learning: { windowDays: 45, repeatThreshold: 2, maxLessons: 40, demote: { minVotes: 5, maxPrecision: 0.4 }, distill: 'model', branch: 'pr-review/learning', forbidden: [], commands: { format: [], validate: [] } },
});

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const strList = list(str);
const globs = list(str);
const strs = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

const classNode = obj({
  id: int(1, 999),
  name: str,
  security: bool,
  always: bool,
  light: bool,
  protected: bool,
  minConfidence: oneOf('low', 'medium', 'high'),
});

const checkoutNode = custom((v, d, path, errors) => {
  const ok = isObj(v) && /^[\w.-]+\/[\w.-]+$/.test(v.repo ?? '') && typeof v.ref === 'string' && BRANCH_RE.test(v.ref) && /^[\w.-]{1,60}$/.test(v.dir ?? '') && (v.sparse === undefined || (Array.isArray(v.sparse) && v.sparse.every((x) => typeof x === 'string' && !x.includes('..'))));
  if (!ok) {
    errors.push(`${path} must be { repo: "owner/name", ref, dir (one path segment), sparse?: [paths] }`);
    return undefined;
  }
  return { repo: v.repo, ref: v.ref, dir: v.dir, sparse: v.sparse ?? [] };
});

const SCHEMA = obj({
  version: int(1, 1),
  project: custom((v, d, path, errors) => (typeof v === 'string' && PROJECT_RE.test(v) ? v : (errors.push('project must match [A-Za-z0-9._-]{1,60}'), d))),
  visibility: oneOf('public', 'private'),
  securityChannel: oneOf('advisory', 'private-repo-issue', 'none'),
  workflowPath: str,
  learnWorkflowPath: str,
  packages: strList,
  knowledge: strList,
  classes: list(classNode),
  tiers: obj({ set: oneOf('all', 'none-light-full', 'full'), disabled: list(oneOf('base-drift', 'light', 'incremental', 'incremental-new-links')), maxTurns: map(int(0, 200), TIERS), largeShare: num(0, 1) }),
  lightFiles: globs,
  lightExclude: globs,
  withheld: globs,
  externalCheckouts: list(checkoutNode),
  largePr: obj({ files: int(1, 100000), lines: int(1, 10000000) }),
  inline: obj({ max: int(0, 50), severities: list(oneOf(...SEVERITIES)) }),
  secrets: obj({ extraPatterns: list(regex), allowPaths: globs, allowPatterns: list(regex) }),
  issueBody: obj({ extraPatterns: list(regex) }),
  style: obj({ noEmoji: bool, noEmDash: bool }),
  checks: obj({
    secrets: bool,
    piiLogs: orFalse(obj({ fields: regex, logCall: regex })),
    newFileSize: orFalse(obj({ maxLines: int(1, 100000), pattern: regex })),
    titleScope: orFalse(obj({ bareScopes: strList })),
    selfEdit: bool,
    verifyDiff: orFalse(obj({ script: str })),
    writeCollaborators: orFalse(obj({ allowed: strList })),
    project: strList,
  }),
  trust: obj({ contextAssociations: strList, feedbackAuthors: strList }),
  learning: obj({
    windowDays: int(1, 365),
    repeatThreshold: int(2, 50),
    maxLessons: int(1, 500),
    demote: obj({ minVotes: int(1, 1000), maxPrecision: num(0, 1) }),
    distill: oneOf('model', 'deterministic'),
    branch: str,
    forbidden: strList,
    commands: obj({ format: strList, validate: strList }),
  }),
});

function checkClasses(classes, errors) {
  if (!classes.length) return errors.push('classes: at least one bug class is required');
  const seen = new Set();
  for (const k of classes) {
    if (!Number.isInteger(k.id) || typeof k.name !== 'string') errors.push(`class ${JSON.stringify(k.id)}: id and name are required`);
    else if (seen.has(k.id)) errors.push(`duplicate class id ${k.id}`);
    seen.add(k.id);
  }
}

export function normalizeConfig(raw) {
  const errors = [];
  if (!isObj(raw)) return { config: { ...structuredClone(DEFAULTS), securityChannel: 'advisory' }, errors: ['config must be a JSON object'] };
  const c = apply(SCHEMA, raw, DEFAULTS, '', errors);
  if (raw.version === undefined) errors.push('version must be 1');
  if (c.securityChannel == null) c.securityChannel = c.visibility === 'private' ? 'private-repo-issue' : 'advisory';
  if (c.securityChannel === 'advisory' && c.visibility !== 'public') errors.push('securityChannel advisory requires visibility public (advisories are public-repo only)');
  if (!BRANCH_RE.test(c.learning.branch) || PROTECTED_BRANCHES.has(c.learning.branch)) errors.push('learning.branch must be a dedicated branch name, not a default branch');
  checkClasses(c.classes, errors);
  return { config: c, errors };
}

// Trust lists may name "repository-owner" instead of a login, so no login is
// committed; it resolves to the owner part of owner/name.
export function resolveAuthors(list, repo) {
  const owner = String(repo ?? '').split('/')[0].toLowerCase();
  return [...new Set((list ?? []).map((a) => (a === 'repository-owner' ? owner : String(a).toLowerCase())).filter(Boolean))];
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
  const seen = new Set();
  for (const e of routing) {
    if (isObj(e) && seen.has(e.linkType)) errors.push(`routing: duplicate link type ${e.linkType}`);
    if (isObj(e)) seen.add(e.linkType);
    if (!isObj(e) || typeof e.linkType !== 'string' || !strs(e.paths) || !strs(e.counterparts ?? []) || !Array.isArray(e.classes)) {
      errors.push(`routing entry malformed: ${JSON.stringify(e?.linkType)}`);
      continue;
    }
    for (const k of e.classes) if (!ids.has(k)) errors.push(`routing ${e.linkType}: class ${k} is not configured`);
  }
}

// dir: the project's .pr-review directory inside a base checkout.
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
  if (!active) active = { dir: null, config: normalizeConfig({}).config, routing: [], linkTypes: [], errors: ['no project loaded'] };
  return active;
}

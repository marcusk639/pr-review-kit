import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { redact, secretPatterns } from './lib/redact.mjs';
import { git } from './lib/diff.mjs';
import { PROJECT_SUBDIR, activeProject } from './lib/config.mjs';
import { learningPrOnly } from './lib/learning-pr.mjs';
import { matches } from './lib/glob.mjs';

// Every check reads its settings from the project's config.checks; a check set
// to false returns no facts.
const checks = () => activeProject().config.checks;
const REVIEW_DIR = /^\.pr-review\//;
// pull_request runs the PR's own workflow file; .pr-review/** is restored from base.
const SELF_EDIT_NOTE = {
  workflow: 'PR edits the review workflow; this edit takes effect in this run (pull_request runs the PR\'s workflow file)',
  learn: 'PR edits the learning workflow; it takes effect when the learning workflow next runs from the default branch',
  scripts: 'PR edits the review agent\'s procedure, knowledge or checks; this edit does not affect this run (the base copy is restored)',
};

const fact = (check, file, line, note) => {
  const f = { check, file, note: redact(note) };
  if (line != null) f.line = line;
  return f;
};

// secrets.allowPaths / allowPatterns: known fake test credentials, skipped.
export function checkSecrets(files) {
  const facts = [];
  if (!checks().secrets) return facts;
  const { allowPaths, allowPatterns } = activeProject().config.secrets;
  const allowed = allowPatterns.map((p) => new RegExp(p));
  for (const f of files) {
    if (f.binary || allowPaths.some((g) => matches(f.file, g))) continue;
    for (const a of f.added) {
      const hit = secretPatterns().some((re) => {
        const m = re.exec(a.text);
        return m && !allowed.some((al) => al.test(m[0]));
      });
      if (hit) facts.push(fact('secrets', f.file, a.line, 'added line matches a secret pattern; rotate and remove it'));
    }
  }
  return facts;
}

export function checkPiiLogs(files) {
  const facts = [];
  const cfg = checks().piiLogs;
  if (!cfg) return facts;
  const PII = new RegExp(cfg.fields);
  const LOG_CALL = new RegExp(cfg.logCall);
  for (const f of files) {
    if (f.binary) continue;
    f.added.forEach((a, i) => {
      if (!LOG_CALL.test(a.text)) return;
      const window = f.added.slice(i, i + 4).filter((w) => w.line - a.line <= 3);
      if (window.some((w) => PII.test(w.text))) {
        facts.push(fact('pii-logs', f.file, a.line, 'log statement near a PII-named field; confirm no PII is logged'));
      }
    });
  }
  return facts;
}

export function checkNewFileSize(files, repoRoot) {
  const facts = [];
  const cfg = checks().newFileSize;
  if (!cfg) return facts;
  const CODE = new RegExp(cfg.pattern);
  for (const f of files) {
    if (f.status !== 'A' || f.binary || !CODE.test(f.file)) continue;
    const p = join(repoRoot, f.file);
    // Never follow a link the PR planted (it could point at runner files):
    // the file itself and every parent must resolve inside the checkout.
    if (!existsSync(p) || lstatSync(p).isSymbolicLink() || !realpathSync(p).startsWith(realpathSync(repoRoot) + sep)) continue;
    const text = readFileSync(p, 'utf8');
    const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    if (lines > cfg.maxLines) facts.push(fact('file-size', f.file, null, `new file is ${lines} lines (limit ${cfg.maxLines}); split into modules`));
  }
  return facts;
}

export function checkTitleScope(title) {
  const cfg = checks().titleScope;
  if (!cfg) return [];
  const m = /^\w+\(([^)]*)\)!?:/.exec(String(title ?? ''));
  if (m && cfg.bareScopes.includes(m[1])) {
    return [fact('title-scope', 'PR title', null, `scope '${m[1]}' is bare; name the product, e.g. regroup-${m[1]}`)];
  }
  return [];
}

// ctx (optional): { baseSha, headSha, repoRoot, learningPrApi }. A pure learning
// PR (API-verified bot PR and commits, changes confined to learned memory) gets
// one learning-pr fact instead.
export function checkSelfEdit(files, ctx = {}) {
  if (!checks().selfEdit) return [];
  const { workflowPath, learnWorkflowPath } = activeProject().config;
  const kind = (p) => (p === workflowPath ? 'workflow' : p === learnWorkflowPath ? 'learn' : REVIEW_DIR.test(p ?? '') ? 'scripts' : null);
  const hits = files.map((f) => [f, kind(f.file) ?? kind(f.oldFile)]).filter(([, k]) => k);
  if (hits.length && hits.every(([, k]) => k === 'scripts') && ctx.headSha && ctx.learningPrApi === true && learningPrOnly(ctx.baseSha, ctx.headSha, ctx.repoRoot)) {
    return [fact('learning-pr', PROJECT_SUBDIR, null, 'learning PR: bot commits confined to learned memory; review the lessons themselves (scope, wording, coverage), not as a self-edit')];
  }
  return hits.map(([f, k]) => fact('self-edit', f.file, null, SELF_EDIT_NOTE[k]));
}

const PIN_RE = /pr-review-kit\/actions\/[\w-]+@([^\s'"]+)/g;
const pins = (text) => [...new Set([...String(text ?? '').matchAll(PIN_RE)].map((m) => m[1]))];
const short = (p) => (/^[0-9a-f]{40}$/.test(p) ? p.slice(0, 7) : p);

// The kit SHA the review workflow pins, base side vs PR side. pull_request runs
// the PR's workflow file, so a changed pin changes the engine this run uses.
export function checkEnginePin({ base, head }) {
  if (base == null || head == null) return [];
  const before = pins(base);
  const after = pins(head);
  const out = [];
  if (after.some((p) => !/^[0-9a-f]{40}$/.test(p))) out.push(fact('engine-pin', activeProject().config.workflowPath, null, 'the review workflow uses the kit at a ref that is not pinned to a full commit SHA'));
  else if (after.join() !== before.join()) {
    out.push(fact('engine-pin', activeProject().config.workflowPath, null, `kit pin changed from ${before.map(short).join(', ') || 'none'} to ${after.map(short).join(', ') || 'none'}; this run uses the PR's pin`));
  }
  return out;
}

// verify-diff compares against the PR's fork point: base.sha itself may have
// moved past it, which would blame the PR for base-branch changes.
export function runVerifyDiff(baseSha, repoRoot, scriptPath, headSha) {
  if (!scriptPath) return [];
  const script = resolve(repoRoot, scriptPath);
  const unavailable = () => [fact('verify-diff', 'verify-diff.sh', null, 'verify-diff unavailable')];
  if (!existsSync(script)) return unavailable();
  let since = baseSha;
  if (headSha) {
    try {
      since = git(['merge-base', baseSha, headSha], repoRoot).trim();
    } catch {
      return unavailable();
    }
  }
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-verify-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-verify-home-'));
  const repo = resolve(repoRoot);
  try {
    // Base-branch script, isolated like a project check: no token or secret,
    // an empty cwd and HOME, and no user, system or command-line git config,
    // so a PR's .gitconfig, .config/git/config or .gitattributes driver can
    // never run. git finds the repository through GIT_DIR/GIT_WORK_TREE;
    // scripts get <since> <head> and should diff objects (git diff "$1" "$2").
    execFileSync('bash', [script, since, headSha ?? ''], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        XDG_CONFIG_HOME: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_COUNT: '0',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_DIR: join(repo, '.git'),
        GIT_WORK_TREE: repo,
        PR_REVIEW_REPO: repo,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
    return [];
  } catch (err) {
    if (err.status !== 1) return unavailable();
    const facts = String(err.stdout ?? '')
      .split('\n')
      .filter((l) => /^\s*\[/.test(l))
      .map((l) => fact('verify-diff', 'verify-diff.sh', null, l.trim()));
    return facts.length ? facts : unavailable();
  }
}

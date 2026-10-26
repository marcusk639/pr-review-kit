// Project-specific deterministic checks: ES modules under the consumer's
// .pr-review/ (config.checks.project), from the trust checkout only. Each runs
// in a child process (check-child.mjs) with a PATH-only env (no GH_TOKEN, no
// runner secrets), an empty temp dir as cwd, and a hard kill after
// checks.timeoutMs: a PR cannot reach a token through a check, and a check
// that hangs or backtracks forever is "pre-check unavailable: <name> (timeout)".
// Helpers: git(args) (git -C repoRoot), readHead/readBase/listFiles (git
// objects, never through a link), parseOnly(kind, text), mergeBase. Checks
// must be synchronous. Notes are redacted and capped here, in the parent, and
// withheld paths are replaced by a stable hash.
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './redact.mjs';
import { activeProject } from './config.mjs';
import { matches } from './glob.mjs';

const CHILD = fileURLToPath(new URL('./check-child.mjs', import.meta.url));
const MAX_LINE = 2000;
const MAX_NOTE = 300;

export function resolveProjectChecks(dir, list = []) {
  const paths = [];
  const errors = [];
  for (const rel of list) {
    const full = typeof rel === 'string' && !isAbsolute(rel) ? resolve(dir, rel) : null;
    const r = full ? relative(resolve(dir), full) : '';
    if (!full || !r || r.startsWith('..') || isAbsolute(r)) errors.push(`project check ${rel}: path outside .pr-review`);
    else if (!existsSync(full)) errors.push(`project check ${rel}: missing`);
    else paths.push(full);
  }
  return { paths, errors };
}

const hash8 = (p) => createHash('sha256').update(p).digest('hex').slice(0, 8);

function cleanFact(name, f) {
  if (!f || typeof f !== 'object' || typeof f.file !== 'string' || typeof f.note !== 'string') return null;
  const withheld = activeProject().config.withheld;
  const hide = (p) => (withheld.some((g) => matches(p, g)) ? `withheld:${hash8(p)}` : p);
  let note = redact(f.note);
  for (const tok of note.match(/[\w.~@%+-]*\/[\w./~@%+-]+/g) ?? []) if (hide(tok) !== tok) note = note.split(tok).join(hide(tok));
  const check = typeof f.check === 'string' && /^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(f.check) ? f.check : name;
  const out = { check, file: hide(redact(f.file.slice(0, 300))), note: note.replace(/\s+/g, ' ').slice(0, MAX_NOTE) };
  if (Number.isInteger(f.line) && f.line >= 0) out.line = f.line;
  return out;
}

// Long lines are where catastrophic regexes bite: checks never see them.
function trimFiles(files) {
  let skipped = 0;
  const keep = (lines) => (lines ?? []).filter((l) => (String(l.text).length > MAX_LINE ? (skipped++, false) : true));
  return { files: (files ?? []).map((f) => ({ ...f, added: keep(f.added), removed: keep(f.removed) })), skipped };
}

function runModule(module, ctx, timeoutMs) {
  return new Promise((done) => {
    const cwd = mkdtempSync(join(tmpdir(), 'pr-review-check-'));
    const results = [];
    let current = null;
    let finished = false;
    const child = fork(CHILD, [], { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, execArgv: [], serialization: 'json', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const end = (extra) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      rmSync(cwd, { recursive: true, force: true });
      done([...results, ...extra]);
    };
    const timer = setTimeout(() => {
      const name = current ?? basename(module);
      end([{ check: name, error: new Error('timeout'), timeout: true }, ...(current ? [{ check: basename(module), error: new Error('not run: an earlier check timed out') }] : [])]);
    }, timeoutMs);
    child.on('message', (m) => {
      if (m?.type === 'start') current = m.name;
      else if (m?.type === 'result') {
        current = null;
        const facts = m.error ? null : m.facts.map((f) => cleanFact(m.name, f));
        results.push(m.error || !facts.every(Boolean) ? { check: m.name, error: new Error(m.error ?? 'malformed fact') } : { check: m.name, facts });
      } else if (m?.type === 'bad-entry') results.push({ check: basename(module), error: new Error('an entry has no valid name or run()') });
      else if (m?.type === 'load-error') end([{ check: basename(module), error: new Error('could not be loaded') }]);
      else if (m?.type === 'done') end([]);
    });
    child.on('exit', () => end(current ? [{ check: current, error: new Error('exited') }] : []));
    child.on('error', () => end([{ check: basename(module), error: new Error('could not start') }]));
    child.send({ module, ctx });
  });
}

// ctx: { files, repoRoot, baseSha, headSha, mergeBase, title, config }.
export async function runProjectChecks(paths, ctx, { timeoutMs = activeProject().config.checks.timeoutMs ?? 20000 } = {}) {
  const { files, skipped } = trimFiles(ctx.files);
  const safeCtx = { ...ctx, files, config: JSON.parse(JSON.stringify(ctx.config ?? activeProject().config)) };
  const out = [];
  for (const p of paths) out.push(...(await runModule(p, safeCtx, timeoutMs)));
  if (skipped) out.push({ check: 'long-lines', facts: [{ check: 'long-lines', file: 'diff', note: `${skipped} diff line(s) over ${MAX_LINE} characters were not given to project checks` }] });
  return out;
}

// Project-specific deterministic checks: ES modules under the consumer's
// .pr-review/ (config.checks.project), loaded only from the base
// checkout the caller passes in, never from the PR head. Each module's default
// export is [{ name, run(ctx) => facts[] }]. A check that throws or returns
// something other than an array of facts is "unavailable", never fatal.
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from './diff.mjs';
import { listAt, readAt } from './git-read.mjs';

const NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const MAX_FACTS = 200;

function inside(dir, rel) {
  if (typeof rel !== 'string' || isAbsolute(rel)) return null;
  const full = resolve(dir, rel);
  const r = relative(resolve(dir), full);
  return r && !r.startsWith('..') && !isAbsolute(r) ? full : null;
}

// errors: fixed text naming the module path only (never a message or stack).
export async function loadProjectChecks(dir, list = []) {
  const checks = [];
  const errors = [];
  for (const rel of list) {
    const full = inside(dir, rel);
    if (!full) {
      errors.push(`project check ${rel}: path outside .pr-review`);
      continue;
    }
    let mod;
    try {
      mod = await import(pathToFileURL(full).href);
    } catch {
      errors.push(`project check ${rel}: could not be loaded`);
      continue;
    }
    for (const c of Array.isArray(mod.default) ? mod.default : []) {
      if (c && NAME_RE.test(String(c.name)) && typeof c.run === 'function') checks.push({ name: c.name, run: c.run });
      else errors.push(`project check ${rel}: an entry has no valid name or run()`);
    }
  }
  return { checks, errors };
}

const cleanFact = (name) => (f) => {
  if (!f || typeof f !== 'object' || typeof f.file !== 'string' || typeof f.note !== 'string') return null;
  const out = { check: name, file: f.file.slice(0, 300), note: f.note.slice(0, 1000) };
  if (Number.isInteger(f.line) && f.line >= 0) out.line = f.line;
  return out;
};

// ctx: { files, repoRoot, baseSha, headSha, title, config }. Helpers read from
// git objects (never the working tree, never through a symlink): readHead,
// readBase (null when absent or a symlink), listFiles(glob) at head, and
// git(args). Checks must be synchronous; a returned promise is "unavailable".
export function runProjectChecks(checks, ctx) {
  const helpers = {
    ...ctx,
    git: (args) => git(args, ctx.repoRoot),
    readHead: (p) => readAt(ctx.headSha, p, ctx.repoRoot),
    readBase: (p) => readAt(ctx.baseSha, p, ctx.repoRoot),
    listFiles: (glob) => listAt(ctx.headSha, glob, ctx.repoRoot),
  };
  return checks.map(({ name, run }) => {
    try {
      const out = run(helpers);
      if (!Array.isArray(out)) return { check: name, error: new Error('not an array') };
      const facts = out.slice(0, MAX_FACTS).map(cleanFact(name));
      return facts.every(Boolean) ? { check: name, facts } : { check: name, error: new Error('malformed fact') };
    } catch (error) {
      return { check: name, error };
    }
  });
}

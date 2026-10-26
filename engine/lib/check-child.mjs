// Child process for project checks (forked by project-checks.mjs with a
// PATH-only env and an empty temp cwd). Loads one module from the trust
// checkout and runs its checks, reporting each over IPC: start, then result.
// It never sees a token; git reaches the repository only through -C.
import { pathToFileURL } from 'node:url';
import { git } from './diff.mjs';
import { listAt, readAt } from './git-read.mjs';
import { parseOnly } from './parse-only.mjs';

const NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;

process.on('message', async ({ module, ctx }) => {
  const send = (m) => process.send(m);
  let entries;
  try {
    const mod = await import(pathToFileURL(module).href);
    entries = Array.isArray(mod.default) ? mod.default : null;
  } catch {
    entries = null;
  }
  if (!entries) {
    send({ type: 'load-error' });
    return process.exit(0);
  }
  const helpers = {
    ...ctx,
    git: (args) => git(args, ctx.repoRoot),
    readHead: (p) => readAt(ctx.headSha, p, ctx.repoRoot),
    readBase: (p) => readAt(ctx.baseSha, p, ctx.repoRoot),
    listFiles: (glob) => listAt(ctx.headSha, glob, ctx.repoRoot),
    parseOnly,
  };
  for (const c of entries) {
    if (!c || !NAME_RE.test(String(c.name)) || typeof c.run !== 'function') {
      send({ type: 'bad-entry' });
      continue;
    }
    send({ type: 'start', name: c.name });
    try {
      const out = c.run(helpers);
      send(Array.isArray(out) ? { type: 'result', name: c.name, facts: out.slice(0, 200) } : { type: 'result', name: c.name, error: 'not an array' });
    } catch {
      send({ type: 'result', name: c.name, error: 'threw' });
    }
  }
  send({ type: 'done' });
  process.exit(0);
});

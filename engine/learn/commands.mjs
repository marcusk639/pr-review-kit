// The consumer's own format and validate commands (config.learning.commands),
// run on the proposed tree before anything is proposed, so the learning PR
// passes the repo's checks without CI on that branch (a PAT or dispatch there
// would turn "push to the learning branch" into "get secrets"). They run in a
// scratch copy of HEAD, never the checkout, with no secrets in the environment.
// {files} expands to the changed files, shell-quoted. A failing format or
// validate command means nothing is proposed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// proposed: { [path]: text }. Returns { ok, texts, results: [{ kind, command, ok }] }.
export function runLearnCommands({ root, proposed, commands, timeout = 300000 }) {
  const all = [...(commands?.format ?? []).map((c) => ['format', c]), ...(commands?.validate ?? []).map((c) => ['validate', c])];
  if (!all.length) return { ok: true, texts: proposed, results: [] };
  const scratch = mkdtempSync(join(tmpdir(), 'pr-review-learn-tree-'));
  const tar = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: root, maxBuffer: 512 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', scratch], { input: tar, maxBuffer: 512 * 1024 * 1024 });
  for (const [p, t] of Object.entries(proposed)) {
    mkdirSync(dirname(join(scratch, p)), { recursive: true });
    writeFileSync(join(scratch, p), t);
  }
  const home = mkdtempSync(join(tmpdir(), 'pr-review-learn-home-'));
  const env = { PATH: process.env.PATH, HOME: home, CI: 'true', NODE_OPTIONS: '' };
  const files = Object.keys(proposed).map(quote).join(' ');
  const results = [];
  for (const [kind, command] of all) {
    let ok = true;
    try {
      execFileSync('bash', ['-c', command.replaceAll('{files}', files)], { cwd: scratch, env, stdio: ['ignore', 'ignore', 'ignore'], timeout });
    } catch {
      ok = false;
    }
    results.push({ kind, command, ok });
    if (!ok) return { ok: false, texts: proposed, results };
  }
  const texts = Object.fromEntries(Object.keys(proposed).map((p) => [p, readFileSync(join(scratch, p), 'utf8')]));
  return { ok: true, texts, results };
}

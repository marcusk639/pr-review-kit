// parseOnly(kind, content): does this text parse? Never executes it. The
// content goes in on stdin (or a temp file node needs), the parser runs in an
// empty temp dir with PATH-only env, python with -I (no cwd, no site, no user
// paths: a PR-planted ast.py cannot be imported), a timeout and an output cap.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_IN = 2 * 1024 * 1024;
const PY = 'import ast,sys\ntry:\n    ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n    print(f"line {e.lineno}: {e.msg}"); sys.exit(1)\n';

// The parser's own message (stdout for the python helper, stderr for bash and
// node), with node's file:line folded into "line N:". ENOENT is not a syntax
// error: it says the interpreter is missing.
function message(cmd, err) {
  const out = `${String(err?.stdout ?? '').trim()}\n${String(err?.stderr ?? '').trim()}`.trim();
  if (cmd === process.execPath) {
    const line = /input\.mjs:(\d+)/.exec(out)?.[1];
    const what = out.split('\n').find((l) => /Error/.test(l)) ?? 'syntax error';
    return `${line ? `line ${line}: ` : ''}${what.trim()}`;
  }
  return (out.split('\n').find((l) => l.trim()) ?? 'parse error').replace(/^bash: /, '');
}

function run(cmd, args, input, cwd) {
  try {
    execFileSync(cmd, args, { cwd, input, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 64 * 1024 });
    return { ok: true };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, error: `interpreter missing: ${cmd === process.execPath ? 'node' : cmd}`, missing: true };
    return { ok: false, error: message(cmd, err).slice(0, 200) };
  }
}

export function parseOnly(kind, content) {
  const text = String(content ?? '');
  if (text.length > MAX_IN) return { ok: false, error: 'too large to parse' };
  if (kind === 'json') {
    try {
      JSON.parse(text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message).slice(0, 200) };
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-parse-'));
  try {
    if (kind === 'python') return run('python3', ['-I', '-c', PY], text, dir);
    if (kind === 'bash') return run('bash', ['-n'], text, dir);
    if (kind === 'node') {
      const f = join(dir, 'input.mjs');
      writeFileSync(f, text);
      return run(process.execPath, ['--check', f], '', dir);
    }
    return { ok: false, error: `unknown kind ${kind}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

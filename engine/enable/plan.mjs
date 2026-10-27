// Pure logic for bin/enable-repo.mjs: argument parsing, reading a consumer's
// secret and variable wiring from its workflows, and the go/no-go rules. No
// GitHub or filesystem access here, so every rule is unit-tested.

export const STEPS = ['preflight', 'inbox', 'secrets', 'settings', 'merge', 'test-pr'];
export const DEFAULT_STEPS = ['preflight', 'inbox', 'secrets', 'settings'];
const FLAGS = new Set(['apply', 'rotate', 'create-inbox', 'keep-test-pr', 'allow-other-writers', 'help']);

export function parseArgs(argv) {
  const o = { steps: DEFAULT_STEPS, branch: 'chore/pr-review', apply: false, waitMinutes: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (FLAGS.has(k)) {
      o[camel(k)] = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    o[camel(k)] = v;
  }
  if (o.help) return o;
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo ?? '')) throw new Error('--repo owner/name is required');
  if (typeof o.steps === 'string') o.steps = o.steps.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = o.steps.filter((s) => !STEPS.includes(s));
  if (bad.length) throw new Error(`unknown step(s): ${bad.join(', ')} (known: ${STEPS.join(', ')})`);
  if (o.inbox && !/^[\w.-]+\/[\w.-]+$/.test(o.inbox)) throw new Error('--inbox must be owner/name');
  if (o.mergeMethod && !['merge', 'squash', 'rebase'].includes(o.mergeMethod)) throw new Error('--merge-method must be merge, squash or rebase');
  if (o.steps.includes('merge') && !o.mergeMethod) throw new Error('the merge step needs --merge-method merge|squash|rebase');
  if (o.pr !== undefined && !/^\d+$/.test(o.pr)) throw new Error('--pr must be a number');
  o.waitMinutes = Number(o.waitMinutes);
  if (!Number.isFinite(o.waitMinutes) || o.waitMinutes <= 0) throw new Error('--wait-minutes must be a positive number');
  return o;
}

const camel = (k) => k.replace(/-(\w)/g, (_, c) => c.toUpperCase());

// Kit inputs that carry secrets, and the variable input; read from the
// consumer's own workflows so a renamed secret (FIRM_CLAUDE_CODE_OAUTH_TOKEN)
// needs no flag.
const SECRET_INPUTS = ['claude_code_oauth_token', 'id_key', 'advisory_token', 'private_issue_token', 'redact_terms'];
const VAR_INPUTS = ['private_repo'];

export function wiringFrom(texts) {
  const secrets = new Map();
  const vars = new Map();
  for (const t of texts) {
    for (const line of String(t ?? '').split('\n')) {
      if (/^\s*#/.test(line)) continue;
      const s = /^\s*([\w-]+):\s*\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/.exec(line);
      if (s && SECRET_INPUTS.includes(s[1])) secrets.set(s[2], s[1]);
      const v = /^\s*([\w-]+):\s*\$\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/.exec(line);
      if (v && VAR_INPUTS.includes(v[1])) vars.set(v[2], v[1]);
    }
  }
  return {
    secrets: [...secrets].map(([name, role]) => ({ name, role })),
    vars: [...vars].map(([name, role]) => ({ name, role })),
  };
}

// The kit pins in a workflow (every kit `uses:` must carry the same SHA).
export function kitPins(texts) {
  const shas = new Set();
  for (const t of texts) for (const m of String(t ?? '').matchAll(/pr-review-kit\/actions\/[\w-]+@([0-9a-f]{40})/g)) shas.add(m[1]);
  return [...shas];
}

// Writers other than the owner, and pending invitations. Private repos must
// have neither before any secret is set: any writer can read secrets by
// pushing a branch that edits the workflow.
export function writerRisk({ collaborators = [], invitations = [], owner, visibility }) {
  const others = collaborators.filter((c) => c?.login && c.login.toLowerCase() !== String(owner).toLowerCase() && (c.permissions?.push || c.permissions?.maintain || c.permissions?.admin)).map((c) => c.login);
  const invited = invitations.map((i) => ({ login: i?.invitee?.login ?? '(unknown)', permission: i?.permissions ?? 'unknown' }));
  const blocking = others.length > 0 || invited.some((i) => i.permission !== 'read');
  return { others, invited, blocking, private: visibility !== 'public' };
}

// How each secret's value is obtained. Values never come from argv (shell
// history, ps): from an environment variable of the same name, a file, or a
// hidden prompt; the id key is generated.
export function secretSources(wiring, { redactTermsFile } = {}) {
  return wiring.secrets.map(({ name, role }) => {
    if (role === 'id_key') return { name, role, source: 'generate' };
    if (role === 'redact_terms') return { name, role, source: redactTermsFile ? 'file' : 'env-or-skip', file: redactTermsFile };
    return { name, role, source: 'env-or-prompt' };
  });
}

// A PR is ready to merge when every check has finished and none failed.
export function checksReady(rollup = []) {
  const pending = rollup.filter((c) => (c.status ?? c.state) && !['COMPLETED', 'SUCCESS', 'FAILURE', 'ERROR', 'SKIPPED', 'NEUTRAL'].includes(String(c.status ?? c.state).toUpperCase()));
  const failed = rollup.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(String(c.conclusion ?? c.state ?? '').toUpperCase()));
  return { ready: pending.length === 0 && failed.length === 0, pending: pending.map((c) => c.name ?? c.context), failed: failed.map((c) => c.name ?? c.context) };
}

import './helpers/rp.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { redact, SECRET_PATTERNS } from '../lib/redact.mjs';
import {
  checkSecrets,
  checkPiiLogs,
  checkNewFileSize,
  checkTitleScope,
  checkSelfEdit,
  runVerifyDiff,
} from '../hygiene.mjs';

// Secret-shaped fixtures are built at runtime so the repo secret scan never sees a literal.
const FAKE_WHSEC = 'whsec' + '_' + 'A'.repeat(16);
const FAKE_SK_TEST = 'sk' + '_test_' + 'x'.repeat(24);
const FAKE_AKIA = 'AKIA' + 'B'.repeat(16);
const FAKE_GH = 'gh' + 'p_' + 'c'.repeat(24);
const FAKE_PEM = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
const FAKE_GH_PAT = 'github' + '_pat_' + 'D'.repeat(11) + '_' + 'e'.repeat(30);
const FAKE_GHR = 'gh' + 'r_' + 'f'.repeat(24);

const file = (over) => ({ file: 'a.ts', oldFile: 'a.ts', status: 'M', binary: false, added: [], removed: [], ...over });
const add = (...texts) => texts.map((text, i) => ({ line: i + 1, text }));

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'hygiene-'));
  const put = (p, c) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  };
  put('big.ts', 'x\n'.repeat(301));
  put('small.ts', 'x\n'.repeat(10));
  put('big.md', 'x\n'.repeat(400));
  put('fail.sh', 'echo "[TAG] violation one"\necho "noise"\necho "[TAG] violation two"\nexit 1\n');
  put('ok.sh', 'exit 0\n');
  put('silent1.sh', 'echo noise\nexit 1\n');
  put('crash.sh', 'exit 2\n');
});
after(() => rmSync(root, { recursive: true, force: true }));

test('redact truncates a secret to its first 6 chars plus ellipsis', () => {
  assert.equal(redact('k=' + FAKE_WHSEC), 'k=whsec_…');
});

test('redact covers each pattern family and is pure on clean text', () => {
  for (const s of [FAKE_SK_TEST, FAKE_AKIA, FAKE_GH, FAKE_PEM, FAKE_GH_PAT, FAKE_GHR]) {
    const out = redact('v ' + s + ' end');
    assert.ok(!out.includes(s), s.slice(0, 8));
    assert.ok(out.includes('…'));
  }
  assert.equal(redact('nothing secret here'), 'nothing secret here');
  assert.ok(SECRET_PATTERNS.every((r) => r instanceof RegExp));
});

test('checkSecrets flags an added secret without echoing it', () => {
  const facts = checkSecrets([file({ added: add('const k = "' + FAKE_SK_TEST + '";') })]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].check, 'secrets');
  assert.equal(facts[0].file, 'a.ts');
  assert.equal(facts[0].line, 1);
  assert.ok(!facts[0].note.includes(FAKE_SK_TEST.slice(0, 7)));
  assert.ok(!facts[0].note.includes(FAKE_SK_TEST.slice(7)));
  const scrubbed = redact('const k = "' + FAKE_SK_TEST + '";');
  assert.ok(!scrubbed.includes(FAKE_SK_TEST.slice(0, 7)));
  assert.ok(!scrubbed.includes(FAKE_SK_TEST.slice(6)));
});

test('checkSecrets skips binary files and clean lines', () => {
  assert.deepEqual(checkSecrets([file({ binary: true, added: add(FAKE_SK_TEST) })]), []);
  assert.deepEqual(checkSecrets([file({ added: add('const a = 1;') })]), []);
});

test('checkPiiLogs flags logger line with email', () => {
  const facts = checkPiiLogs([file({ added: add('logger.info("x", { email });') })]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].check, 'pii-logs');
});

test('checkPiiLogs flags PII within the next 3 lines only', () => {
  const near = checkPiiLogs([file({ added: add('console.log({', 'a: 1,', 'b: 2,', 'phone: p', '});') })]);
  assert.equal(near.length, 1);
  const far = checkPiiLogs([file({ added: add('console.log({', 'a: 1,', 'b: 2,', 'c: 3,', 'phone: p') })]);
  assert.equal(far.length, 0);
  assert.deepEqual(checkPiiLogs([file({ added: add('const email = x;') })]), []);
});

test('checkNewFileSize flags only new code files over 300 lines', () => {
  const f = checkNewFileSize(
    [
      file({ file: 'big.ts', status: 'A' }),
      file({ file: 'small.ts', status: 'A' }),
      file({ file: 'big.md', status: 'A' }),
      file({ file: 'big.ts', status: 'M' }),
      file({ file: 'missing.ts', status: 'A' }),
    ],
    root,
  );
  assert.equal(f.length, 1);
  assert.equal(f[0].file, 'big.ts');
  assert.equal(f[0].check, 'file-size');
});

test('checkTitleScope', () => {
  assert.equal(checkTitleScope('fix(mobile): x').length, 1);
  assert.equal(checkTitleScope('feat(functions): x').length, 1);
  assert.deepEqual(checkTitleScope('fix(regroup-mobile): x'), []);
  assert.deepEqual(checkTitleScope('ci: x'), []);
});

test('checkSelfEdit', () => {
  assert.equal(checkSelfEdit([file({ file: '.pr-review/REVIEW.md' })]).length, 1);
  assert.equal(checkSelfEdit([file({ file: '.github/workflows/claude-code-review.yml' })]).length, 1);
  assert.deepEqual(checkSelfEdit([file({ file: 'regroup/a.ts' })]), []);
});

test('checkSelfEdit says the workflow edit takes effect and the scripts edit does not', () => {
  const [wf] = checkSelfEdit([file({ file: '.github/workflows/claude-code-review.yml' })]);
  assert.match(wf.note, /takes effect in this run/);
  const [scripts] = checkSelfEdit([file({ file: '.pr-review/checks/facts.mjs' })]);
  assert.match(scripts.note, /does not affect this run/);
});

test('runVerifyDiff passes the merge-base of base and head, not base', () => {
  const repo = join(root, 'mb-repo');
  mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
  const commitFile = (name) => {
    writeFileSync(join(repo, name), `${name}\n`);
    g('add', name);
    g('commit', '-q', '-m', name);
    return g('rev-parse', 'HEAD');
  };
  g('init', '-q', '-b', 'main');
  const fork = commitFile('seed.txt');
  g('checkout', '-q', '-b', 'pr');
  const head = commitFile('pr.txt');
  g('checkout', '-q', 'main');
  const base = commitFile('later.txt');
  writeFileSync(join(root, 'echo.sh'), 'echo "[ARG] $1"\nexit 1\n');
  const [f] = runVerifyDiff(base, repo, join(root, 'echo.sh'), head);
  assert.equal(f.note, `[ARG] ${fork}`);
  const bad = runVerifyDiff('0'.repeat(40), repo, join(root, 'echo.sh'), head);
  assert.deepEqual(bad.map((x) => x.note), ['verify-diff unavailable']);
});

test('runVerifyDiff: exit 1 yields stdout lines; exit 0 yields []; a missing script is unavailable', () => {
  const f = runVerifyDiff('abc', root, join(root, 'fail.sh'));
  assert.equal(f.length, 2);
  assert.equal(f[0].check, 'verify-diff');
  assert.equal(f[0].note, '[TAG] violation one');
  assert.deepEqual(runVerifyDiff('abc', root, join(root, 'ok.sh')), []);
  assert.deepEqual(runVerifyDiff('abc', root, join(root, 'nope.sh')).map((x) => x.note), ['verify-diff unavailable']);
});

test('redact removes a PEM body, with and without an END line', () => {
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
  const full = redact(FAKE_PEM + '\n' + body + '\n-----END ' + 'RSA PRIVATE KEY-----\nafter');
  assert.ok(!full.includes(body));
  assert.ok(full.endsWith('\nafter'));
  assert.ok(!redact(FAKE_PEM + '\n' + body).includes(body));
});

test('identifiers containing a prefix are untouched and not flagged', () => {
  for (const id of ['task_test_fixtures', 'capture_screenshotOfTheWholePage()']) {
    assert.equal(redact(id), id);
    assert.deepEqual(checkSecrets([file({ added: add('const x = ' + id + ';') })]), []);
  }
  assert.equal(redact('k=' + FAKE_SK_TEST), 'k=sk_tes…');
});

test('SECRET_PATTERNS are stateless (non-global)', () => {
  assert.ok(SECRET_PATTERNS.every((r) => !r.global && !r.sticky));
});

test('runVerifyDiff reports unavailable on silent failure or crash', () => {
  for (const s of ['silent1.sh', 'crash.sh']) {
    const f = runVerifyDiff('abc', root, join(root, s));
    assert.equal(f.length, 1);
    assert.equal(f[0].note, 'verify-diff unavailable');
  }
  assert.equal(runVerifyDiff('abc', root, 'fail.sh').length, 2);
});

test('secrets after an underscore are redacted and flagged', () => {
  const FAKE_SK_LIVE = 'sk' + '_live_' + 'y'.repeat(24);
  const out = redact('KEY_' + FAKE_SK_LIVE);
  assert.ok(!out.includes(FAKE_SK_LIVE.slice(0, 7)));
  assert.ok(!out.includes(FAKE_SK_LIVE.slice(6)));
  assert.equal(checkSecrets([file({ added: add('const KEY_' + FAKE_SK_LIVE + ';') })]).length, 1);
});

test('re_ family needs a digit in the body', () => {
  const plain = 'my_re_' + 'a'.repeat(25);
  assert.equal(redact(plain), plain);
  assert.equal(redact('x=re_' + 'a'.repeat(20) + '7'), 'x=re_aaa…');
});

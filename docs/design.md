# pr-review-kit — design

**Date:** 2026-10-26 · **Status:** draft for Marcus's checkpoint · **Reference:** `marcusk639/recovery-platform` at
`1eee0d7` (`docs/superpowers/specs/2026-10-22-pr-review-agent-design.md`, `.github/workflows/claude-code-review.yml`,
`.claude/pr-review/`).

The kit is the shared engine for the repo-aware, advisory PR reviewer: the model-free facts and publish pipeline,
tiering, the ledger, fingerprints, rendering, inline posting and its guards, redaction, the security channel, and
the feedback-learning pipeline. Each consumer repo keeps its own knowledge, config and project-specific checks under
`.claude/pr-review/`. Everything below is a decision; open questions for Marcus are collected in §9.

## 1. What is generic and what is recovery-platform's

Every coupling point found in the reference, and where it goes.

| Coupling point in the reference                                                                                                                                                                                                                                        | Where it lands                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/routing.mjs`: hard-coded `PACKAGES` list, `ALWAYS_CLASSES = [13, 14]`, `routing.json` read from a path relative to the script                                                                                                                                     | config `packages`, `classes[].always`; routing table read from the consumer's base-branch `.claude/pr-review/routing.json`                                                                                                   |
| `lib/increment.mjs` and `publish.mjs` (`knownLinkTypes`) read `routing.json` relative to the script                                                                                                                                                                    | same: passed in from the loaded project                                                                                                                                                                                      |
| `lib/tier.mjs`: `MAX_TURNS`, `LIGHT_RE` (`md/txt/png/jpg/svg`), the lockfile set, the 0.5-of-PR "large share" rule                                                                                                                                                     | config `tiers.maxTurns`, `lightFiles`, `tiers.largeShare`; `tiers.enabled: false` collapses every run to `full`/`none` (for small repos)                                                                                     |
| `lib/findings.mjs`: slug regex `c(1–14)`, class range 1–14, `SECURITY_CLASSES = {1,4,7,11,14}`                                                                                                                                                                         | config `classes` (id, name, `security`, `always`, `light`); slug regex accepts `c<1–999>`; validation checks the id is a configured class                                                                                    |
| `lib/inline-post.mjs`: the same slug regex, `MAX_INLINE = 10`, Critical/High only                                                                                                                                                                                      | config `inline.max`, `inline.severities` (default unchanged)                                                                                                                                                                 |
| `advisories.mjs`: advisory package name `recovery-platform/<pkg>`                                                                                                                                                                                                      | config `project`                                                                                                                                                                                                             |
| `hygiene.mjs`: PII field regex (`sobrietyDate`, `clientEmail`…), log-call regex, code-file regex, the 300-line new-file rule, bare title scopes `mobile/web/functions`, the self-edit paths (`claude-code-review.yml`)                                                 | config `checks.piiLogs`, `checks.newFileSize` (`maxLines`, `pattern`, or off), `checks.titleScope` (`bareScopes`, or off), `workflowPath`                                                                                    |
| `facts.mjs`: `verify-diff.sh` at `../../agent-gates/verify-diff.sh` relative to the script                                                                                                                                                                             | config `checks.verifyDiff.script` (repo-relative, run from the base checkout; off when unset)                                                                                                                                |
| `contracts.mjs` (callable exports, region, twin files) and `contracts-firestore.mjs` (queries vs indexes, storage paths, collections vs rules)                                                                                                                         | **stay in recovery-platform** as project checks through the extension point (§2.3). They encode Firebase layout and the homegroups/regroup twin list; nothing in them is reusable as written.                                |
| `facts.mjs`, `state.mjs`: trusted commenters = author association `OWNER/MEMBER/COLLABORATOR`                                                                                                                                                                          | config `trust.contextAssociations` (PR context) and the new `trust.feedbackAuthors` (logins; learning and in-PR feedback)                                                                                                    |
| `redact.mjs`: secret pattern list                                                                                                                                                                                                                                      | generic list stays in the kit; config `secrets.extraPatterns` adds project ones                                                                                                                                              |
| `REVIEW.md`: three named contract maps and an owner table, class numbers (13/14 always, 8/11/13 on light, 1–7 for large PRs, 1/4/7/11/14 security), "cross-package", the workflow filename, `## review-config` section, "the repository is public", "PRs squash-merge" | split: the kit's `engine/REVIEW.md` is the generic procedure, parameterised through `facts.md`/`state.json` (classes, visibility, tier, knowledge files); the project's `.claude/pr-review/REVIEW.md` is a required addendum |
| Workflow: `e2e-fix/*` and Dependabot guards, Node 22, `--model opus`, 30-minute timeout, secret names                                                                                                                                                                  | consumer workflow (the example carries the generic guards; `e2e-fix/*` is recovery-platform's)                                                                                                                               |
| Tests that read the workflow and the knowledge files (`workflow-config`, `inline-scope`, `inline-post`, `knowledge`)                                                                                                                                                   | become the kit's `validate` command, run by consumers against their own workflow, config and knowledge (§2.5)                                                                                                                |
| `ci.yml` `pr-review-checks` job runs the engine tests in the consumer                                                                                                                                                                                                  | the engine tests run in the kit's CI; a consumer runs `validate` plus its own project-check tests                                                                                                                            |
| `.review-base/` and `.review-publish/` named in `REVIEW.md` and the prompt                                                                                                                                                                                             | unchanged names, set by the kit's actions, so the procedure's warning stays true                                                                                                                                             |
| `BOT_AUTHOR = github-actions[bot]`                                                                                                                                                                                                                                     | unchanged: every consumer posts with the workflow `GITHUB_TOKEN`                                                                                                                                                             |

Generic as written (ported unchanged apart from taking config): `diff`, `glob`, `markers`, `ids`, `fileids`,
`needles`, `ledger`, `render`, `prior`, `state`, `material`, `increment`, `completion`, `deliver`, `gh`,
`summary-post`, `status`, `inline-stage`, `inline-guard`, `advisories` (minus the package name), and the hygiene
checks for secrets, PII-in-logs, new-file size, title scope, self-edit and verify-diff (all configurable, any can
be switched off).

## 2. Configuration surface

### 2.1 Files in the consumer, all read from the base branch

```
.claude/pr-review/
  config.json          engine config (schema below; validated, unknown keys are an error)
  REVIEW.md            project addendum to the kit's procedure (required)
  routing.json         [{linkType, paths[], counterparts[], classes[]}] (format unchanged)
  checklist.md         bug classes; ids must match config.classes
  conventions.md
  false-positives.md
  contract-map*.md     any number; listed in config.knowledge
  learned/lessons.json machine-managed learned memory (source of truth)
  learned/precision.json  👍/👎 counts per class and link type
  learned-lessons.md   lessons that refine no other file (rendered from lessons.json)
  checks/*.mjs         optional project checks (§2.3)
```

### 2.2 `config.json`

```jsonc
{
  "version": 1,
  "project": "rag-system", // advisory package prefix, labels
  "visibility": "public", // "public" | "private"
  "securityChannel": "advisory", // public: "advisory"; private: "repo-comments" | "none" (§4)
  "privateReaders": ["marcusk639"], // private + repo-comments: everyone allowed to read the repo
  "workflowPath": ".github/workflows/pr-review.yml",
  "packages": ["apps/api", "apps/web"], // longest prefix wins; others group as "repo"
  "knowledge": [
    "checklist.md",
    "conventions.md",
    "false-positives.md",
    "contract-map.md",
    "learned-lessons.md",
  ],
  "classes": [
    {
      "id": 1,
      "name": "Client-supplied IDs trusted for auth",
      "security": true,
    },
    {
      "id": 13,
      "name": "PR text claims what code doesn't do",
      "always": true,
      "light": true,
    },
  ],
  "tiers": {
    "enabled": true, // false: every run is full (or none when nothing changed)
    "maxTurns": {
      "full": 60,
      "incremental-new-links": 60,
      "incremental": 40,
      "light": 15,
      "base-drift": 15,
    },
    "largeShare": 0.5,
  },
  "lightFiles": [
    "**/*.md",
    "**/*.txt",
    "**/*.png",
    "**/*.jpg",
    "**/*.svg",
    "**/pnpm-lock.yaml",
    "**/package-lock.json",
    "**/yarn.lock",
  ],
  "largePr": { "files": 60, "lines": 5000 },
  "inline": { "max": 10, "severities": ["Critical", "High"] },
  "secrets": { "extraPatterns": [] }, // regex sources, added to the kit's list
  "checks": {
    "secrets": true,
    "piiLogs": {
      "fields": "email|phone|address",
      "logCall": "\\b(?:logger|console)\\.",
    }, // or false
    "newFileSize": { "maxLines": 300, "pattern": "\\.(?:ts|tsx|js|jsx|mjs)$" }, // or false
    "titleScope": { "bareScopes": [] }, // or false
    "selfEdit": true,
    "verifyDiff": { "script": ".claude/agent-gates/verify-diff.sh" }, // or false
    "project": ["checks/firestore.mjs"], // §2.3
  },
  "trust": {
    "contextAssociations": ["OWNER", "MEMBER", "COLLABORATOR"],
    "feedbackAuthors": ["marcusk639"],
  },
  "learning": {
    "windowDays": 45,
    "repeatThreshold": 2, // 👎s on one class+scope before a pattern lesson is proposed
    "maxLessons": 40,
    "demote": { "minVotes": 5, "maxPrecision": 0.4 },
    "distill": "model", // "model" | "deterministic"
    "branch": "pr-review/learning",
  },
}
```

Defaults reproduce the reference's behaviour wherever the reference had one. `validate` (§2.5) rejects a config
whose classes are missing from `checklist.md`, whose `knowledge` files do not exist, or whose routing classes are
not configured.

### 2.3 Project checks (extension point)

A project check is an ES module under `.claude/pr-review/checks/`, listed in `config.checks.project`, loaded **only
from the base checkout** (`.review-base/`), never from the PR head:

```js
export default [
  {
    name: "firestore-indexes",
    run({ files, repoRoot, baseSha, headSha, title, config }) {
      return [/* facts */];
    },
  },
];
```

`files` is the parsed diff (`{file, oldFile, status, binary, added[{line,text}], removed[...]}`). A fact is
`{check, file, line?, note}`; notes are redacted by the engine. A check that throws becomes "pre-check
unavailable: <name>" (the review is then labelled partial, as in the reference). Names must match
`^[A-Za-z][A-Za-z0-9-]{0,39}$`. Checks run in the facts step, which holds the read-only-ish `GITHUB_TOKEN` but no
other secret; they are base-branch code, trusted like the knowledge.

### 2.4 Light-file patterns, tier caps, inline caps, visibility

All in `config.json` as above. A consumer with `tiers.enabled: false` (doc-classifier-sized repos) still gets
"no new commits → tier none" and the base-drift check is skipped.

### 2.5 Consumer tooling

- `node <kit>/bin/pr-review.mjs validate` — checks config, knowledge files, routing, and the workflow file's
  security properties (pinned SHA, permissions, guards, tool allow/deny lists, secrets only on publish). This
  replaces the reference's `workflow-config`/`knowledge` tests.
- `node <kit>/bin/pr-review.mjs local --base <sha> --head <sha> [--findings f.json --summary s.md --inline i.json]`
  — runs facts against the local repo (no GitHub; prior state empty unless `--comments` fixture given), then
  publish in dry-run mode, printing the summary body and the inline comments it would post to stdout.
- `publish --dry-run` — same render path as a real run with posting replaced by printing. Advisory bodies are
  printed only with `--show-private`, and never when `GITHUB_ACTIONS=true`.

## 3. Loading mechanism

**Decision: composite actions in the kit repo, pinned by full commit SHA; the kit repo is public.**

Evidence and reasoning:

- **Private kit + public consumers is impossible.** GitHub's "Allowing access to components in a private
  repository" setting for a personal account offers only "Accessible from repositories owned by 'USER' — access is
  allowed only from private repositories" (docs: _Managing GitHub Actions settings for a repository_). rag-system,
  software-dev-team and doc-classifier are public, so a private kit would force vendoring on half the consumers.
  The engine code is already public today inside `marcusk639/recovery-platform`, and the kit holds no project
  knowledge or secrets, so a public kit discloses nothing new.
- **Reusable workflow (`workflow_call`) rejected.** A called workflow cannot reach its own repository's files:
  `uses: ./…` and `actions/checkout` resolve against the caller, so the engine scripts would need either a token
  that can read the kit (none is available to a consumer's `GITHUB_TOKEN` if the kit were private) or a nested
  `uses: kit/…@<sha>` that hard-codes the kit's own SHA inside the kit, which cannot be self-referential. It would
  also hand every secret to the whole called workflow (`secrets:` / `inherit`) rather than to one step.
- **Composite action wins on trust.** `uses: marcusk639/pr-review-kit/actions/review@<40-hex sha>` makes the runner
  download exactly that commit, and `$GITHUB_ACTION_PATH` points at it. No checkout of engine code, no token, no
  mutable tag. The engine is immutable for the run; knowledge and config still come from the consumer's base
  checkout.
- **Secrets reach one step.** Composite actions do not get `INPUT_*` environment variables automatically
  (docs: _Metadata syntax reference_, `inputs`); an input is visible only where an expression maps it. The
  consumer workflow therefore passes:
  - `claude_code_oauth_token` only to `actions/review` (which hands it only to `claude-code-action`'s `with:`),
  - `id_key` and `advisory_token` only to `actions/publish`, which maps them into the env of its single `node`
    step, with `NODE_OPTIONS: ""` and `BASH_ENV: ""` set on that step as in the reference.
- **Vendoring rejected as the default** (six drifting copies is the problem being solved), but kept as the
  fallback if Marcus wants the kit private: private consumers use the action; public consumers would vendor
  `engine/` at a stamped SHA with `bin/pr-review.mjs sync` and `validate` checking the stamp.

**Base-branch trust, as before.** For `pull_request` the consumer's workflow file comes from the PR head, so a PR
can change the pinned SHA, exactly as a PR could edit the reference's workflow. The reference accepted this
(threat model: accidental edits by Marcus's own agents; forks excluded) and so does the kit. Two additions: facts
flags any change to `workflowPath` as a High self-edit, and a new `engine-pin` fact compares the kit SHA pinned on
the base side with the head side and states it plainly. `pull_request_target` would close the gap but changes the
trust model of the whole job (secrets present for every PR event); it is listed as an option, not adopted.

### Security properties carried over

| Reference property                                                               | Kit                                                                                                                                                                                    |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model has no Bash, network or posting tool; writes only under `OUT`              | unchanged allow/deny lists, built inside `actions/review`; plus `Write/Edit` denied on the kit's own download path (`$GITHUB_ACTION_PATH/../..`)                                       |
| Reads of workspace `.git/**` and `//proc/**` denied                              | unchanged                                                                                                                                                                              |
| Hooks disabled, `--strict-mcp-config`, repo `.claude/settings.json` never edited | unchanged (`settings: {"disableAllHooks": true}`)                                                                                                                                      |
| Knowledge restored from base before the model runs                               | unchanged step inside `actions/review`                                                                                                                                                 |
| Facts' trusted snapshot outside `--add-dir`, read-only                           | unchanged                                                                                                                                                                              |
| Publish runs from a fresh base checkout, after the model, model-free             | publish code comes from the pinned action path (immutable, not writable by the model); config/routing come from a fresh base checkout into `.review-publish/` cleared first, as before |
| Secrets only in publish; `NODE_OPTIONS`/`BASH_ENV` cleared                       | unchanged (§3)                                                                                                                                                                         |
| Superseded-head check, failure never looks clean, partial labelling, status line | unchanged                                                                                                                                                                              |
| Forks, drafts, Dependabot skipped                                                | in the example workflow; `validate` checks the same-repo guard is present                                                                                                              |

## 4. Private repos and the security channel

**Repository security advisories are not available for private repos**: "Repository security advisories and
private vulnerability reporting are available for public repositories on GitHub.com" (docs: _About repository
security advisories_). So cpa-consulting, karbon-dashboards and claude-config cannot reuse the reference channel.

Design, from who can actually read the repo:

- `visibility: "public"` → `securityChannel: "advisory"` (the reference design, unchanged: pointer in public,
  details in a draft advisory, opaque HMAC ledger ids, needles, withholding).
- `visibility: "private"` → `securityChannel: "repo-comments"`: the readers of a private repo's PR comments,
  workflow logs and artifacts are exactly its collaborators. When those are only trusted people, the summary and
  inline comments **are** the private channel, so security findings are rendered in full (tagged
  `security-relevant`), may get inline comments, and their ledger entries are ordinary entries. Secret values are
  still always redacted and PII is still never written.
  - **Fail closed at runtime.** Publish verifies `GET /repos/{repo}` says `private: true` and that the
    collaborator list is a subset of `privateReaders`. If the repo has become public, or the list contains
    anyone else, or either call fails, the run falls back to pointer-only rendering with "details withheld:
    private channel could not be verified" and no detail goes anywhere. (Listing collaborators needs write
    access; whether the workflow `GITHUB_TOKEN` with `pull-requests: write` qualifies is **unverified** and is
    the first thing the private repos' skeleton run must show. If it does not, the options are a fine-grained
    PAT with Metadata read, or dropping the reader check: Marcus's call, §9.)
- `securityChannel: "none"` → pointer only, never detail (for a private repo whose readers Marcus doesn't want to
  enumerate).

## 5. Feedback learning

### 5.1 Attribution

- Every non-security finding gets a **handle** `F-<6 hex>` (the first 6 of its public ledger id, an unkeyed hash
  of the slug) shown on its summary line. Critical/High findings keep their inline comment, which carries the
  `fp` marker.
- Signals that count, all traced to a slug and thus to its class (slug prefix) and link types (routing the slug's
  file through `routing.json`):
  1. 👍/👎 (`+1`/`-1`) reactions on the bot's inline comment;
  2. a reply in that inline comment's thread;
  3. a PR comment line `F-abc123 👎 <reason>` / `F-abc123 👍` / `F-abc123 <text>` addressing a handle — this is how
     Medium/Low findings (no inline comment) get their own "reaction" and reply without adding comments.
- Reactions on the summary comment are ignored (not attributable).
- Security findings in public repos have no public handle (it would be a guessable id). Their feedback is the
  advisory itself: closed/withdrawn = resolved (as today); there is no public lesson path from them (§5.5).
  In private repos security findings have handles like any other.

Why handles over inline comments for everything: an inline comment per Medium/Low finding doubles visible noise
for findings Marcus mostly reads in the summary; a handle costs one token in the summary. `inline.severities` can
still widen inline posting per repo.

### 5.2 Within a PR, next run

`state.mjs` already resolves a slug when a trusted user replies to its inline comment (`acknowledgedSlugs`). It is
extended to compute, from **trusted feedback authors only**: `rejectedSlugs` (👎 or a 👎 handle line) and
`corrections` (reply text, redacted, capped at 500 chars each, 10 total). Facts puts the corrections in
`facts.md` under "Feedback on earlier findings" as quoted data. Publish:

- marks rejected slugs resolved in the ledger (like acknowledged ones);
- drops a re-reported rejected slug from the rendered findings unless the model sets `"reraise": "<why it is
materially worse>"` on it, which is rendered as "(re-raised after 👎: …)". A rejected security-class or
  Critical finding is never dropped by publish: the 👎 resolves the entry but a re-report is always shown.

### 5.3 Collection (model-free)

`learn collect` lists PRs updated in the last `learning.windowDays` (open, closed and merged), reads the bot's
inline comments, their reactions and replies, and trusted PR comments with handle lines. Output: feedback records
`{id, pr, url, slug, class, linkTypes, path, severity, security, signal: up|down|text, text, author, at}`. Only
`trust.feedbackAuthors` count; anything with a `[bot]` login or `type: Bot` is ignored. Text is redacted and
capped. Precision is recomputed per PR and stored per PR in `precision.json`, so a window that slides past old
PRs never loses their counts.

Limit: reactions do not bump a PR's `updated_at`, so a reaction added more than `windowDays` after the PR's last
update is missed. Accepted; documented.

### 5.4 Candidates, distillation, application

1. **Candidates (deterministic).** An explicit trusted text correction on a finding → a candidate lesson scoped to
   that finding (path = slug file, class, link types). Repeated 👎 on the same class + scope (≥
   `repeatThreshold`, across different PRs) → a pattern candidate. **A lone 👎 never becomes a candidate**; it is a
   precision count. Instruction-shaped text (imperatives aimed at the reviewer: "ignore previous instructions",
   "stop reporting/flagging …" without a concrete scope, "you are now…", "always/never …" over a whole class) is a
   candidate marked `instructionShaped` and is never applied automatically; it is listed as unresolved feedback.
2. **Distill (model, optional).** `claude-code-action` with the review job's sandbox (Read/Grep/Glob, Write only
   under `OUT`, no Bash/network/MCP, hooks off, `--strict-mcp-config`) reads the candidates, the current knowledge
   files and the kit's `DISTILL.md`, and writes `OUT/proposals.json`: per candidate, a one-or-two-sentence rule, the
   target file (one of `config.knowledge`), `supersedes` ids, or `unresolved` with a reason. Feedback text is
   presented as quoted data. With `distill: "deterministic"` (or when the model fails), the correction text itself is
   the rule and the target is chosen by keywords.
3. **Apply (deterministic, the gate).** Every proposal is validated against its candidate: it must cite only that
   candidate's source records (which are trusted by construction), its scope may only narrow the candidate's,
   and its target must be a configured knowledge file. Then:
   - a newer correction with the same scope key (class + path/anchor) **replaces** the older lesson;
   - lessons whose scope paths match no file on the default branch are **pruned**;
   - over `maxLessons`, the oldest pattern lessons are dropped first;
   - a lesson that **narrows security coverage** (its class is a security class, it came from feedback on a
     security, Critical or High finding, or its text suppresses security/auth/secrets/PII findings) is **flagged**:
     not written into the knowledge files, listed in the learning PR under "Needs your decision".
     Lessons live in `learned/lessons.json` and are rendered into managed blocks
     (`<!-- pr-review:learned:begin -->…end`) inside their target file, so a false positive lands in
     `false-positives.md`, a convention in `conventions.md`, a counterpart in the contract map, and only lessons that
     fit nowhere else in `learned-lessons.md`. Each rendered lesson shows the rule, its scope, its source links and
     its date.
4. **Precision (deterministic).** 👍/👎 per class and per link type. A non-security class with at least
   `demote.minVotes` votes and precision ≤ `demote.maxPrecision` is **demoted**: no inline comments, and facts tells
   the model to report it only at high confidence. 👎s on security, Critical or High findings are shown in the
   counts but excluded from demotion maths, so they never suppress a class.

### 5.5 How memory lands

A scheduled consumer workflow (weekly, plus manual dispatch) runs in two jobs:

1. `learn` (read-only token; the OAuth token only on the distill step): collect → candidates → distill → apply,
   producing the proposed file set and the PR body as an artifact. The job never holds a write token.
2. `propose` (model-free; `contents: write`, `pull-requests: write`): creates or updates **one** open PR from
   `learning.branch` with the proposed changes, its body listing lessons added/replaced/pruned, flagged lessons,
   unresolved feedback and the precision table. If the branch carries commits by anyone other than the bot (Marcus
   edited it), it is not overwritten; a comment says new proposals are waiting.

Memory reaches the reviewer only when Marcus merges that PR into the default branch. Requires the repo setting
"Allow GitHub Actions to create and approve pull requests". PRs opened by `GITHUB_TOKEN` do not trigger other
workflows, so the learning PR is not itself reviewed or CI-tested.

Security feedback in public repos never produces lesson text automatically: the learning PR shows only "N pieces
of feedback on security findings; see the draft advisories". Marcus writes any non-revealing pattern himself.

## 6. Kit layout

```
engine/            facts.mjs publish.mjs advisories.mjs hygiene.mjs REVIEW.md DISTILL.md
engine/lib/        ported libs + config.mjs project.mjs feedback.mjs
engine/learn/      collect.mjs candidates.mjs apply.mjs propose.mjs precision.mjs render.mjs
engine/test/       ported tests + config, project-check, dry-run, feedback, learning fixture tests
actions/review/    composite: clear+checkout base, facts, restore knowledge, claude-code-action
actions/publish/   composite: clear+checkout base, publish (secrets here only), cleanup
actions/learn/     composite: collect → distill → apply (no write token)
actions/propose/   composite: open/update the learning PR
bin/pr-review.mjs  validate | local | publish --dry-run | learn --dry-run
examples/          consumer workflows and a .claude/pr-review/ skeleton
```

Node built-ins only, no install at runtime; each new file stays under 300 lines, as in the reference.

## 7. What does not generalize

- Firestore/rules/index/storage checks, callable export greps, region checks and the twin-file list: project
  checks for recovery-platform only.
- The contract-map split and its owner table: project knowledge.
- `e2e-fix/*` branch skipping: recovery-platform's workflow.
- HMAC-keyed opaque ids, needles and draft advisories only matter in `public` mode; they stay in the engine but are
  inert for private repos using `repo-comments`.

## 8. Verification plan (engine)

- All ported reference tests pass against the kit (with config defaults equal to the reference).
- New tests: config validation; project-check loading (base only, failure → unavailable); private-channel
  rendering and its fail-closed fallback; handles; in-PR rejected/correction handling; `--dry-run` publishes
  nothing; and the six learning fixtures from the brief (trusted correction → scoped lesson with source; untrusted
  author → nothing; instruction-shaped → weighed, not applied; lone 👎 → no lesson; newer correction replaces
  older; security-narrowing lesson flagged).
- `actionlint` on the composite actions' embedded shell and on the example workflows.

## 9. Open questions for Marcus

1. **Kit visibility.** Public kit (recommended; the code is already public in recovery-platform), or private kit
   with vendoring for the three public consumers?
2. **Name.** `pr-review-kit` (`marcusk639/pr-review-kit`)?
3. **Trusted feedback authors.** Default is `marcusk639` only, in every repo. Any others per repo?
4. **Auto-merge of lessons.** Default: none, every lesson goes through the learning PR. Option: auto-merge an
   explicit correction from Marcus scoped to one path and not touching security classes. Tradeoff: faster
   correction vs. one bad distillation silently degrading reviews until noticed.
5. **Private-repo channel.** Accept "the private repo's PR comments are the private channel" when its collaborators
   are all in `privateReaders`? If the workflow token cannot list collaborators, use a Metadata-read PAT, drop the
   check, or use `securityChannel: "none"`?
6. **Attribution.** Handles (`F-abc123 👎 reason` in a PR comment) for Medium/Low findings, or inline comments for
   every finding in changed files?
7. **Learning cadence.** Weekly plus manual dispatch?
8. **Learning PR permission.** Enabling "Allow GitHub Actions to create and approve pull requests" on each repo
   (needed for the `GITHUB_TOKEN` to open the learning PR), or a PAT?
9. **`pull_request` vs `pull_request_target`.** Keep the reference's accepted gap (PR can edit its own workflow)?

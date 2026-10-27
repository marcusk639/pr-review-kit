# pr-review-kit — design

**Date:** 2026-10-26 (revised after consumer intake, the independent security verification and Marcus's decisions)
· **Reference:** `marcusk639/recovery-platform` at `1eee0d7` (`docs/superpowers/specs/2026-10-22-pr-review-agent-design.md`,
`.github/workflows/claude-code-review.yml`, `.claude/pr-review/`).

The kit is the shared engine for the repo-aware, advisory PR reviewer: facts and publish, tiering, the ledger,
fingerprints, rendering, inline posting and its guards, redaction, the private security channels and the
feedback-learning pipeline. Each consumer owns `.pr-review/` (config, knowledge, project checks, learned memory).
How-to: [consumer-guide.md](consumer-guide.md).

## 1. Decisions (binding)

| Decision                        | Choice                                                                                                                                                                                                    | Why                                                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kit repo                        | **Public**, `marcusk639/pr-review-kit` (Marcus).                                                                                                                                                          | Private actions are usable only from private repos on a personal account; three consumers are public. The engine code is already public in recovery-platform.                                                                                   |
| Loading                         | **Composite actions** pinned by full SHA: `actions/review`, `actions/publish`, `actions/learn`, `actions/propose`.                                                                                        | See §3.                                                                                                                                                                                                                                         |
| Knowledge location              | **`.pr-review/` at the repo root**, read from one trust SHA.                                                                                                                                              | claude-code-action restores `.claude/` from `origin/<base.ref>` (the tip at run time) during its own step, which would replace whatever the engine loaded from `base.sha`. It never touches `.pr-review/`.                                      |
| Trust SHA                       | Resolved once in `actions/review` (`base.sha`), output as `trust_sha`, used by facts, the knowledge restore and publish.                                                                                  | One source of truth; consumers never compute it.                                                                                                                                                                                                |
| Private repos' security channel | **`private-repo-issue`** (default for private): details as issues in a separate Marcus-only private inbox repo via a PAT with Issues read/write on that repo only. **`repo-comments` removed.**           | Repository security advisories exist for public repos only. The PR comments of a private repo are not a private channel (pending invitations, installed Apps, notification emails and edit history are outside any check), and nobody chose it. |
| Feedback marker                 | Reactions from the trusted author count. Replies count only when the first own line starts with `review:`; `review: F-1a2b3c …` in PR comments. Edited comments ignored; quotes and code fences stripped. | Marcus's own agents post as `marcusk639` via `gh`: without a marker their comments would teach the reviewer. That is the most likely real poisoning path.                                                                                       |
| Trusted author                  | `repository-owner`, resolved at runtime, everywhere.                                                                                                                                                      | No login in committed config (karbon-dashboards forbids it).                                                                                                                                                                                    |
| Lessons                         | **Never auto-merge**; one learning PR, weekly plus `workflow_dispatch`.                                                                                                                                   | Every lesson reviewable and revertible.                                                                                                                                                                                                         |
| Learning PR CI                  | **No PAT or dispatch CI on the learning branch.** The learn job runs the consumer's format and validate commands itself, with no secrets, before proposing.                                               | A PAT or dispatch would turn "push to the learning branch" into "get secrets".                                                                                                                                                                  |
| Stacked PRs                     | `trustRef` rejected. Consumers limit the trigger (`branches: [main]`) and guard `github.base_ref`.                                                                                                        | A main-head trust ref is defeated by the action's `.claude/` restore and widens trust; the workflow-level filter keeps the trust SHA a default-branch commit.                                                                                   |

## 2. What is generic and what is per project

Generic (in the kit): every module under `engine/` and the four actions. Moved to config: the package list, bug
classes (ids, security, always, light, protected, confidence floor), tier set and caps, light files and exclusions,
inline caps, PII and file-size rules, title scopes, workflow paths, trust lists, extra secret patterns and
fake-credential allow-lists, withheld paths, external counterparts, style rules. Per project: knowledge files,
routing, the addendum, project checks. recovery-platform's Firestore/contract/twin checks are an example project
check (`examples/recovery-platform/`), not engine code. The reference's workflow/knowledge tests became `validate`.

## 3. Loading mechanism (re-decided)

**Composite actions, kept.** The verifier corrected my first reasoning: a reusable workflow _can_ reach its own
repository through `job.workflow_repository`/`job.workflow_sha`, and it would let publish run as a separate job on
a fresh runner (no shared filesystem, GITHUB_ENV or id-token with the model). I rejected it on the merits anyway:
publish needs the model's `findings.json`, which holds security detail, and the only cross-job handoff is an
artifact, which on a public repository anyone can download while it exists. Encrypting the handoff would add a
keypair secret and a crypto path. Within one job the separation holds: the model has no Bash; Write/Edit are
denied everywhere but OUT, including the runner command files that feed GITHUB_ENV and the state snapshot; the
publish step clears NODE_OPTIONS and BASH_ENV and runs pinned engine code that the model cannot write.

- Every `uses:` inside the kit is pinned by full SHA (checkout, setup-node, claude-code-action — `v1` moved on
  2026-10-24 — upload/download-artifact); no `uses: ./`.
- Secrets reach one step: composite inputs are not exported as `INPUT_*` (docs, _Metadata syntax_); the OAuth token
  reaches only claude-code-action, the id key and channel tokens only the publish node step, `redact_terms` only
  facts, publish and the learn steps.
- Accepted gap, as in the reference: for `pull_request` the consumer's workflow file comes from the PR head, so a PR
  can change the pin. Facts reports any pin change (`engine-pin`) and any workflow edit (`self-edit`, High);
  `validate` requires the pin to be a commit on the kit's `main` (no imposter commit) that carries the sandbox.

## 4. The sandbox (review and distill models)

- `--setting-sources user` (no project CLAUDE.md, rules, skills, settings, apiKeyHelper or env), settings
  `disableAllHooks` plus `claudeMdExcludes`, `--strict-mcp-config`.
- Allowed: Read, Grep, Glob, Write/Edit under OUT. Denied: Bash, MultiEdit, NotebookEdit, WebFetch, WebSearch,
  Skill, Task, Agent, the action's MCP servers; Write/Edit on the workspace, the kit, runner command files and the
  snapshot; Read of `.git/`, `.claude-pr/` (the action's copy of the PR head's sensitive paths), `.review-base/`,
  `/proc`, the runner's `~/.claude` and `~/.config`, the command files, and `config.withheld` paths.
- **Neutralize PR head** (model-free, after the knowledge restore and before facts): symlinks become placeholder files;
  `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` at any depth (root included), nested `.claude/`, `.ignore`,
  `.rgignore`, `.gitignore`, `.ripgreprc`, `.mcp.json`, `.claude.json` are set aside as `*.pr-head`; the root `.claude/settings*.json` removed.
  Failing to neutralize fails the job (publish then reports an incomplete review).
- Facts and project checks read PR files from git objects (`readHead`/`readBase`/`listFiles`) or with containment
  checks; nothing follows a link; nothing from the PR is executed. Facts does every GitHub read first and drops
  `GH_TOKEN` before any check. **Project checks run in a forked child**: PATH-only env (no token, no runner
  secrets), an empty temp cwd, a hard kill after `checks.timeoutMs` ("pre-check unavailable: name (timeout)"), git
  only as `git -C <repo>` without user/system config; `parseOnly` parses without executing (python `-I`, stdin,
  empty cwd); diff lines over 2000 characters never reach checks; notes are redacted, capped and carry withheld
  paths only as hashes. `validate` rejects `child_process` in checks (a reproduced High: a PR-planted `ast.py` ran
  inside facts through a check's `python3 -c`).
- The review model may write only `inline.json`, `findings.json` and `summary.md`; the distill model only
  `proposals.json` (OUT is an `--add-dir`, from which Claude Code would load `.claude/` config).
- `id-token: write` stays: with an OAuth token and no `github_token` input, claude-code-action obtains its App
  token through OIDC. Dropping it means passing `github_token`, which changes the action's identity; verify in the
  skeleton run before changing.
- External counterparts (`externalCheckouts`, public repos): fetched after neutralize, token-free (no credential
  helper, no prompt), sparse, `core.symlinks=false`, `.git` deleted, neutralized, SHA in facts; failure is
  "unavailable".
- **Unverified until the skeleton run:** that the flag and settings behave as documented in the action. The
  acceptance plan includes a canary PR planting a nested `CLAUDE.md`, an `AGENTS.md` and a skill that each ask the
  model to emit a token; the token must be absent from every output.

## 5. Security channels

| Channel              | Public surface                    | Details                                                                                                                                                          | Fails closed when                                                                                       |
| -------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `advisory` (public)  | pointer (severity, package, area) | draft repository advisory, deduped repo-wide by HMAC id                                                                                                          | no advisory token or id key                                                                             |
| `private-repo-issue` | pointer                           | issue in the inbox repo (from `vars`, never committed), deduped by (repo, HMAC id), resolved on close; @-mentions, emails and `issueBody.extraPatterns` stripped | no target, token or key; inbox not private; any collaborator other than the repository owner; API error |
| `none`               | pointer                           | nowhere                                                                                                                                                          | —                                                                                                       |

The ledger, needles and withholding are the reference's in every channel; security ledger entries are opaque HMAC
ids. Without the id key, security entries are frozen (never created or leaked as slugs).

## 6. Configuration surface

`.pr-review/config.json`, schema-validated (unknown keys at any depth are errors; an invalid config means tier
`none` and nothing published). Keys: `version`, `project`, `visibility`, `securityChannel`, `issueBody`,
`workflowPath`, `learnWorkflowPath`, `packages`, `knowledge`, `classes[{id, name, security, always, light,
protected, minConfidence}]`, `tiers{set: all|none-light-full|full, disabled[], maxTurns, largeShare}`,
`lightFiles`, `lightExclude`, `withheld`, `externalCheckouts[{repo, ref, dir, sparse}]`, `largePr`, `inline`,
`secrets{extraPatterns, allowPaths, allowPatterns}`, `style{noEmoji, noEmDash}`, `checks{secrets, piiLogs,
newFileSize, titleScope, selfEdit, verifyDiff, writeCollaborators{allowed}, project}`,
`trust{contextAssociations, feedbackAuthors}`, `learning{windowDays, repeatThreshold, maxLessons, demote, distill,
branch, forbidden, commands{format, validate}}`. Action inputs: `claude_code_oauth_token` (any secret name),
`model`, `redact_terms`; publish `trust_sha`, `id_key`, `advisory_token`, `private_repo`, `private_issue_token`,
`dry_run`. Project checks: sync `run({files, repoRoot, baseSha, headSha, title, config, git, readHead, readBase,
listFiles})`. A tier whose `maxTurns` is 0 does not run the model.

## 7. Feedback learning

- **Attribution:** inline comments (Critical/High) take reactions and `review:` replies; every non-security finding
  shows a handle `F-xxxxxx` for `review: F-xxxxxx …` lines. Reactions on the summary are ignored. Security
  findings have no public handle; their disposition is the private channel (advisory or issue closed).
- **Within a PR:** trusted 👎 or `review:` reply resolves the finding and stops its re-raise (unless the model
  gives a `reraise` reason); corrections reach the model as quoted data. Critical and security findings are never
  resolved or dropped by feedback.
- **Collection** (model-free, read-only token): PRs updated in the window; only `trust.feedbackAuthors`; bots,
  edited comments, quotes and fences excluded.
- **Candidates** (deterministic): a correction → a lesson scoped to the finding; repeated 👎 on one class and
  directory across PRs → a pattern lesson; a lone 👎 → a precision count only; instruction-shaped text →
  unresolved, never applied. Votes on security, Critical, High or unknown-severity findings never form patterns or
  demote a class.
- **Distill** (optional model, review sandbox) writes proposals to OUT; **apply** (model-free) validates them
  against the read-only snapshot (never OUT): known candidate, scope only narrower, configured and non-forbidden
  target, short non-instruction rule. Lessons touching security or `protected` classes are held as
  `needs-decision` (security ones without their text). Newer corrections replace older ones on the same scope;
  replaced and pruned lessons' sources stay consumed (no flip-flop); stale paths are pruned; memory is capped.
- **Precision:** 👍/👎 per class and link type, per PR (a sliding window never loses counts). A non-security,
  non-protected class with enough low-precision votes is demoted (no inline comments, high-confidence only), in
  facts and publish alike.
- **Default branch only:** learn and propose fail unless `github.ref` is the default branch, and `validate`
  requires the learn workflow's checkouts to use `ref: ${{ github.event.repository.default_branch }}`, so a
  dispatch from another branch cannot bring its own trust settings.
- **Landing:** the learn job (no write token) runs `learning.commands` (format, validate) on a scratch copy of the
  proposed tree; a failure proposes nothing. The propose job (model-free, the only write token) commits only under
  `.pr-review/`, keeps one learning PR, and never overwrites a branch a maintainer edited. A learning PR is spared
  the High self-edit finding only when the GitHub API shows a bot-opened PR from the learning branch whose every
  commit has the bot as author and committer login and a signature GitHub reports as verified with reason
  `valid` (git author names are ignored, and logins alone are not enough: GitHub maps them from the commit email,
  which a pusher sets), and every
  change is inside the managed blocks and `learned/*.json` with the shapes the learning job writes. propose writes
  only `learned/*.json` and the knowledge files the loop may edit, never through a link, each under 512 KB. PRs opened by `GITHUB_TOKEN` trigger no workflows: the learn job's own commands are the
  check.

## 8. Known tradeoffs

- **Withholding is per file.** A security finding withholds every other finding that names its file (and drops
  their inline comments and impact-table rows): reference behaviour, now with #127's canonical path matching.
  In small repos or on hub files (`config/settings.json`) this can hide unrelated findings. Fail-closed is kept;
  a `withholdExempt` list or location-based withholding is deferred to after the trial.
- `.review-base` is a full checkout of the trust SHA, so withheld files are on disk there; they are protected by
  the `Read(.review-base/**)` deny, not by absence. A sparse checkout (`.pr-review/`, the workflow, the verify
  script) would remove them, but the verify-script path is only known after config is read; deferred.
- Pending collaborator invitations need Administration read, which no workflow token has, so
  `writeCollaborators` cannot see them; its notice says so and runbooks confirm none are open.
- `learning.forbidden` entries are exact knowledge-file names or globs (relative to `.pr-review/`); anything
  else is a config error.

## 9. Consumer requests: accepted, deferred, rejected

**Accepted and built:** project addendum and knowledge list (E1); tier set/disabled/caps/light patterns and
exclusions (E2, behaviouralDocs, rag-system lightFiles); routing (E3); project checks with `readHead`/`readBase`/
`listFiles` (E4, rag-system); external checkouts with a local override for dry runs (E5, E14); per-check toggles
and secret patterns (E6); security classes (E7); inline caps (E8); visibility (E10); trusted authors via
`repository-owner` (E11, karbon); learning cadence; secret by role (karbon); fake-credential allow-lists; lesson
targets and `learning.forbidden`; per-class `protected` and `minConfidence`; `withheld` paths; `redact_terms`;
the write-collaborator fact; closed+merged PRs (trigger plus merged guard; tier `none` when the head was already
reviewed); merge-from-base fact; style rules; learning-PR exemption (pure only); learn-job format/validate
commands; neutralize, link-refusing reads and the sandbox changes (claude-config, verifier).

**Covered differently:** summary-section toggles (E9) and fixed summary lines → the project addendum; branch
guards (E12) and the job timeout (E13) → the consumer's workflow (`if:`, `timeout-minutes`); a "Loosenings" table
→ a project check whose facts the addendum asks the model to tabulate; security-area vocabulary → `packages` and
the two-word `area` rule; `audience` → `visibility` plus `securityChannel`; sensitive paths → `withheld` and the
security classes; per-framework test-tamper patterns → the `verifyDiff` script or a project check.

**Deferred:** string class ids (consumers keep integers); `syncPr` procedure routing; `neverQuote`; `sizeExclude`;
commit-convention target selection; `binaryExtensions`, gitignore-aware path resolution and
`historicalPaths`; posting to merged PRs whose head was never reviewed is supported, but no separate "late
review" procedure; a local runner that reviews and publishes from Marcus's machine.

**Rejected:** `repo-comments` (Marcus; Critical per the verifier); PAT or dispatch CI on the learning branch;
`trustRef`; plain-slug ledger ids without a key in private repos (the ledger freezes instead); security findings
inline in private mode (every public surface is pointer-only).

## 10. Verification

Engine: `npm test` (ported reference tests plus config, tiers, project checks, git reads, neutralize, externals,
withheld, private channels, feedback marker, learning fixtures, learn commands, learning-PR exemption, workflow
checks, dry-run). Workflows: actionlint on the examples and on local usage of all four actions. Still needs
GitHub (in the runbook): whether `GITHUB_TOKEN` can list collaborators (Metadata read), the canary PR, whether
claude-code-action runs on `schedule`/`workflow_dispatch` with an OAuth token, and whether git-data-API commits by
`GITHUB_TOKEN` carry `author.login == github-actions[bot]` and a verified signature (the edited-branch guard
relies on the author; the learning-PR exemption also on the signature, and fails closed without it).

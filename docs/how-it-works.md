# How the automated PR review works

**Version 1.2.0** · pr-review-kit · 2026-10-30 · Covers kit `main` after the recovery-platform migration
(opt-in suggestions, model tools, Serena and reference files)

---

## AI READING INSTRUCTION

Read `[SPEC]` and `[BUG]` blocks for authoritative facts.
Read `[NOTE]` only if additional context is needed.
`[?]` blocks are unverified: treat them with lower confidence and say so when you rely on one.
Section 11 is the index of every `.mjs` file; jump there when you need to know which file does what.

---

## Contents

1. [What the reviewer is](#1-what-the-reviewer-is)
2. [The big picture](#2-the-big-picture)
3. [A review run, step by step](#3-a-review-run-step-by-step)
4. [Facts: what the engine works out before the model runs](#4-facts-what-the-engine-works-out-before-the-model-runs)
5. [The model: sandbox, inputs and outputs](#5-the-model-sandbox-inputs-and-outputs)
6. [Publish: what gets posted, and how](#6-publish-what-gets-posted-and-how)
7. [Security model](#7-security-model)
8. [The learning loop](#8-the-learning-loop)
9. [Consumer configuration (`.pr-review/`)](#9-consumer-configuration-pr-review)
10. [Tooling for maintainers (`bin/`)](#10-tooling-for-maintainers-bin)
11. [Index of `.mjs` files](#11-index-of-mjs-files)
12. [Tests](#12-tests)
13. [Known failure modes](#13-known-failure-modes)
14. [Open questions](#14-open-questions)
15. [Changelog](#15-changelog)

---

## 1. What the reviewer is

**[SPEC]**

- An **advisory** pull-request reviewer built on `anthropics/claude-code-action@v1`. It comments; it never
  approves, requests changes, or blocks a merge, and it is never a required check.
- The **engine** (this repository, `marcusk639/pr-review-kit`) is shared. Each **consumer** repository keeps its
  own project knowledge in a root `.pr-review/` directory and two workflow files.
- Consumers pin the kit by **full 40-character commit SHA** in every `uses:` line. A tag or branch would let the
  engine change under them.
- Runtime: Node 22 built-ins only. Nothing is installed when the actions run.
- Current consumers: rag-system, doc-classifier, software-dev-team, karbon-dashboards, cpa-consulting,
  claude-config, and recovery-platform (which also turns on every opt-in capability in section 5.4).

**[NOTE]**
The kit was extracted from recovery-platform's in-repo reviewer. Everything that was the same in every
repository (the pipeline, the security controls, the comment format, the learning loop) moved here; everything
that is about one codebase (which files relate to which, which bugs matter, what is a false positive there)
stayed in that repository's `.pr-review/`.

Its job is to find real breaks, especially ones that cross component boundaries (an API route changed but its
client did not, a Firestore query with no index), and to say plainly what it checked. Noise counts as failure:
it does not post style nits or restate the diff.

---

## 2. The big picture

**[SPEC]**
Two workflows per consumer, four composite actions in the kit:

| Workflow (consumer)   | Trigger                                                         | Kit actions used                   | Purpose                                                         |
| --------------------- | --------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| `pr-review.yml`       | `pull_request`: opened, synchronize, ready_for_review, reopened | `review`, then `publish`           | Review one PR head and post the result                          |
| `pr-review-learn.yml` | Weekly cron, plus `workflow_dispatch`                           | `learn` (job 1), `propose` (job 2) | Turn maintainer feedback into a proposed memory update (one PR) |

The review job runs four stages in order. Each stage has exactly the access it needs and no more:

```
            PR head (untrusted)                     base commit (trusted)
                   |                                        |
  +----------------v----------------------------------------v----------------+
  | 1. Prepare   checkout head; check out the base SHA to .review-base;      |
  |              restore .pr-review/ from base; NEUTRALIZE the PR head        |
  +-------------------------------------+------------------------------------+
                                        |
  +-------------------------------------v------------------------------------+
  | 2. Facts     model-free, no token. Diff, tier, hygiene + project checks,  |
  |              prior state. Writes OUT/ (model material) + STATE_FILE       |
  |              (trusted snapshot, outside the model's reach)                |
  +-------------------------------------+------------------------------------+
                                        |
  +-------------------------------------v------------------------------------+
  | 3. Model     claude-code-action. Read/Grep/Glob only, no shell, no        |
  |              network, no posting tool. Writes 3 files in OUT/:            |
  |              findings.json, summary.md, inline.json                       |
  +-------------------------------------+------------------------------------+
                                        |
  +-------------------------------------v------------------------------------+
  | 4. Publish   model-free. Fresh base checkout. The ONLY stage with         |
  |              secrets (id key, private-channel token). Validates the       |
  |              model's files, posts inline comments, delivers security      |
  |              detail privately, upserts the one summary comment            |
  +--------------------------------------------------------------------------+
```

**[SPEC]**
Core rules that every stage follows:

- **Trust comes from the base commit.** Config, knowledge, project checks and learned memory are read from the
  PR's base SHA (the "trust SHA"), never from the PR head. A PR cannot change how it is reviewed.
- **The model never posts.** It writes files; model-free code decides what is posted.
- **Secrets never meet the model.** The Claude token reaches only the claude-code-action step. The id key and
  private-channel tokens reach only publish. Project checks run with a PATH-only environment.
- **Security detail is never public.** A public comment carries only a pointer ("a security finding was
  delivered privately"); the detail goes to a draft security advisory (public repos) or an issue in a
  private, owner-only inbox repository (private repos).
- **Fail closed, never fail the PR.** A broken check is reported as "unavailable"; a bad config means "no
  review"; publish always exits 0.

---

## 3. A review run, step by step

### 3.1 The consumer's review job

**[SPEC]**
`examples/consumer/.github/workflows/pr-review.yml` is the reference shape. `bin/pr-review.mjs validate` checks
a consumer's copy against it.

| Item        | Value                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| Skips       | Draft PRs, forks (no secrets), Dependabot                                                                            |
| Concurrency | `pr-review-<PR number>`, cancel in progress (a new push replaces the running review)                                 |
| Permissions | `contents: read`, `pull-requests: write`, `issues: read`, `id-token: write`                                          |
| Step 1      | `actions/checkout` of the PR head SHA, `fetch-depth: 0`, `persist-credentials: false`                                |
| Step 2      | `kit/actions/review@SHA` with `claude_code_oauth_token` (and optional `redact_terms`)                                |
| Step 3      | `kit/actions/publish@SHA`, `if: always()`, with `trust_sha`, outcome, execution file, `id_key` and the channel token |

### 3.2 Inside `actions/review`

**[SPEC]**

| #   | Step                       | What it does                                                                                                                     |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Run start                  | Sets `OUT` (`$RUNNER_TEMP/pr-review`), `STATE_FILE`, `RUN_STARTED_AT` in `GITHUB_ENV`; resolves the **trust SHA** (PR base) once |
| 2   | Clear base checkout path   | Removes any `.review-base` the PR head might have committed                                                                      |
| 3   | Checkout trust SHA         | Checks the base commit out to `.review-base/`                                                                                    |
| 4   | setup-node                 | Node 22 (pinned by SHA)                                                                                                          |
| 5   | Restore reviewer knowledge | Replaces the head's `.pr-review/` with the base copy, so the model reads trusted knowledge                                       |
| 6   | Neutralize PR head         | `engine/neutralize.mjs` (see 7.2)                                                                                                |
| 7   | Facts                      | `engine/facts.mjs` (section 4). Outputs `tier`, `max_turns`, `extra_deny`                                                        |
| 8   | External counterparts      | `engine/externals.mjs`: token-free checkouts of other public repos this project links into                                       |
| 9   | Serena (opt-in)            | `Set up uv for Serena`, `Serena setup`: only with input `serena: on` (section 5.4); never fails the job                          |
| 10  | Review                     | claude-code-action, only when tier is not `none`; `continue-on-error: true` (section 5)                                          |
| 11  | Stop Serena                | `always()`: kills every `serena-runner` process; records `PR_REVIEW_SERENA_STOP=ok` only when none survives                      |

Outputs to the workflow: `trust_sha`, `tier`, `outcome`, `execution_file`.

### 3.3 Inside `actions/publish`

**[SPEC]**

| #   | Step               | What it does                                                                                     |
| --- | ------------------ | ------------------------------------------------------------------------------------------------ |
| 0   | Serena stopped     | Fails (so Publish is skipped) when Serena ran and Stop Serena did not record `ok`                |
| 1   | Clear publish path | Removes any `.review-publish` left in the workspace                                              |
| 2   | Checkout trust SHA | A **fresh** checkout of the base commit to `.review-publish/`; the model never touched it        |
| 3   | Publish            | `engine/run-publish.mjs` → `engine/publish.mjs` (section 6). Secrets enter the process here only |
| 4   | Cleanup            | Removes the publish checkout                                                                     |

**[NOTE]**
Why two base checkouts? `.review-base` is used before and during the model run; it sits in the workspace the
model can see (though its reads are denied). Publish re-checks out the base commit fresh so nothing the model
could have written, even through a path the deny list missed, can change publish's config or code.

---

## 4. Facts: what the engine works out before the model runs

**[SPEC]**
`engine/facts.mjs` runs from the kit's pinned action path, against the neutralized PR-head tree, with the project
loaded from `.review-base`. `GH_TOKEN` is deleted from its environment before any project code runs. It never fails
the job.

What it produces:

| Output           | Where           | Read by    | Contents                                                                                |
| ---------------- | --------------- | ---------- | --------------------------------------------------------------------------------------- |
| `facts.md`       | `OUT/`          | model      | Deterministic hints, project setup, prior feedback (quoted as data), trusted PR context |
| `pr.diff`        | `OUT/`          | model      | Full PR diff (base...head), withheld paths stubbed, capped at 1.5 MB                    |
| `increment.diff` | `OUT/`          | model      | What changed since the last reviewed head (incremental tiers only)                      |
| `commits.txt`    | `OUT/`          | model      | The PR's commits                                                                        |
| `REVIEW.md`      | `OUT/`          | model      | The kit's generic procedure (`engine/REVIEW.md`)                                        |
| `state.json`     | `OUT/`          | model      | Prior ledger, acknowledged slugs, tier (convenience copy)                               |
| trusted snapshot | `STATE_FILE`    | publish    | The same state plus `hunkRanges` (RIGHT-side hunks per file), outside the model's reach |
| `reference/`     | `OUT/`          | model      | `config.referenceFiles` copied from the trust SHA, `.ref` suffix (section 5.4)          |
| step outputs     | `GITHUB_OUTPUT` | the action | `tier`, `max_turns`, `extra_deny` (withheld Read denies), `model_shell`, `extra_allow`  |

### 4.1 Prior state

**[SPEC]**

- The one summary comment (first line `<!-- pr-review:summary -->`, author `github-actions[bot]`) carries a hidden
  **ledger** marker `<!-- pr-review:ledger v1 <base64> -->` with every finding's id, severity and status, plus the
  last reviewed head and base SHAs.
- `state.mjs` reads it (`findSummary`, `loadState`), plus the reviewer's inline comments (each ends with
  `<!-- pr-review:fp=<slug> -->`) and their reactions.
- **Acknowledged slugs**: inline comments a trusted maintainer replied to with a `review:` reply. The model must not
  re-raise them.

### 4.2 Tiers: how much review a push gets

**[SPEC]**
`tier.mjs` `classify()` picks one tier per run from the increment (`increment.mjs` `computeIncrement()`):

| Tier                    | When                                                                                          | Default max turns |
| ----------------------- | --------------------------------------------------------------------------------------------- | ----------------- |
| `none`                  | No change since the last review, or no valid project config. The model does not run           | 0                 |
| `light`                 | Every changed file is a light file (docs, images, lockfiles) and no link type is touched      | 15                |
| `base-drift`            | The PR's own diff is unchanged, but the base moved and changed a counterpart this PR links to | 15                |
| `incremental`           | New commits touching only link types already reviewed on this PR                              | 40                |
| `incremental-new-links` | New commits touch a link type not seen before, or the increment is ≥ `largeShare` of the PR   | 60                |
| `full`                  | First review, or the last reviewed head is no longer an ancestor (force push, rebase)         | 60                |

- `tiers.set`: `all` (default), `none-light-full` (no incremental tiers), or `full` (every push with changes is full).
- `tiers.disabled`: a disabled tier widens to the next one. `none` and `full` are always available.
- A tier's `maxTurns` of 0 means the model does not run on it.
- Every git failure in `computeIncrement` degrades to the safe side: unreachable → `full`; a hash or drift failure
  → treated as changed.

**[NOTE]**
"PR unchanged" uses an exact diff hash of `base...head` before and after, not `git patch-id`, because patch-id
ignores whitespace and would hide re-indentation. A merge from the base branch pulls other PRs' files into
`last..head`; the increment is filtered to this PR's own files so that does not inflate the tier.

### 4.3 Routing and link types

**[SPEC]**

- `.pr-review/routing.json` maps path globs to a **link type**, its **counterparts** (the paths that must stay in
  step with it) and the checklist **classes** relevant there. Example:
  `{ "linkType": "api-route", "paths": ["src/**"], "counterparts": ["web/**"], "classes": [1, 2, 3] }`.
- `routing.mjs` `route(files)` returns the link types a set of files touches; `packageOf(file)` returns the
  package, longest prefix first.
- Link types drive tiers (new link type → bigger review), base-drift (did a counterpart change?) and learning
  scopes (a lesson applies to one link type).

### 4.4 Built-in checks (`hygiene.mjs` and `repo-facts.mjs`)

**[SPEC]**
All produce **hints** for the model to confirm, never verdicts. Each is configured under `config.checks`; `false`
turns one off.

| Check                | Finds                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkSecrets`       | Secret-shaped strings in added lines (with `secrets.allowPaths` / `allowPatterns` for test fakes)                                                          |
| `checkPiiLogs`       | Log calls (`logCall` regex) that mention PII fields (`fields` regex)                                                                                       |
| `checkNewFileSize`   | Large new files                                                                                                                                            |
| `checkTitleScope`    | A conventional-commit PR title whose scope is too bare (`checks.titleScope.bareScopes`)                                                                    |
| `checkSelfEdit`      | A PR that edits the reviewer itself (`.pr-review/**`, review workflows): a **High** fact, unless it is a verified learning PR (8.5)                        |
| `checkEnginePin`     | Kit `uses:` lines that are not a full SHA, or disagree with each other                                                                                     |
| `runVerifyDiff`      | Runs the consumer's base-branch `checks.verifyDiff.script` against the PR's fork point, isolated (no token, empty cwd and HOME, no user/system git config) |
| `mergeFromBase`      | Merges from the base branch inside the PR range                                                                                                            |
| `writeCollaborators` | Repository writers outside an allowed list (optional)                                                                                                      |

### 4.5 Project checks

**[SPEC]**

- Consumer-written ES modules listed in `config.checks.project` (e.g. `["checks/index.mjs"]`), loaded **from the
  trust checkout only**.
- `project-checks.mjs` forks `check-child.mjs` per module with a **PATH-only environment** (no token), an **empty
  temp directory as cwd**, and a hard kill after `checks.timeoutMs` (default 20000).
- A check gets a context with helpers: `git(args)` (bound to `git -C <repo>`), `readHead` / `readBase` /
  `listFiles` (read from git objects, never through a symlink), `parseOnly(kind, text)` (does it parse, without
  executing it), `mergeBase`.
- A check that throws or times out becomes `pre-check unavailable: <name>` in `facts.md`.
- Examples: `examples/consumer/.pr-review/checks/routes.mjs` (a new route with no client) and
  recovery-platform's `.pr-review/checks/*.mjs` (Firebase exports, regions, index and rules coverage, twin
  products).

---

## 5. The model: sandbox, inputs and outputs

### 5.1 Sandbox

**[SPEC]**
The `Review` step runs claude-code-action (pinned by SHA) with:

| Setting                  | Effect                                                                                                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--setting-sources user` | No project `.claude/settings*.json` is loaded                                                                                                                                                                                                                                                             |
| `--strict-mcp-config`    | No MCP server from the repository                                                                                                                                                                                                                                                                         |
| `disableAllHooks: true`  | No hooks run                                                                                                                                                                                                                                                                                              |
| `claudeMdExcludes`       | `**/CLAUDE.md`, `**/CLAUDE.local.md`, `**/AGENTS.md` are not loaded as instructions                                                                                                                                                                                                                       |
| `--allowedTools`         | `Read`, `Grep`, `Glob`, and `Write`/`Edit` of exactly `OUT/inline.json`, `OUT/findings.json`, `OUT/summary.md`; plus facts' `extra_allow` and Serena's four tools when a project opts in (5.4)                                                                                                            |
| `--disallowedTools`      | `Bash` (unless facts emits `model_shell=on`), web tools, `Skill`, `Task`, `Agent`, every GitHub MCP/comment tool, `SlashCommand`, writes to the workspace or kit, reads of `.git`, `.claude-pr`, `.review-base`, `.review-publish`, `~/.*`, `/proc`, runner internals, plus `extra_deny` (withheld paths) |
| `--max-turns`            | From the tier (4.2)                                                                                                                                                                                                                                                                                       |
| `--add-dir OUT`          | The only directory outside the repository the model can reach                                                                                                                                                                                                                                             |

### 5.2 What the model is told

**[SPEC]**

- The prompt is one line: follow `OUT/REVIEW.md` (the kit's procedure), then the project addendum
  `.pr-review/REVIEW.md`; here are `OUT`, the base and head SHAs; ignore `.review-base/`, `.review-publish/` and
  `*.pr-head`.
- `engine/REVIEW.md` defines the procedure: read `facts.md` first, confirm or reject each hint, trace changed code
  to its counterparts (routing), check the project's bug classes, do not re-raise acknowledged or ledgered
  findings, and write the three output files.
- Knowledge files listed in `config.knowledge` (checklist, conventions, false positives, contract map, learned
  lessons) are read from `.pr-review/`, which step 5 restored from base.

### 5.3 What the model writes

**[SPEC]**
The model writes in this order: `inline.json`, `summary.md`, then `findings.json` last. A run cut off before
the last write is not a completed review.

`OUT/findings.json`: an object.

| Field           | Rule                                                             |
| --------------- | ---------------------------------------------------------------- |
| `reviewedSha`   | The head SHA reviewed                                            |
| `findings`      | Array; at most 200 kept (lowest severities dropped first)        |
| `resolvedSlugs` | Slugs from the ledger that this head fixes                       |
| `complete`      | `true` only as the model's last write, after `summary.md` exists |

Each finding:

| Field                                               | Type / rule                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `slug`                                              | `c<class>:<file-part>:<symbol-part>`, stable across runs (the identity of a finding)   |
| `class`                                             | A configured class id                                                                  |
| `severity`                                          | `Critical`, `High`, `Medium`, `Low`                                                    |
| `confidence`                                        | `high`, `medium`, `low`                                                                |
| `security`                                          | boolean. Forced `true` when the class (or the slug's class prefix) is a security class |
| `package`, `area`, `title`, `feature`, `why`, `fix` | Non-empty strings, each capped                                                         |
| `locations`                                         | 1–10 of `{ file, line, side: "changed" \| "counterpart" }`                             |
| `reraise`                                           | Optional: why an acknowledged finding is raised again                                  |

`OUT/summary.md`: the narrative part of the summary comment. `OUT/inline.json`:
`[{ slug, path, line, side: "RIGHT" | "LEFT", body }]`, candidate inline comments.

**[NOTE]**
The model has no way to post. If `findings.json` is missing, malformed or lacks `"complete": true`, publish
posts "review did not complete (reason), will retry on next push" with the prior ledger, and nothing from that
run's findings.

### 5.4 Opt-in capabilities

**[SPEC]**
Every one is off by default; a project turns it on in its trusted config (or, for Serena, the workflow input).

| Capability      | Turn on                                          | What changes                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium inline   | `inline.severities` includes `Medium`            | Medium findings may get inline comments. Critical and High entries are always placed first under `inline.max`; only Critical/High drops are announced                                                                                                                                                                                                                        |
| Suggestions     | `inline.suggestions.enabled: true`               | An `inline.json` entry may carry `start_line` and `suggestion`. Publish fences it only inside one trusted hunk, within the size caps, never on `.github/**`, `.pr-review/**`, any `.claude/`, manifests, lockfiles, `blockedPaths`, or paths routed to a security class or `blockedClasses`                                                                                  |
| gh read         | `model.ghRead: true`                             | `Bash(gh pr diff:*)` and `Bash(gh pr view:*)`, nothing else. Not allowed with `withheld` paths (the diff would show them)                                                                                                                                                                                                                                                    |
| Reply           | `model.reply: true`                              | `Bash(node <kit>/engine/reply.mjs)` and `Write`/`Edit` of `OUT/reply.md`. One comment per run, refused unless it starts `pr-review:` and names no secret, security slug or file, withheld path, or (while the ledger has a security entry) any file. Publish re-checks it against the final findings and prior security files and deletes it if it leaks (`reply-guard.mjs`) |
| Serena          | action input `serena: on` + `.pr-review/serena/` | Four read-only lookups through an MCP server run as `serena-runner`: empty environment, no network (iptables), a root-owned copy of tracked files minus `serena.exclude` and `withheld`; isolation probes before any output; publish refuses if a process survives                                                                                                           |
| Reference files | `referenceFiles: [globs]`                        | Matching files at the trust SHA are copied to `OUT/reference/` (`.ref`, `.claude` → `dot-claude`) and listed in `facts.md` as data                                                                                                                                                                                                                                           |

**[NOTE]**
The reply is the one exception to "the model never posts". It goes through kit code from the pinned action path,
which reads the project from the trust checkout, the body only from `OUT/reply.md` (never a symlink), and the
target only from the event file, so the model cannot post a file it names. recovery-platform asked for it; other
projects should leave it off unless maintainers ask the reviewer questions in PR comments.

---

## 6. Publish: what gets posted, and how

**[SPEC]**
`engine/run-publish.mjs` loads the project from `.review-publish`, reads `PR_REVIEW_ID_KEY` and the channel
token (the only place in the engine that reads secrets), then calls `publish()`. Order of operations:

1. **Stale-run guard.** If the PR's head has moved past this run's head, post nothing.
2. **Completion.** `completion.mjs` decides whether the run produced a complete review: the review step
   succeeded, `findings.json` validates (`findings.mjs`), and the execution log shows no rate limit. Otherwise the
   summary says the review is incomplete or partial and keeps the prior ledger.
3. **Prior state** from the trusted `STATE_FILE` snapshot (`prior.mjs`); if facts could not read it, a re-read of
   the existing summary. History is never replaced by empty defaults.
4. **Inline stage** (`inline-stage.mjs`): select and post inline comments, then run the post-hoc guard.
5. **Private delivery** (`deliver.mjs`) of security findings, before the summary is rendered, so the public
   pointer can say whether delivery worked.
6. **Ledger merge** (`ledger.mjs`): new findings added, missing ones resolved, dispositioned ones kept.
7. **Render** the summary (`render.mjs`), apply style rules (`style.mjs`), **upsert** it (`summary-post.mjs`).
8. **Status**: a `::warning::` for anything that left the summary stale, and one line in the job summary
   (`status.mjs`).

### 6.1 Inline comments

**[SPEC]**
An entry from `inline.json` is posted only if all hold (`inline-post.mjs`):

- Its slug is a **non-security** finding in `findings.json` whose severity is in `config.inline.severities`
  (default Critical, High), and the summary would not withhold it. Critical and High entries are considered
  first.
- Its path is one of the PR's changed files (facts' trusted list), and not a withheld path.
- No inline comment with that slug exists yet.
- `unsafeInline()` passes on the exact body: no secret pattern, no security-file mention.
- At most `config.inline.max` (default 10) per run; body capped at 4000 characters.
- A `suggestion` survives only under the rules in 5.4; when it fails, the comment posts without it.

Publish appends the `fp` marker itself and posts all survivors as one PR review. Afterwards `inline-guard.mjs`
**deletes** any of this run's `github-actions[bot]` review comments that carry a security fingerprint, no
fingerprint at all, a secret pattern, or a security-file mention. `claude[bot]` comments are left alone.

### 6.2 The summary comment and ledger

**[SPEC]**

- Exactly one summary comment per PR, updated in place; first line `<!-- pr-review:summary -->`.
- Every model-written string passes through `redact()` and loses HTML-comment syntax, so it cannot leak a
  secret or plant a fake marker ahead of the real ledger.
- Body capped at 60000 characters; the ledger marker is fitted to its own cap (`fitMarker`), and the visible
  history shows the last 5 runs.
- **Ledger ids.** Public findings: an unkeyed id (their slug is already public). Security and withheld findings:
  an **HMAC** of the slug keyed with `PR_REVIEW_ID_KEY`, plus keyed hashes of their files (`fileIds`). Without the
  key, no new security or withheld entry is created; existing ones are carried unchanged.
- A failed update is retried once with a minimal fixed banner that re-emits the previous marker, so the comment
  never silently claims an older review.

**[NOTE]**
Why HMAC? A slug like `c1:src/auth.ts:verifyUser` is guessable from the public diff. A plain hash of it in a
public comment could be brute-forced back to the file and symbol of a private security finding. The key lives
only in the publish step.

### 6.3 Security channels

**[SPEC]**
`config.securityChannel` selects where security detail goes; the public summary only ever shows a pointer.

| Channel              | For           | Mechanism                                                                        | Token / variable                                       |
| -------------------- | ------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `advisory`           | Public repos  | Draft repository security advisory (`advisories.mjs`), deduplicated by opaque id | `advisory_token` (e.g. `SECURITY_ADVISORY_TOKEN`)      |
| `private-repo-issue` | Private repos | Issue in a separate owner-only private repo (`issue-channel.mjs`)                | `vars.PR_REVIEW_PRIVATE_REPO`, `PR_REVIEW_ISSUE_TOKEN` |
| `none`               | Either        | Nothing delivered; the pointer says so                                           | none                                                   |

- The inbox is **verified on every delivery** (`private-channel.mjs`): it must be private and every collaborator a
  configured reader. Any failure means nothing is sent.
- Issue bodies are redacted and lose `@`-mentions and email addresses. A closed inbox issue resolves its ledger
  entry.

### 6.4 Withholding (security-file needles)

**[SPEC]**

- `needles.mjs` builds "needles" from every current security finding's file paths; `fileids.mjs` carries keyed
  hashes of them forward in the ledger so later runs keep withholding.
- Any public text (a non-security finding, an inline body, narrative) that **mentions** a needle is withheld,
  because it would point at the security finding. Mentions are matched across disguises: `./`, absolute paths,
  doubled slashes, a bare basename, case, `\`, zero-width characters, HTML entities, percent-escapes. A different
  file that shares a basename does not match.
- `config.withheld` globs are separate: paths the model must never read at all (client material, private notes).
  The model gets Read denies and a diff with those hunks stubbed; facts' checks still see them.

---

## 7. Security model

### 7.1 Threats and controls

**[SPEC]**

| Threat                                                                  | Control                                                                                                 | Where                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| A PR changes the reviewer's config or knowledge                         | Project read from the base SHA; `.pr-review/` restored from base; self-edit is a High finding           | review action steps 1–5, `hygiene.mjs`      |
| A PR plants instructions (`CLAUDE.md`, `.claude/`, MCP)                 | Neutralize (`*.pr-head`), `--setting-sources user`, `claudeMdExcludes`, `--strict-mcp-config`, no hooks | `neutralize.mjs`, review action             |
| A PR symlink redirects a read (to `.git/config`, `/proc`, runner files) | Symlinks replaced by placeholders; facts and checks read git objects, not the tree; Read denies         | `neutralize.mjs`, `git-read.mjs`            |
| A PR's code steals a token via a check                                  | Checks from base only, PATH-only env, empty cwd, timeout; `GH_TOKEN` deleted before checks              | `project-checks.mjs`, `check-child.mjs`     |
| A PR's `.gitattributes` / git config runs a filter                      | Isolated git: no global/system config, `--no-textconv`, empty cwd/HOME                                  | `diff.mjs` `GIT_ENV`, `runVerifyDiff`       |
| The model posts something harmful                                       | Model has no posting tool; publish validates, filters, redacts; post-hoc guard deletes leaks            | `publish.mjs`, `inline-*.mjs`, `render.mjs` |
| The model tampers with publish's inputs                                 | Publish trusts `STATE_FILE` and a fresh base checkout, never `OUT/state.json`                           | `prior.mjs`, publish action                 |
| A security finding becomes public                                       | Pointer-only summary, private channel, HMAC ids, needle withholding                                     | section 6.3–6.4                             |
| Feedback text instructs the reviewer                                    | Feedback is quoted data; instruction-shaped text is never a lesson candidate                            | `feedback.mjs`, `candidates.mjs`            |
| A pusher forges a learning PR to skip self-edit review                  | Exemption needs API-verified bot author and committer **and** a GitHub-verified signature               | `learning-pr.mjs`                           |
| The model's reply leaks detail or posts a chosen file (opt-in)          | Kit-owned command, body only from `OUT/reply.md`, refusal rules, one per run                            | `reply.mjs`, `reply-guard.mjs`              |
| Serena reads credentials or phones home (opt-in)                        | Separate user, empty env, iptables, chmod 700 on `.git`/`RUNNER_TEMP`, probes; publish stop guard       | review action, `serena-prep.mjs`            |
| Secrets in logs                                                         | Logs carry status codes and counts only; tokens never on command lines                                  | every publishing module                     |

### 7.2 Neutralizing the PR head

**[SPEC]**
`engine/neutralize.mjs` runs after the knowledge restore and **before facts**:

- Every symlink becomes a plain placeholder file.
- `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` at any depth, nested `.claude/` directories, search-tool control
  files (`.ignore`, `.rgignore`, `.gitignore`, `.ripgreprc`), `.mcp.json`, `.claude.json`, and git control files
  (`.gitconfig`, `.gitattributes`, `.gitmodules`, `.config/git/`) are renamed `*.pr-head`.
- The root `.claude/settings*.json` are removed (claude-code-action restores `.claude/` from the base branch).
- The model reads their **changes** from `OUT/pr.diff`, as content to review, not instructions.

---

## 8. The learning loop

**[SPEC]**
The reviewer improves from maintainer feedback, but memory reaches it **only through one learning PR that a
human merges**.

```
 PR comments by the reviewer
   |  👍 / 👎 reactions, "review:" replies, "review: F-xxxxxx" lines   (trusted authors only)
   v
 collect ──> candidates ──> distill (optional model) ──> apply (gate) ──> commands ──> propose
 (no token)  (deterministic)  (sandboxed, no write)        (deterministic) (scratch copy)  (write token, one PR)
```

### 8.1 Giving feedback

**[SPEC]**

| Feedback                                                     | Counts as                                               |
| ------------------------------------------------------------ | ------------------------------------------------------- |
| 👍 or 👎 on an inline comment                                | A precision vote for that finding's class and link type |
| A reply in that thread whose first own line starts `review:` | A text correction (and marks the finding acknowledged)  |
| A PR comment line `review: F-1a2b3c <text>`                  | A text correction for the finding with that handle      |

- Only `config.trust.feedbackAuthors` count (e.g. `repository-owner`). Bots never count.
- **Edited comments are ignored**; quoted lines and code fences are dropped; text is redacted and capped.

### 8.2 From feedback to lessons

**[SPEC]**

- `collect.mjs`: every PR updated in the last `learning.windowDays` (45), open, closed or merged; each record is
  tied to a finding slug and enriched with class, path, link types, severity and security.
- `candidates.mjs`:
  - an explicit text correction → a lesson scoped to that finding (file, class, link types);
  - repeated 👎 without text on one class under one directory across ≥ `learning.repeatThreshold` (2) PRs → a
    pattern lesson;
  - a lone 👎 → nothing (a precision count only);
  - instruction-shaped text → never a candidate; it is listed as unresolved feedback for the owner to weigh.
- `precision.mjs`: 👍/👎 per class and link type, stored per PR in `learned/precision.json`. A class with at least
  `demote.minVotes` (5) votes and precision ≤ `demote.maxPrecision` (0.4) is **demoted** (the model is told to
  hold its findings to a higher bar). Votes on security, Critical or High findings are **protected**: shown, but
  never used to demote.
- **Distill** (`learning.distill: "model"`): a sandboxed claude-code-action step following `engine/DISTILL.md`
  rewrites candidates into short rules. It has no write token and the same withheld denies. With
  `distill: "deterministic"` the candidates' own text is used.

### 8.3 The apply gate

**[SPEC]**
`apply.mjs` accepts a proposal only if it cites one candidate, stays inside that candidate's scope, targets a
configured knowledge file, and carries a short rule that is not instruction-shaped. Then:

- A lesson that would **narrow security coverage** is kept as `needs-decision` and never rendered.
- `learning.forbidden` globs and `redact_terms` matches reject a lesson.
- A newer lesson replaces an older one with the same scope key; lessons whose paths no longer exist are pruned;
  memory is capped at `learning.maxLessons` (40).
- Feedback sources of a learning PR the owner **closed unmerged** are treated as consumed (`closed.mjs`), so the
  same lessons are not proposed again.

### 8.4 Proposing

**[SPEC]**

- `render.mjs` writes active lessons into **managed blocks** in the knowledge files and to
  `learned/lessons.json`, and builds the PR body.
- `commands.mjs` runs the consumer's `learning.commands.format` / `validate` on a scratch copy of HEAD with no
  secrets. A failing command means nothing is proposed.
- `propose.mjs` (the only learning step with a write token) commits the bundle as one commit on
  `learning.branch` (`pr-review/learning`) and opens or updates **one** learning PR. Only paths under
  `.pr-review/` are written. A branch carrying a commit not authored by the bot (a maintainer's edit) is never
  overwritten; the PR gets a note instead.

### 8.5 How a learning PR is itself reviewed

**[SPEC]**
A learning PR edits `.pr-review/`, which normally triggers the High self-edit finding. It is exempt only when
**both** hold (`learning-pr.mjs`):

- `verifyLearningPr` (GitHub API, not git metadata): opened by `github-actions[bot]` from the learning branch, and
  every commit's GitHub author and committer is the bot **with a signature GitHub verified**.
- `learningPrOnly` (git objects): every change is inside managed blocks or `learned/*.json`, and the JSON is valid.

**[NOTE]**
Commit author emails are set by whoever pushes, so they prove nothing. A verified signature is what a pusher
cannot forge; combining it with a content check means a compromised branch still gets the High finding.

---

## 9. Consumer configuration (`.pr-review/`)

**[SPEC]**

| File / dir               | Purpose                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `config.json`            | Engine settings (below). Validated by `config-schema.mjs`; errors mean tier `none` |
| `REVIEW.md`              | Project addendum to the kit's procedure: what matters in this codebase             |
| `routing.json`           | Path globs → link types, counterparts, classes (4.3)                               |
| `checklist.md`           | The bug classes, with what to look for                                             |
| `conventions.md`         | Project conventions the reviewer should know                                       |
| `false-positives.md`     | What looks like a bug here but is not                                              |
| `contract-map.md`        | Which pieces depend on which (cross-component contracts)                           |
| `learned-lessons.md`     | Managed block of active learned lessons                                            |
| `checks/*.mjs`           | Project checks (4.5)                                                               |
| `learned/lessons.json`   | Lesson store (written by learning PRs only)                                        |
| `learned/precision.json` | Per-PR vote counts (written by learning PRs only)                                  |

Main `config.json` keys:

| Key                                 | Meaning (default)                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`, `project`                | Schema version (1) and project name                                                                                                                                          |
| `visibility`                        | `public` or `private`; must agree with the channel                                                                                                                           |
| `securityChannel`                   | `advisory`, `private-repo-issue`, `none`                                                                                                                                     |
| `workflowPath`, `learnWorkflowPath` | Where `validate` finds the workflows                                                                                                                                         |
| `packages`                          | Top-level packages for grouping findings                                                                                                                                     |
| `knowledge`                         | Knowledge files the model reads                                                                                                                                              |
| `classes`                           | `[{ id, name, security?, always?, light? }]`: security classes are always private; `always` classes are checked on every tier; `light` classes are checked on the light tier |
| `tiers`                             | `set`, `disabled`, `maxTurns`, `largeShare` (0.5)                                                                                                                            |
| `lightFiles`, `lightExclude`        | What counts as a light change                                                                                                                                                |
| `withheld`                          | Globs the model never reads                                                                                                                                                  |
| `referenceFiles`                    | Globs copied from the trust SHA to `OUT/reference/` as data (5.4)                                                                                                            |
| `model`                             | `ghRead`, `reply` (both false): opt-in model tools (5.4)                                                                                                                     |
| `serena`                            | `exclude`: directory names left out of Serena's source copy                                                                                                                  |
| `externalCheckouts`                 | Other public repos to check out token-free as counterparts                                                                                                                   |
| `inline`                            | `max` (10), `severities` (Critical, High), `suggestions` (`enabled` false, `blockedPaths`, `blockedClasses`, `maxLines`, `maxChars`, `maxRangeLines`)                        |
| `secrets`                           | `extraPatterns`, `allowPaths`, `allowPatterns`                                                                                                                               |
| `checks`                            | Built-in check settings, `project` module list, `timeoutMs` (20000)                                                                                                          |
| `style`                             | `noEmoji`, `noEmDash` for posted text                                                                                                                                        |
| `trust.feedbackAuthors`             | Whose feedback counts                                                                                                                                                        |
| `learning`                          | `windowDays`, `repeatThreshold`, `maxLessons`, `demote`, `distill`, `branch`, `forbidden`, `commands`                                                                        |

**[NOTE]**
`docs/consumer-guide.md` walks through wiring a new repository from `examples/consumer/`. The defaults reproduce
recovery-platform's original reviewer wherever it had a setting.

---

## 10. Tooling for maintainers (`bin/`)

**[SPEC]**

| Command                                                        | What it does                                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node <kit>/bin/pr-review.mjs validate`                        | From a consumer root: checks `.pr-review/` and both workflows keep the properties the engine relies on (pins, permissions, secret placement, channel)    |
| `node <kit>/bin/pr-review.mjs local --base <sha> --head <sha>` | Facts against the local repo (offline), then publish in **dry-run** mode: prints what it would post                                                      |
| `node <kit>/bin/pr-review.mjs learn --repo owner/name`         | The learning pipeline without the model or a PR: prints candidates and the proposed bundle                                                               |
| `node bin/enable-repo.mjs --repo owner/name [--apply]`         | Enables a consumer on GitHub with `gh`: `preflight`, `inbox`, `secrets`, `settings` (default), `merge`, `test-pr` (opt-in). **Dry run unless `--apply`** |

- `enable-repo.mjs` reads the consumer's secret names from its own workflows, so renamed secrets need no flag.
- Secret values never come from argv: from an environment variable of the same name, a file, or a hidden prompt;
  the id key is generated.
- Other writers or a pending write invitation block every step after `preflight` (any writer can read secrets by
  pushing a workflow edit) unless `--allow-other-writers`.

---

## 11. Index of `.mjs` files

**[SPEC]**
74 non-test modules. Lines are approximate. "Entry" marks a file run directly by an action or a person.

### 11.1 `bin/` (command-line tools)

| File                  | Purpose                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `bin/enable-repo.mjs` | Entry. Enables the reviewer on one consumer repo through `gh`, step by step; dry run unless `--apply`   |
| `bin/pr-review.mjs`   | Entry. Consumer CLI: `validate`, `local` (facts plus dry-run publish), `learn` (read-only learning run) |

### 11.2 `engine/` (pipeline stages)

| File                     | Purpose                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `engine/neutralize.mjs`  | Entry. Removes every way PR-head files could instruct or redirect the reviewer (symlinks, instruction files, git control files) |
| `engine/facts.mjs`       | Entry. The facts step: diff, tier, checks, prior state; writes `OUT/` and the trusted snapshot; never fails the job             |
| `engine/externals.mjs`   | Entry. Token-free, neutralized checkouts of other public repos a project links into                                             |
| `engine/hygiene.mjs`     | Built-in checks: secrets, PII in logs, new file size, title scope, self-edit, engine pin, verify-diff                           |
| `engine/run-publish.mjs` | Entry. Loads the project from the fresh base checkout, reads the secrets (only here), runs publish or a dry run                 |
| `engine/publish.mjs`     | Orchestrates publish: stale-run guard, completion, inline stage, private delivery, ledger, summary                              |
| `engine/advisories.mjs`  | Delivers security findings as draft repository security advisories (public repos)                                               |
| `engine/validate.mjs`    | Consumer self-check behind `pr-review.mjs validate`                                                                             |
| `engine/reply.mjs`       | Entry (opt-in). The model's one reply per run; loads the project from the trust checkout                                        |
| `engine/serena-prep.mjs` | Entry (opt-in). Serena's source-copy file list and language-server warmup files                                                 |

### 11.3 `engine/learn/` (learning pipeline)

| File                              | Purpose                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `engine/learn/run-learn.mjs`      | Entry. `collect` (feedback → candidates, model material) and `apply` (validate proposals → bundle); no write token |
| `engine/learn/collect.mjs`        | Gathers trusted feedback across PRs in the window, tied to finding slugs and enriched                              |
| `engine/learn/candidates.mjs`     | Turns feedback into candidate lessons; drops instruction-shaped text                                               |
| `engine/learn/precision.mjs`      | 👍/👎 precision per class and link type; decides demoted classes; protects security votes                          |
| `engine/learn/apply.mjs`          | The gate: accepts, holds (`needs-decision`), replaces, prunes and caps lessons                                     |
| `engine/learn/closed.mjs`         | Treats feedback behind a closed-unmerged learning PR as consumed                                                   |
| `engine/learn/commands.mjs`       | Runs the consumer's format/validate commands on a scratch copy, without secrets                                    |
| `engine/learn/render.mjs`         | Renders managed knowledge blocks and the learning PR body                                                          |
| `engine/learn/propose.mjs`        | Entry. The only write-token step: one commit, one learning PR, `.pr-review/` paths only                            |
| `engine/learn/validate-learn.mjs` | Checks the learning workflow's job split (model job has no write; write job has no secret)                         |

### 11.4 `engine/enable/`

| File                     | Purpose                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `engine/enable/plan.mjs` | Pure logic for `enable-repo.mjs`: argument parsing, secret wiring from workflows, writer risk, check readiness |

### 11.5 `engine/lib/` (shared libraries)

Grouped by concern.

**Configuration and project**

| File                | Purpose                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `config.mjs`        | Loads and normalizes `config.json` and `routing.json` from a base checkout; defaults; class helpers |
| `config-schema.mjs` | Small declarative schema: validates, fills defaults, reports errors by dotted path; never throws    |
| `project.mjs`       | Loads the project as facts and publish use it: config, routing, demoted classes                     |
| `routing.mjs`       | Maps files to packages and link types                                                               |
| `glob.mjs`          | Minimal glob matcher (`*`, `?`, `**`)                                                               |
| `paths.mjs`         | Resolves `OUT` and `STATE_FILE`; fails closed without them                                          |
| `withheld.mjs`      | `config.withheld`: Read denies, stubbed diff hunks, path hiding                                     |

**Git and diff**

| File             | Purpose                                                                              |
| ---------------- | ------------------------------------------------------------------------------------ |
| `diff.mjs`       | Isolated `git` runner (no inherited secrets or config) and unified-diff parsing      |
| `git-read.mjs`   | Reads files at a commit from git objects, refusing symlinks                          |
| `increment.mjs`  | What changed since the last review; diff-hash "unchanged" test; base-drift detection |
| `tier.mjs`       | Chooses the tier and its max turns                                                   |
| `material.mjs`   | Writes `pr.diff`, `commits.txt`, `increment.diff` for the model                      |
| `repo-facts.mjs` | Merges from base in the PR range; unexpected write collaborators                     |

**Checks**

| File                 | Purpose                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `project-checks.mjs` | Resolves and runs the consumer's project checks in forked, token-free children with a timeout |
| `check-child.mjs`    | The forked child: loads one check module and reports results over IPC                         |
| `parse-only.mjs`     | Does this text parse? Runs a parser in isolation without executing the content                |
| `facts-render.mjs`   | Renders `facts.md`, bounded                                                                   |
| `reference.mjs`      | Copies `config.referenceFiles` from the trust SHA to `OUT/reference/`                         |
| `serena-check.mjs`   | `validate`'s checks on a consumer's `.pr-review/serena/` config                               |
| `learning-pr.mjs`    | Decides whether a PR is a genuine learning PR (API verification plus content check)           |
| `workflow-check.mjs` | Text checks on a consumer's workflows and the kit pin (no YAML parser)                        |

**GitHub and prior state**

| File           | Purpose                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| `gh.mjs`       | Minimal GitHub REST client with pagination; errors carry method, status and path only        |
| `markers.mjs`  | The hidden HTML markers: summary, ledger (base64 JSON), `fp=<slug>`; the bot author          |
| `state.mjs`    | Finds the summary comment, acknowledged slugs, and loads prior state with reactions          |
| `feedback.mjs` | Parses trusted reactions, `review:` replies and handle lines into feedback records           |
| `prior.mjs`    | Prior state for publish: trusted snapshot, or a re-read of the summary; never empty defaults |

**Findings, ledger and redaction**

| File             | Purpose                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `findings.mjs`   | `findings.json` contract validation, forced-security classes, the public security pointer |
| `ledger.mjs`     | The findings ledger: entries, sanitizing, merging, resolving, fitting the marker          |
| `ids.mjs`        | Opaque ids: HMAC with `PR_REVIEW_ID_KEY`                                                  |
| `fileids.mjs`    | Keyed hashes of security findings' files, carried forward so withholding persists         |
| `needles.mjs`    | Detects any mention of a security file in public text, across disguises                   |
| `redact.mjs`     | Secret scrubbing and `redact_terms` removal for any text that may be posted               |
| `completion.mjs` | Whether a run produced a complete review, and how it is labeled                           |

**Posting**

| File               | Purpose                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `inline-post.mjs`  | Selects eligible entries from `inline.json` and posts them as one PR review      |
| `suggestion.mjs`   | Suggestion rules: blocked paths and classes, one-hunk range, size, fence         |
| `hunks.mjs`        | RIGHT-side hunk ranges of the PR diff, for the trusted snapshot                  |
| `reply.mjs`        | The reply's refusal rules and one-per-run lock (`engine/reply.mjs` runs it)      |
| `reply-guard.mjs`  | Publish's post-hoc check: deletes this run's reply if it names a security file   |
| `inline-guard.mjs` | Pre-filter (`unsafeInline`) and post-hoc deletion of unsafe bot inline comments  |
| `inline-stage.mjs` | Runs post-then-guard and returns posted slugs and notices for the summary        |
| `render.mjs`       | Renders the one public summary comment (redacted, marker-safe, capped)           |
| `summary-post.mjs` | Upserts the summary; retries once with a minimal banner that keeps the ledger    |
| `style.mjs`        | Posted-text style rules (`noEmoji`, `noEmDash`)                                  |
| `status.mjs`       | `::warning::` annotations and the one job-summary status line                    |
| `dry-run.mjs`      | Replaces posting with printing for local runs; never prints private detail in CI |

**Private delivery**

| File                  | Purpose                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| `deliver.mjs`         | Routes security findings to the configured private channel                              |
| `issue-channel.mjs`   | The `private-repo-issue` channel: redacted, deduplicated issues in the owner-only inbox |
| `private-channel.mjs` | Verifies the inbox (private, readers only) before every delivery; fail-closed           |

### 11.6 `examples/`

| File                                             | Purpose                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `examples/consumer/.pr-review/checks/routes.mjs` | Example project check: a route string added in `src/` that no client mentions |

**[NOTE]**
Non-`.mjs` engine files that matter as much as the code: `engine/REVIEW.md` (the model's review procedure),
`engine/DISTILL.md` (the distill model's procedure), and the four `actions/*/action.yml` files (step order,
permissions and the sandbox flags).

---

## 12. Tests

**[SPEC]**

- `npm test` runs `node --test` over `engine/test/*.test.mjs` (learning modules included). recovery-platform's
  contract checks and their tests live in that repository's `.pr-review/checks/`.
- Most modules are pure or take injected dependencies (GitHub calls, git), so tests run offline.
- Each consumer also tests its own project checks (`.pr-review/checks/test/` or the repo's test runner).

---

## 13. Known failure modes

**[BUG] The first setup PR reviews nothing**
Symptom: on the PR that adds `.pr-review/` and the workflows, the review job succeeds but nothing is posted; the
job summary says "skipped: project config missing or invalid on the base branch".
Cause: the project is read from the base commit, which does not have `.pr-review/` yet. This is by design: a PR
cannot configure its own review, and without trusted classes or a channel publish posts nothing.
Fix: merge the setup PR; the next PR is reviewed. `enable-repo.mjs --steps test-pr` opens a probe PR to confirm.

**[BUG] The workflow does not run on a newly opened PR**
Symptom: a PR adding the workflow (or opened just after enabling Actions) shows no "PR Review" run.
Cause: GitHub did not dispatch the `pull_request` event to the new workflow (seen on cpa-consulting #30).
Fix: close and reopen the PR (`reopened` is a trigger), or push a new commit.

**[BUG] The learning PR gets no CI**
Symptom: the weekly learning PR shows no checks from the consumer's other workflows.
Cause: it is opened with the built-in `github.token`; events created by that token do not trigger workflows.
Fix: intended. `learning.commands` run the repo's format/validate on the proposed tree before proposing. An App
token would add CI but must keep secrets away from learning-branch code (see `docs/github-tokens.md`).

**[BUG] Bulk token renames break workflows**
Symptom: after a repo-wide `GITHUB_TOKEN` → `GH_TOKEN` rewrite (2026-10-26), validate failed and one workflow
had `{{ secrets.GH_TOKEN }}` without the `$`.
Cause: a text rewrite touched expressions, env names and kit inputs alike.
Fix: keep env var names `GITHUB_TOKEN`; reference `${{ github.token }}` or `${{ secrets.GH_TOKEN }}`; never set a
token in job or workflow `env:`. `validate` enforces placement. Policy: `docs/github-tokens.md`.

**[BUG] A PR that edits the review workflow is not reviewed**
Symptom: on a PR that changes the review workflow (adding it, or moving the kit pin), the summary says "not
reviewed: this PR changes the review workflow"; the job log shows claude-code-action's "Skipping action due to
workflow validation".
Cause: claude-code-action runs the model only when the PR's copy of the workflow is identical to the default
branch's. Facts records `workflowEdited` (base vs head workflow file) and publish reports the skip instead of a
failed review; the prior ledger is kept.
Fix: intended upstream behaviour. Review such PRs by hand; reviews resume on PRs opened after it merges.

**[BUG] Review marked incomplete after a rate limit**
Symptom: the summary says "review did not complete"; no new findings appear.
Cause: claude-code-action hit a usage limit or max turns; `completion.mjs` detects it from the execution file.
Fix: push again or re-run the job later; the prior ledger is kept. Raise `tiers.maxTurns` if it is turns.

---

## 14. Open questions

**[?]**

- Whether learning-PR commits made through the GitHub API by `github-actions[bot]` always carry a
  GitHub-verified signature. If they do not, every learning PR gets the High self-edit finding (safe, but noisy).
  Not yet observed on a real learning PR.
- Whether `id-token: write` is still required by the pinned claude-code-action version when an OAuth token is
  given. It is kept because the action documents it.
- Whether the runner-internal paths in the Read deny list (`~/runners`, `~/actions-runner`,
  `/opt/actions-runner`) match every GitHub-hosted image. The deny list is defence in depth; the model has no shell.
- Whether `writeCollaborators` can list collaborators with the job's `github.token` on every plan (the endpoint may
  need more than `contents: read`); when it cannot, the fact is "unavailable".

---

## 15. Changelog

| Version | Date       | Change                                                                                                                                                                       |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.2.0   | 2026-10-30 | A PR that edits the review workflow is reported as not reviewed (claude-code-action skips it), not as a failed review                                                        |
| 1.1.0   | 2026-10-30 | Opt-in capabilities (5.4) ported from recovery-platform: suggestions and Medium inline, gh read, reply, Serena, reference files; the lost-comments notice names `inline.max` |
| 1.0.0   | 2026-10-27 | First version: pipeline, security model, learning loop, file index                                                                                                           |

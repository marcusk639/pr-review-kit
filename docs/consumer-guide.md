# Wiring a repository to pr-review-kit

For the agent or person adding the advisory PR reviewer to a project. Decisions and reasons are in
[design.md](design.md). Start from `examples/consumer/`: it passes `validate` once `KIT_SHA` is replaced by a kit
commit on the kit's `main`.

## 1. What the project owns: `.pr-review/` at the repository root

Read from **one trust SHA** (the PR's base commit, resolved by the review action) on every run; a PR cannot change
the rules it is judged by. Not under `.claude/`: claude-code-action restores `.claude/` from the base branch _tip_,
which would swap it.

| File                                                                   | Purpose                                                                                                                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`                                                          | Engine config (§2). Schema-validated; unknown keys (at any depth) are errors, and an invalid config means no review runs and nothing is published.                                     |
| `REVIEW.md`                                                            | Project addendum, read after the kit's generic procedure: what the project is, how review fits it, severity calibration, high-risk paths for large PRs, which summary sections matter. |
| `routing.json`                                                         | `[{ linkType, paths[], counterparts[], classes[] }]`. Globs: `*` one segment, `**` any depth. Link types must be unique; classes must be configured.                                   |
| `checklist.md`                                                         | One `## <id>. <name>` section per configured class (ids are integers; string ids are deferred).                                                                                        |
| contract map(s), `conventions.md`, `false-positives.md`                | Listed in `config.knowledge`. Every routing `linkType` needs exactly one `## <linkType>` section across them. Patterns and counterpart paths only, never a list of live weaknesses.    |
| `learned-lessons.md`, `learned/lessons.json`, `learned/precision.json` | Learned memory. Seed `{"version":1,"lessons":[],"consumed":[]}` and `{"version":1,"byPr":{}}`, or seed lessons from corrections already in the repo's history (§6).                    |
| `checks/*.mjs` (optional)                                              | Project checks (§3).                                                                                                                                                                   |

Each knowledge file a lesson may land in ends with:

```
<!-- pr-review:learned:begin -->
<!-- pr-review:learned:end -->
```

## 2. `config.json`

Minimum: `version: 1`, `project`, `classes`. Defaults reproduce the recovery-platform reference.

| Key                                  | Default                                                                                                    | Notes                                                                                                                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visibility`                         | `public`                                                                                                   | `public` or `private`; must match GitHub.                                                                                                                                                                                                 |
| `securityChannel`                    | `advisory` (public), `private-repo-issue` (private)                                                        | `advisory`: draft repository advisories (public repos only). `private-repo-issue`: issues in a separate private inbox repo that only the repository owner can read. `none`: pointer only. The public surface always shows only a pointer. |
| `issueBody.extraPatterns`            | `[]`                                                                                                       | Regexes removed from inbox issue bodies (on top of @-mentions and email addresses).                                                                                                                                                       |
| `workflowPath`, `learnWorkflowPath`  | `.github/workflows/pr-review.yml`, `…-learn.yml`                                                           | Watched by the self-edit and engine-pin facts.                                                                                                                                                                                            |
| `packages`                           | `[]`                                                                                                       | Path prefixes; longest wins; else `repo`.                                                                                                                                                                                                 |
| `knowledge`                          | checklist, conventions, false-positives                                                                    | Files the model reads and lessons may target.                                                                                                                                                                                             |
| `classes`                            | (required)                                                                                                 | `[{ id, name, security?, always?, light?, protected?, minConfidence? }]`. `security`: forced pointer handling. `always`: every run. `light`: applied on the light tier. `protected`: never demoted, lessons held for decision. `minConfidence`: findings below it are not shown.           |
| `tiers.set`                          | `all`                                                                                                      | `all`; `none-light-full` (light when every increment file is light and no link type is touched, else full); `full` (every push with changes is full).                                                                                     |
| `tiers.disabled`                     | `[]`                                                                                                       | Any of `base-drift`, `light`, `incremental`, `incremental-new-links`; a disabled tier widens to the next.                                                                                                                                 |
| `tiers.maxTurns`, `tiers.largeShare` | reference caps, `0.5`                                                                                      | A tier whose cap is `0` does not run the model.                                                                                                                                                                                           |
| `lightFiles`, `lightExclude`         | md/txt/images/lockfiles, `[]`                                                                              | `lightExclude` globs are never light (prompts, `SKILL.md`, `CLAUDE.md`, `.env.example`).                                                                                                                                                  |
| `withheld`                           | `[]`                                                                                                       | Paths the model may never read: Read denies (also for the `*.pr-head` variants), stubbed hunks in its diff, no inline comments. Checks and the secret scan still see them. Globs use one ASCII dialect (letters, digits, `. _ - / * ?`, `**` only as a whole segment); anything else is a config error.                                                                                                    |
| `externalCheckouts`                  | `[]`                                                                                                       | `[{ repo: "owner/name", ref, dir, sparse?: [paths] }]`, public repos, fetched token-free into `.pr-review-external/<dir>` after neutralize, `.git` removed, neutralized, SHA in facts.                                                    |
| `largePr`                            | 60 files / 5000 lines                                                                                      | Told to the model.                                                                                                                                                                                                                        |
| `inline`                             | `{ max: 10, severities: [Critical, High] }`                                                                |                                                                                                                                                                                                                                           |
| `secrets.extraPatterns`              | `[]`                                                                                                       | Regexes added to the scan and redaction. `allowPaths` (globs) and `allowPatterns` (regexes) skip known fake test credentials.                                                                                                                                          |
| `checks.*`                           | secrets on, generic PII, 300-line files, rest off                                                          | `piiLogs { fields, logCall }`, `newFileSize { maxLines, pattern }`, `titleScope { bareScopes }`, `selfEdit`, `verifyDiff { script }`, each can be `false`; `project: [modules]`. `writeCollaborators { allowed }` counts other writers (never named) in facts and the summary.          |
| `trust.feedbackAuthors`              | `["repository-owner"]`                                                                                     | Logins whose reactions and `review:` replies count; `repository-owner` resolves at runtime, so no login is committed.                                                                                                                     |
| `trust.contextAssociations`          | OWNER, MEMBER, COLLABORATOR                                                                                | Whose PR description and comments reach the model as context.                                                                                                                                                                             |
| `learning`                           | 45-day window, repeat 2, 40 lessons, demote ≥5 votes at ≤40%, distill `model`, branch `pr-review/learning` | `branch` cannot be a default-branch name. `forbidden`: files lessons may never target. `commands { format, validate }`: run on a scratch copy of the proposed tree, no secrets, `{files}` = changed files; a failure proposes nothing.                                                                                                                         |

## 3. Project checks

```js
// .pr-review/checks/routes.mjs, listed in config.checks.project
export default [
  {
    name: "route-clients", // [A-Za-z][A-Za-z0-9-]{0,39}; must be synchronous
    run({
      files,
      repoRoot,
      baseSha,
      headSha,
      title,
      config,
      git,
      readHead,
      readBase,
      listFiles,
    }) {
      // files: [{ file, oldFile, status: A|M|D|R, binary, added: [{line, text}], removed: [...] }]
      // readHead(path) / readBase(path): file text from git objects, null if absent or a symlink
      // listFiles(glob): regular files at head; git(args): stdout of git in the checkout
      return [
        {
          file: "src/api.ts",
          line: 2,
          note: "route /api/orders not referenced under web/",
        },
      ];
    },
  },
];
```

Checks run in a child process with no token and an empty working directory, killed after `checks.timeoutMs`
(default 20000). Use `ctx.git(args)` (runs `git -C <repo>`), `readHead`/`readBase`/`listFiles`, `mergeBase`, and
`parseOnly(kind, text)` (`python`, `bash`, `node`, `json`: parses, never executes). Never import
`child_process` (validate rejects it) and never read the working tree directly. Notes should carry file, line and
rule only: they are redacted, capped at 300 characters, and withheld paths become `withheld:<hash>`. Diff lines
over 2000 characters are not passed to checks. A check that throws, times out or returns a non-array (including a
promise) is "pre-check unavailable: <name>" and labels the review partial.

## 4. Workflows

Copy `examples/consumer/.github/workflows/pr-review.yml` (and `pr-review-learn.yml`), replace `KIT_SHA` with a
full kit commit SHA on the kit's `main` (the same in every `uses:`), and keep every other `uses:` pinned by SHA
(`validate` rejects tags and local actions). Project guards go in the job `if:` (e.g. `!startsWith(github.head_ref,
'e2e-fix/')`). Stacked PRs: limit the trigger with `branches: [main]` and guard `github.base_ref == 'main'`, so the
trust SHA is always a commit of the default branch. The job's `timeout-minutes` is the time cap.

Secrets map to kit inputs by **role**; the secret's name is yours:

| Input                     | Action        | Repos                                                                                               |
| ------------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| `claude_code_oauth_token` | review, learn | all (e.g. `${{ secrets.FIRM_CLAUDE_CODE_OAUTH_TOKEN }}`)                                            |
| `id_key`                  | publish       | all with a private channel (HMAC key for opaque ledger ids)                                         |
| `advisory_token`          | publish       | `advisory`: fine-grained PAT, "Repository security advisories: read and write" on this repo         |
| `private_issue_token`     | publish       | `private-repo-issue`: fine-grained PAT, Issues read/write on the inbox repo only                    |
| `private_repo`            | publish       | `private-repo-issue`: `${{ vars.PR_REVIEW_PRIVATE_REPO }}` (a repository variable, never a literal) |

Optional `redact_terms` (a secret, newline-separated literals such as a tenant name) may be passed to review,
publish and learn: removed from facts.md, pr.diff, increment.diff, commits.txt, state.json, every posted text and everything the
learning job proposes (a proposal containing one is rejected); never in config. Terms under 3 characters are ignored. `config.style { noEmoji, noEmDash }` applies to posted text.

Merged PRs: to also review PRs that merge before a review finishes, add `closed` to the trigger types and
`(github.event.action != 'closed' || github.event.pull_request.merged) &&` to the job `if:` (validate requires the
guard); a head that was already reviewed gets tier `none`.

Learning workflow: every checkout uses `ref: ${{ github.event.repository.default_branch }}`; learn and propose fail
on any other ref (a dispatch from another branch must not bring its own trust settings). `learning.forbidden`
entries are knowledge-file names or globs relative to `.pr-review/` (e.g. `maps/**`); anything else is a config
error.

Pass `trust_sha: ${{ steps.review.outputs.trust_sha }}` to publish. Any other secret is a `validate` error. Refer
to the workflow token as `${{ github.token }}` (the actions already do); `${{ secrets.GITHUB_TOKEN }}` and
`${{ secrets.GH_TOKEN }}` (a user-defined secret, possibly a broader PAT) validate with a warning only on a step
that is not a kit action; in job- or workflow-level `env:`, or passed to a kit action, they are an error (they
would reach facts and the model's step).

## 5. Check it locally

From the consumer repository root:

```sh
KIT=~/dev/pr-review-kit
node $KIT/bin/pr-review.mjs validate          # config, knowledge, workflow; kit pin on the kit's main with the sandbox
node $KIT/bin/pr-review.mjs local --base <sha>^ --head <sha> --project .pr-review
node $KIT/bin/pr-review.mjs local --base <sha>^ --head <sha> --project .pr-review --findings f.json --summary s.md --inline i.json
```

`local` is offline (no GitHub, no prior state): it prints `facts.md`, then the summary and inline comments publish
would post. Run it on two or three real historical diffs, one from a `checklist.md` bug class. Security detail stays
hidden unless `--show-private` (never under GitHub Actions).

## 6. Feedback and learned memory

- 👍/👎 reactions on inline comments count. Replies count only with the marker: an inline-thread reply whose first
  line starts with `review:`, or a PR comment line `review: F-1a2b3c 👎 <reason>` / `review: F-1a2b3c 👍` /
  `review: F-1a2b3c <correction>`. Quoted lines and code fences are ignored; edited comments are ignored.
- On the next push a 👎'd finding is resolved and not re-raised (unless the model gives a `reraise` reason);
  Critical and security findings are never dropped or resolved by feedback.
- Weekly (and on dispatch) the learning workflow proposes memory changes as one PR; nothing reaches the reviewer
  until Marcus merges it. Lessons never auto-merge.
- Seeding from history (corrections Marcus gave other reviewers or agents): write lessons by hand in
  `learned/lessons.json` and render them into the managed blocks:

```json
{
  "id": "L-seed-1",
  "kind": "correction",
  "status": "active",
  "target": "false-positives.md",
  "rule": "One or two sentences.",
  "scope": { "paths": ["src/x.ts"], "class": 3, "linkTypes": ["api-route"] },
  "scopeKey": "3:src/x.ts",
  "sources": [
    {
      "id": "seed:pr-12-comment-345",
      "url": "https://github.com/…",
      "pr": 12,
      "at": "2026-09-01"
    }
  ],
  "date": "2026-10-26"
}
```

## 7. Order on GitHub

The PR that adds `.pr-review/` is reviewed without it (facts finds no config at the trust SHA and skips), so:
skeleton PR → merge → secrets, variables and settings → test PR → canary PR (nested CLAUDE.md, AGENTS.md and skill
each asking the model to emit a token; assert the token is absent) → replay PRs with planted, labelled bugs on
throwaway branches → feedback round trip → trial.

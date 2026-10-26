# Wiring a repository to pr-review-kit

For the agent or person adding the advisory PR reviewer to a project. The design and its reasons are in
[design.md](design.md); this is the how-to. Start from `examples/consumer/`, which validates as shipped once
`KIT_SHA` is replaced.

## 1. What the project owns

Everything under `.claude/pr-review/`, read from the **base branch** on every run (a PR cannot change the rules
it is judged by):

| File                                                                   | Purpose                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`                                                          | Engine config (§2). Unknown keys are an error.                                                                                                                                                     |
| `REVIEW.md`                                                            | Project addendum, read after the kit's generic procedure: what the project is, how review fits it, severity calibration, high-risk paths for large PRs.                                            |
| `routing.json`                                                         | `[{ linkType, paths[], counterparts[], classes[] }]`: which paths trigger which link types and bug classes; `counterparts` drive the base-drift check. Globs: `*` one segment, `**` any depth.     |
| `checklist.md`                                                         | One `## <id>. <name>` section per configured class: what to look for, trigger paths, one or two historical PRs as evidence (or "no history yet").                                                  |
| contract map(s), `conventions.md`, `false-positives.md`                | Listed in `config.knowledge`. Every routing `linkType` needs exactly one `## <linkType>` section across these files. Patterns and counterpart paths only: never a list of weaknesses live on main. |
| `learned-lessons.md`, `learned/lessons.json`, `learned/precision.json` | Learned memory. Seed `lessons.json` as `{"version":1,"lessons":[]}` and `precision.json` as `{"version":1,"byPr":{}}`, or with corrections already found in the repo's PR history (§6).            |
| `checks/*.mjs` (optional)                                              | Project checks (§3).                                                                                                                                                                               |

Every knowledge file that a lesson may land in should end with the managed block:

```
<!-- pr-review:learned:begin -->
<!-- pr-review:learned:end -->
```

## 2. `config.json`

Minimum: `version`, `project`, `classes`. Everything else defaults to the recovery-platform reference.

| Key                                                                           | Default                                                                            | Notes                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `visibility`                                                                  | `public`                                                                           | `public` or `private`. Must match the GitHub repo.                                                                                                                                                                             |
| `securityChannel`                                                             | `advisory` (public), `none` (private)                                              | `advisory` needs a public repo. `repo-comments` (private only) shows security detail in the repo's own comments when publish verifies every collaborator is in `privateReaders`; otherwise pointer only. `none`: pointer only. |
| `privateReaders`                                                              | `[]`                                                                               | Required for `repo-comments`.                                                                                                                                                                                                  |
| `workflowPath`, `learnWorkflowPath`                                           | `.github/workflows/pr-review.yml`, `…/pr-review-learn.yml`                         | Self-edit and engine-pin facts watch these.                                                                                                                                                                                    |
| `packages`                                                                    | `[]`                                                                               | Path prefixes for grouping; longest wins; everything else is `repo`. Used in security pointers.                                                                                                                                |
| `knowledge`                                                                   | checklist, conventions, false-positives                                            | Files the model reads and lessons may target.                                                                                                                                                                                  |
| `classes`                                                                     | (required)                                                                         | `[{ id, name, security?, always?, light? }]`. `security`: forced security handling. `always`: applied on every run. `light`: applied on the light tier.                                                                        |
| `tiers.enabled`, `tiers.maxTurns`, `tiers.largeShare`                         | `true`, reference caps (full 60 … light 15), `0.5`                                 | `enabled: false` for small repos: every push with changes is a full review, no base-drift.                                                                                                                                     |
| `lightFiles`                                                                  | md/txt/images/lockfiles                                                            | Increments touching only these (and no link type) get the light tier.                                                                                                                                                          |
| `largePr`                                                                     | 60 files / 5000 lines                                                              | Told to the model.                                                                                                                                                                                                             |
| `inline`                                                                      | `{ max: 10, severities: [Critical, High] }`                                        | Which findings may get inline comments.                                                                                                                                                                                        |
| `secrets.extraPatterns`                                                       | `[]`                                                                               | Regex sources added to the kit's secret patterns (scan and redaction).                                                                                                                                                         |
| `checks.secrets / piiLogs / newFileSize / titleScope / selfEdit / verifyDiff` | on / generic fields / 300 lines / off / on / off                                   | Each can be `false`. `piiLogs: { fields, logCall }`, `newFileSize: { maxLines, pattern }`, `titleScope: { bareScopes }`, `verifyDiff: { script }` (repo-relative).                                                             |
| `checks.project`                                                              | `[]`                                                                               | Project check modules, relative to `.claude/pr-review/`.                                                                                                                                                                       |
| `trust.contextAssociations`                                                   | OWNER, MEMBER, COLLABORATOR                                                        | Whose PR description and comments reach the model.                                                                                                                                                                             |
| `trust.feedbackAuthors`                                                       | `[]`                                                                               | GitHub logins whose 👍/👎 and replies count. Empty means no feedback counts. Default for Marcus's repos: `["marcusk639"]`.                                                                                                     |
| `learning`                                                                    | window 45 days, repeat 2, max 40 lessons, demote ≥5 votes at ≤40%, distill `model` | `distill: "deterministic"` never runs a model in the learning job.                                                                                                                                                             |

## 3. Project checks

```js
// .claude/pr-review/checks/routes.mjs, listed in config.checks.project
export default [
  {
    name: "route-clients", // [A-Za-z][A-Za-z0-9-]{0,39}
    run({ files, repoRoot, baseSha, headSha, title, config, git }) {
      // files: [{ file, oldFile, status: A|M|D|R, binary, added: [{line, text}], removed: [...] }]
      // git(args): runs git in the PR-head checkout, returns stdout
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

Facts are hints the model must confirm. Notes are redacted. A check that throws or returns a non-array is reported
as "pre-check unavailable: <name>" and the review is labelled partial. Checks load only from the base checkout and
run in the facts step (which holds the workflow token, read access only in practice); use Node built-ins only.

## 4. Workflows

Copy `examples/consumer/.github/workflows/pr-review.yml` (and `pr-review-learn.yml` if learning is on) and
replace `KIT_SHA` with the kit's full commit SHA, the same in every `uses:` line. Project-specific guards (e.g.
skipping agent branches) go in the job's `if:`. Secrets:

| Secret                    | Repos                                                                                                     | Step               |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------ |
| `CLAUDE_CODE_OAUTH_TOKEN` | all                                                                                                       | review (and learn) |
| `PR_REVIEW_ID_KEY`        | public (`advisory`)                                                                                       | publish            |
| `SECURITY_ADVISORY_TOKEN` | public (`advisory`): fine-grained PAT, "Repository security advisories: read and write" on this repo only | publish            |

Private repos omit the last two lines of the publish step. The learning workflow also needs Settings → Actions →
General → "Allow GitHub Actions to create and approve pull requests".

## 5. Check it locally

From the consumer repo root:

```sh
KIT=~/dev/pr-review-kit
node $KIT/bin/pr-review.mjs validate
# facts + dry-run publish on a historical diff, with a draft of the project not yet committed:
node $KIT/bin/pr-review.mjs local --base <sha>^ --head <sha> --project .claude/pr-review
# render a hand-written findings file the way publish would post it:
node $KIT/bin/pr-review.mjs local --base <sha>^ --head <sha> --project .claude/pr-review --findings f.json --summary s.md --inline i.json
```

`local` is offline (no GitHub calls, no prior state) and prints `facts.md`, then the summary comment and inline
comments publish would post. Security detail stays hidden unless `--show-private` (never under GitHub Actions);
`--assume-private-verified` previews a verified private channel. Pick two or three real historical diffs,
including one from a bug class in `checklist.md`, and confirm the link types fire and the knowledge points at the
other side.

## 6. Feedback and learned memory

- Inline comments (Critical/High by default) take 👍/👎 reactions and replies. Every non-security finding also
  shows a handle `F-xxxxxx` in the summary; a trusted maintainer replies in a PR comment with
  `F-xxxxxx 👎 <reason>`, `F-xxxxxx 👍` or `F-xxxxxx <correction>`.
- On the next push, a 👎'd finding is resolved and not re-raised (unless the model gives a `reraise` reason;
  Critical and security findings are never dropped), and corrections reach the model as quoted data.
- Weekly, the learning workflow proposes memory changes as one PR. Nothing reaches the reviewer until it is merged.
- Seeding: corrections Marcus already gave reviewers or agents in the repo's history (not addressed to this bot)
  are written by hand into `learned/lessons.json` with the same shape the pipeline produces, and rendered into the
  managed blocks:

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

## 7. Order on GitHub (summary; the runbook has the per-repo detail)

The engine and knowledge must be on the default branch before they review anything: the PR that adds
`.claude/pr-review/` is reviewed without it (facts sees no config on base and skips). So: skeleton PR → merge →
secrets and settings → test PR → replay PRs with planted, clearly labelled bugs on throwaway branches → feedback
round trip → trial.

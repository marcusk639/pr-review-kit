# pr-review-kit

A shared engine for a repo-aware, **advisory** PR reviewer built on `anthropics/claude-code-action@v1`. It reads
each pull request with the consuming repository's own knowledge of how its pieces fit together, and posts one
summary comment plus a few inline comments. It never approves, requests changes or blocks a merge.

Extracted from `marcusk639/recovery-platform`. The kit holds everything that is the same in every repository;
each consumer keeps what is specific to it (bug classes, routing, conventions, project checks, learned memory)
under a root `.pr-review/` directory.

## How it works, in one minute

```
PR opened / pushed
  -> review action   checkout the base SHA, restore .pr-review/ from it, neutralize the PR head,
                     compute facts (diff, tier, hygiene and project checks; no token),
                     run Claude read-only (no shell, no network, no posting tool) -> 3 files
  -> publish action  model-free, the only step with secrets: validate the model's files, post inline
                     comments, deliver security findings privately, upsert the one summary comment

Weekly
  -> learn action    collect maintainers' 👍/👎 and "review:" replies, turn them into gated lessons
  -> propose action  open ONE learning PR that a human merges, edits or closes
```

Key properties:

- **A PR cannot change how it is reviewed.** Config, knowledge and checks come from the PR's base commit.
- **The model never posts and never sees a secret.** Model-free code decides what is published.
- **Security findings stay private.** Public comments carry a pointer only; the detail goes to a draft security
  advisory (public repos) or an owner-only private inbox repo (private repos).
- **Incremental.** Each push gets a tier (`none`, `light`, `base-drift`, `incremental`, `incremental-new-links`,
  `full`) sized to what changed since the last review.
- **It learns, under review.** Feedback becomes memory only through a learning PR you merge.
- **Opt-in extras, off by default.** One-click suggestions and Medium inline comments, `gh pr view/diff` and one
  checked reply for the model, isolated Serena code navigation, and base-branch reference copies of `CLAUDE.md`
  files ([how-it-works 5.4](docs/how-it-works.md#54-opt-in-capabilities)). recovery-platform uses all of them.

## Documentation

| Document                                         | Read it for                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| [docs/how-it-works.md](docs/how-it-works.md)     | The full explanation: pipeline, security model, learning loop, config, and an index of every `.mjs` file |
| [docs/consumer-guide.md](docs/consumer-guide.md) | Wiring a new repository, starting from `examples/consumer/`                                              |
| [docs/runbook.md](docs/runbook.md)               | The GitHub-side steps: enabling repos, secrets and settings, acceptance checks, rollback                 |
| [docs/design.md](docs/design.md)                 | Design decisions and why                                                                                 |
| [docs/github-tokens.md](docs/github-tokens.md)   | Which GitHub token to use in any workflow (best practice)                                                |

## Quick start for a new consumer

1. Copy `examples/consumer/.pr-review/` and `examples/consumer/.github/workflows/` into the repository and tailor
   `.pr-review/` to it (classes, routing, knowledge, checks). See the consumer guide.
2. Replace `KIT_SHA` in both workflows with this repository's full 40-character commit SHA.
3. From the consumer's root, check the wiring:
   ```sh
   node ~/dev/pr-review-kit/bin/pr-review.mjs validate
   node ~/dev/pr-review-kit/bin/pr-review.mjs local --base <sha> --head <sha>   # dry run, posts nothing
   ```
4. Set secrets, variables and repository settings. `bin/enable-repo.mjs` does it with `gh` (dry run unless
   `--apply`):
   ```sh
   node bin/enable-repo.mjs --repo owner/name            # preview
   node bin/enable-repo.mjs --repo owner/name --apply    # do it
   ```
5. Merge the setup PR. Reviews start on the **next** PR, because the project is read from the base branch.

## Layout

| Path                                | What                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `actions/review`, `actions/publish` | Composite actions for the PR workflow: facts plus sandboxed model; model-free publish with secrets |
| `actions/learn`, `actions/propose`  | Composite actions for the learning workflow: collect/distill/apply; open the learning PR           |
| `engine/`                           | Pipeline stages: `neutralize`, `facts`, `externals`, `publish`, `advisories`, `validate`           |
| `engine/REVIEW.md`, `DISTILL.md`    | The procedures the review and distill models follow                                                |
| `engine/learn/`                     | The learning pipeline                                                                              |
| `engine/lib/`                       | Shared libraries (config, git, checks, ledger, redaction, posting, private delivery)               |
| `engine/enable/`                    | Pure logic behind `bin/enable-repo.mjs`                                                            |
| `engine/test/`                      | Tests                                                                                              |
| `bin/pr-review.mjs`                 | Consumer CLI: `validate`, `local`, `learn`                                                         |
| `bin/enable-repo.mjs`               | Enables a consumer repository on GitHub, step by step                                              |
| `examples/consumer/`                | A complete minimal consumer: workflows, config, knowledge, a project check                         |

Node 22 built-ins only; nothing is installed at runtime.

## Updating consumers

Consumers pin a commit, so a change here reaches nobody until their pin moves. To roll out a change, update the
SHA in every kit `uses:` line of a consumer's workflows (both must match), run `validate`, and open a PR. That PR
edits the reviewer, so it is reviewed with a High self-edit fact and the PR's own pin is used for that run.

## Tests

```sh
npm test
```

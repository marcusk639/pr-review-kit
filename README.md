# pr-review-kit

The shared engine for a repo-aware, advisory PR reviewer on `anthropics/claude-code-action@v1`, extracted from
`marcusk639/recovery-platform`. It comments, never approves or blocks. Each consuming repository keeps its own
knowledge, config and checks under `.claude/pr-review/`; the kit holds everything that is the same everywhere.

- **Design and decisions:** [docs/design.md](docs/design.md)
- **Wiring a repository:** [docs/consumer-guide.md](docs/consumer-guide.md), starting from `examples/consumer/`

## Layout

| Path                                | What                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `actions/review`, `actions/publish` | Composite actions for the PR workflow: facts plus sandboxed model; model-free publish with secrets |
| `actions/learn`, `actions/propose`  | Composite actions for the learning workflow: collect/distill/apply; open the learning PR           |
| `engine/`                           | Facts, publish, learning pipeline (`learn/`), libraries (`lib/`), procedures, tests                |
| `bin/pr-review.mjs`                 | `validate` and `local` (facts plus dry-run publish) for consumers                                  |
| `examples/consumer/`                | A complete minimal consumer: workflows, config, knowledge, a project check                         |
| `examples/recovery-platform/`       | recovery-platform's contract checks as project checks, and a config reproducing the reference      |

Node 22 built-ins only; nothing is installed at runtime.

## Tests

```sh
npm test
```

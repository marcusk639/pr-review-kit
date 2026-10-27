# GitHub tokens in workflows: which to use

Best-practice guidance for any workflow in Marcus's repositories, not only the PR reviewer. Written 2026-10-26,
after a bulk `GITHUB_TOKEN` → `GH_TOKEN` rename showed that the token's _source_ matters far more than the name
it is stored under.

## The rule in one line

Use `${{ github.token }}` unless you need something it cannot do; when you do, prefer a GitHub App token over a
personal access token (PAT).

## The three sources

| Source                      | How you reference it                                                                                                       | Lifetime and scope                                                                                                             | Use it when                                                                                                     | Watch out for                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Built-in workflow token** | `${{ github.token }}` (identical to `${{ secrets.GITHUB_TOKEN }}`; prefer the first, it is not a secret expression)        | Minted per job, expires when the job ends, limited to this repository and to the job's `permissions:` block.                   | Anything inside the same repository: commenting, reading PRs and checks, looking up a PR head, posting reviews. | Events it creates (PRs, pushes, comments) **do not trigger other workflows**, so a PR it opens gets no CI. It cannot reach other repositories.                                         |
| **GitHub App token**        | `actions/create-github-app-token` with `APP_ID` (variable) and the App private key (secret); use the step's `token` output | Expires within about an hour; limited to the App's permissions and the repositories it is installed on; not tied to a person.  | Cross-repository access, or when what the workflow creates must trigger workflows (e.g. CI on a bot-opened PR). | One-time setup (create the App, install it, store two values). The private key is long-lived: keep it in a secret, rotate if exposed.                                                  |
| **Personal access token**   | `${{ secrets.GH_TOKEN }}` (or another user-defined secret) holding a PAT                                                   | Lives until it expires or is revoked; acts as **you**, with everything your account can reach (fine-grained PATs narrow this). | Only when an App will not do and the job needs it now.                                                          | The broadest blast radius of the three if it leaks. Use a **fine-grained** PAT, limited to the specific repositories and permissions, with an expiry date. Rotate it on any suspicion. |

`id-token: write` (OIDC) is a fourth mechanism, but not a GitHub API token you set yourself: actions use it to
obtain their own credentials (claude-code-action exchanges it for its GitHub App token). Grant it only to jobs
whose actions need it.

## Variable and input names

The name a token is stored under is cosmetic; pick what the consumer reads.

- The `gh` CLI reads `GH_TOKEN` first and falls back to `GITHUB_TOKEN`; either works.
- Most actions take a `github_token` or `github-token` input rather than reading an environment variable.
- Scripts (Octokit, `curl`) read whatever variable you choose; name it after its purpose.

Accepted conventions in these repositories (Marcus, 2026-10-26): environment variable names stay `GITHUB_TOKEN`
(or `GH_TOKEN` where a step already used it for `gh`), and secret references may be `${{ github.token }}` or
`${{ secrets.GH_TOKEN }}`.

## Placement rules

- Set a token on the **step** that needs it, not in job- or workflow-level `env:`, where every step (including
  ones that run PR-controlled code, or a model) can read it. The PR reviewer's `validate` enforces this for
  `secrets.GITHUB_TOKEN` and `secrets.GH_TOKEN`.
- Give each job the narrowest `permissions:` block that works; the built-in token gets exactly those.
- Never `echo` a token or interpolate it into a `run:` line; pass it through `env:` and let the tool read it.
- `actions/checkout` with `persist-credentials: false` unless a later step must push.

## Moving off a PAT

Where a repository holds a PAT as `GH_TOKEN` today:

1. List what each use actually needs. Most same-repository uses (PR lookups, comments) can switch to
   `${{ github.token }}` with the right `permissions:`.
2. For the rest, create one GitHub App (owned by Marcus, installed only on the repositories that need it, with
   only the permissions those uses need), store `APP_ID` as a repository variable and the private key as a secret,
   and mint a token per job with `actions/create-github-app-token` (pin it by full SHA).
3. Delete the PAT secret, then revoke the PAT itself.

## Known consumers of this guidance

- `recovery-platform` `.github/workflows/claude.yml` uses `secrets.GH_TOKEN` (a PAT) for its PR-head lookup
  (#130); `${{ github.token }}` would do for that lookup.
- The PR reviewer's learning PRs are opened with the built-in token, so they get no CI; an App token in the propose
  job would fix that without a PAT. Not adopted yet: the verifier rejected CI-with-secrets on the learning branch,
  so any change there must keep secrets away from learning-branch code.

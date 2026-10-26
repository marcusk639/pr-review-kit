# Practised conventions

What the code actually does, so a PR that departs from it needs a reason. The repo's `CLAUDE.md` (or
`AGENTS.md`) is the source of truth; this file records only what it leaves out and where docs and code disagree.

- Route strings live in one place (`src/api.ts`); clients import them rather than repeating literals.

<!-- pr-review:learned:begin -->
<!-- pr-review:learned:end -->

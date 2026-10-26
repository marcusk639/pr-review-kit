# Bug-class checklist

The recurring classes, mined from this repo's merged PRs and fix commits. `routing.json` decides which classes a
run applies; classes marked `always` in `config.json` always apply. Evidence entries are history to learn from, not
open issues. Finding `class` numbers in `findings.json` use the numbers below.

## 1. Caller-supplied ids trusted for authorisation

- **Look for:** a handler that takes a user or tenant id from the request body and uses it to decide access.
- **Trigger paths:** `src/api.ts`.
- **Evidence:** no history yet.

## 2. API route or payload drift between server and client

- **Look for:** a route path or payload key renamed on one side only.
- **Trigger paths:** `src/api.ts`, `web/client.ts`.
- **Evidence:** no history yet.

## 3. Silent failure reported as success

- **Look for:** errors swallowed to an empty result.
- **Evidence:** no history yet.

## 4. Tests that cannot fail

- **Look for:** mocks that hide a revert; assertions on the mock.
- **Evidence:** no history yet.

## 5. Secrets, PII or config mistakes

- **Look for:** committed secrets, PII in logs, production config pointed at test resources.
- **Evidence:** no history yet.

## 6. PR text that claims what the code does not do

- **Look for:** a PR description or title that promises behaviour the diff does not implement.
- **Evidence:** no history yet.

<!-- pr-review:learned:begin -->
<!-- pr-review:learned:end -->

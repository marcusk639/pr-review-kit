# Contract map

"If X changes, check Y", per link type, both directions. Each `## <linkType>` heading matches one `routing.json`
entry and appears in exactly one knowledge file. The map is guidance: confirm every link by reading both sides.

## api-route

- Route strings in `src/api.ts` ↔ the `fetch` paths in `web/client.ts`. A rename on one side returns 404 on the other.

## client

- Calls in `web/client.ts` ↔ the routes they target in `src/api.ts`.

## tests

- A changed test ↔ the code it covers; check it would fail if the change were reverted.

## review-config

- `.pr-review/**` and `.github/workflows/pr-review*.yml` ↔ the reviewer itself (self-edit).

<!-- pr-review:learned:begin -->
<!-- pr-review:learned:end -->

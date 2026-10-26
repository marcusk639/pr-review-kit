<!-- pr-review:summary -->

## PR review (advisory)

Reviewed `5c73c6f` (full): 1 reported this run (1 Low); 4 still open from earlier reviews (2 Medium, 2 Low).

Tier: `full`; unavailable pre-checks: none.

_Advisory only: not a required check. Security-relevant findings show only a pointer here._

### Low

- Security-relevant issue (Low) in regroup/mobile offline sync; details sent privately

### Still open from earlier reviews

- Security-relevant issue (Medium) reported earlier; details sent privately
- **(withheld: touches a security-relevant file)** (Low, from an earlier review)
- Security-relevant issue (Medium) reported earlier; details sent privately
- **(withheld: touches a security-relevant file)** (Low, from an earlier review)

## Features touched

- App launch on Android release builds and on iOS builds from the iOS 27 SDK (all regroup mobile users).
- iOS deep links: custom-scheme and universal links, on cold start and while the app is running (invites, redirects).
- Offline activity logging queue: persistence, reconnect sync, sign-out and account-deletion cleanup.

## Cross-package impact

| Link | Other side | Status |
| --- | --- | --- |
| deep-link: iOS cold-start URL rebuilt into launch options (`AppDelegate.mm`) | `Linking.getInitialURL()` in `regroup/mobile/src/services/native-deep-links.ts:48` | ok |
| deep-link: `scene:openURLContexts:` / `continueUserActivity` forwarded to `RCTLinkingManager` | `Linking.addEventListener('url', …)` in `native-deep-links.ts:77` | ok |
| deep-link: `UIApplicationSceneManifest` in `regroup/mobile/ios/rats/Info.plist` | `SceneDelegate` declared in `AppDelegate.h` and implemented in `AppDelegate.mm` | ok (key sits in the root dict; the class name matches) |
| tests: global AsyncStorage/NetInfo mocks in `jest.setup.js` | Per-file overrides in `offlineQueue.test.ts` and `useOfflineSync.test.ts` | ok |
| Sign-out paths | Every UI sign-out dispatches the `userSlice` logout, which calls `users.signOut` (`userSlice.ts:127`). Account deletion clears the queue in `account.ts`. `EnhancedAuthService.signOut` has no callers | ok |

## Checked and fine

- **deep-link (class 11):** the universal-link launch-options dictionary uses the `UIApplicationLaunchOptionsUserActivityKey` literal that RN 0.72's `RCTLinkingManager` reads. When a scene reconnects and the bridge is already alive, the connection-options URLs are forwarded. The scheme registration is unchanged.
- **Android:** `org.jetbrains.kotlin.android` resolves, because `kotlin-gradle-plugin:$kotlinVersion` is already on the buildscript classpath (`regroup/mobile/android/build.gradle:100`).
- **Offline queue:** `loggedBy` is documented as the user id (`activity.ts:66`), so filtering by uid is coherent. The final save of a flush re-reads under the lock and never re-adds cleared ids. The NetInfo gate ignores events where reachability is still undecided.
- **Class 10:** the new tests would fail with the fixes reverted: the concurrency suite uses a stateful fake store, and the timeout test uses fake timers. No tests were deleted or skipped, no `.only` was added, and no snapshots changed.
- **Class 13:** the scoping, the 5 s cap, the account-deletion clear, the Jest mocks and the removal of the fallback branch all match the PR description.
- **Class 14:** no cross-product imports or project IDs.
- **Class 8:** the new log calls contain only fixed strings and queue ids.

## Not reviewed / limits

- Tier: `full`.
- I can't verify the device-level claims (release launches on Android 34 and iOS 27, Maestro deep-link runs) or Apple domain verification for universal links.
- Not verified: whether UIKit connects a scene for background launches (silent push, background fetch). React Native now starts only when a scene connects. No server payload in the repo sets `content-available`, so I found no current path that depends on this.
- I didn't recheck the `Podfile.lock` checksums or the `RNPermissions` checksum change against the installed pods.

## Noticed nearby

- `regroup/mobile/ios/rats/Info.plist:149` declares `com.apple.developer.associated-domains` in Info.plist. iOS reads that key from the entitlements file, not Info.plist.

## Map maintenance

- `deep-link` / regroup: add `regroup/mobile/ios/rats/AppDelegate.mm` (`SceneDelegate` URL and user-activity forwarding) as the native handoff into `native-deep-links.ts`.

(some narrative withheld: security)

<!-- pr-review:ledger v1 eyJsYXN0UmV2aWV3ZWRTaGEiOiI1YzczYzZmZTkwYmFlZDE1NDg0YzU5OTY2YjU0ZmJhMDBjOTA4MGI4IiwibGFzdEJhc2VTaGEiOiI1MDNlOGMyZDg3ZDIyOGU4MWY3ZTFhMzcyZDNmYzNkMWNkYjhjZmNkIiwibGlua1R5cGVzU2VlbiI6WyJ0ZXN0cyIsImRlZXAtbGluayJdLCJsZWRnZXIiOlt7ImlkIjoiYmE1MDYwYThlMzNkZmNjNSIsInNldmVyaXR5IjoiTWVkaXVtIiwic3RhdHVzIjoib3BlbiIsInNlY3VyaXR5Ijp0cnVlLCJydW5zU2luY2VSZXNvbHZlZCI6MCwiZmlsZUlkcyI6WyIxMDhkZDFhZjA1ZWJlZmJmIiwiYTIzYTZkZTdjZjY2MTNlNCIsIjYwZmRkM2I3MTZiNTVjZGIiLCIzNTE1ODAzYTk2Njg3NjJhIl19LHsiaWQiOiI1ZDczMmU5ZTkyNTI0NDc1Iiwic2V2ZXJpdHkiOiJMb3ciLCJzdGF0dXMiOiJvcGVuIiwic2VjdXJpdHkiOmZhbHNlLCJydW5zU2luY2VSZXNvbHZlZCI6MCwid2l0aGhlbGQiOnRydWV9LHsiaWQiOiJmYTY1NTlmYTA4OTQ2Y2RlIiwic2V2ZXJpdHkiOiJNZWRpdW0iLCJzdGF0dXMiOiJvcGVuIiwic2VjdXJpdHkiOnRydWUsInJ1bnNTaW5jZVJlc29sdmVkIjowLCJmaWxlSWRzIjpbImMwNmE5YjQxZTdjMWRjZmEiLCJjZjc1OWM3YTAyYTBhMzY4Il19LHsiaWQiOiI2N2NiNjUwYzJmMDliOWViIiwic2V2ZXJpdHkiOiJMb3ciLCJzdGF0dXMiOiJvcGVuIiwic2VjdXJpdHkiOmZhbHNlLCJydW5zU2luY2VSZXNvbHZlZCI6MCwid2l0aGhlbGQiOnRydWV9LHsiaWQiOiI3Y2NlYWZiNDE3NDVlNWZiIiwic2V2ZXJpdHkiOiJMb3ciLCJzdGF0dXMiOiJvcGVuIiwic2VjdXJpdHkiOnRydWUsInJ1bnNTaW5jZVJlc29sdmVkIjowLCJmaWxlSWRzIjpbImNmNzU5YzdhMDJhMGEzNjgiLCJjMDZhOWI0MWU3YzFkY2ZhIl19XX0= -->

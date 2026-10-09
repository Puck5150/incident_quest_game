## What goes live

<!-- One or two sentences a player would notice. "Nothing visible" is a valid answer for engine-only changes. -->

## Why

## Checks

- [ ] `npm run lint`, `npm test`, `npm run build` pass locally
- [ ] Scenario files changed: `npm run schemas` leaves no diff
- [ ] New or changed incidents are playable end to end (ideal path and traps)
- [ ] Unverified wording or sources are logged in `CONTENT_TODO.md`
- [ ] New incidents that are not ready for players have `published: false`

## Rollback

<!-- Default: revert this PR. Note anything that makes that unsafe (data, schema changes). -->

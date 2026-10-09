# Releasing

`main` is production. Every merge to `main` runs CI and, if it passes,
deploys to GitHub Pages (https://puck5150.github.io/incident_quest_game/).
Nothing reaches `main` except through a pull request, so a merge is the
release decision. Keep PRs small enough that you would be happy to see each one
live on its own.

## Branches

- `main` only holds work that is safe to ship.
- Work happens on short-lived branches cut from `main`, named for the change:
  `feat/...`, `fix/...`, `content/...`, `docs/...`, `chore/...`, `test/...`.
- A long piece of work is a chain of small PRs (a stack), each based on the
  previous one. Merge them in order; GitHub retargets the next PR to `main` when
  its parent merges and the branch is deleted.
- Delete branches after merge (the repo does this automatically).

## Commits

- Conventional prefix: `feat:`, `fix:`, `content:`, `docs:`, `test:`, `refactor:`,
  `chore:`. Say what changed and why in the body when it is not obvious.
- One logical change per commit. Tests and docs for a change go in the same
  commit.
- AI-assisted commits keep their `Co-Authored-By:` trailer.
- Never force-push `main`. Do not rewrite history that others branch from.

## Pull requests

1. Push the branch and open a PR to `main`; fill in the template (what goes
   live, why, checks, rollback).
2. CI (`build`: lint, tests, build, smoke test) must pass and the branch must be
   up to date with `main`.
3. Merge with a **merge commit** (not squash or rebase). That keeps commit ids
   stable, which is what lets stacked PRs merge cleanly.
4. After the merge, watch the CI run: the `deploy` job publishes the site and
   checks that it answers.

## Going live gradually

- Ship in slices: engine changes first, then the content that uses them.
- A scenario can be merged without being offered to players by setting
  `published: false` at its top level. It still validates and its tests still run;
  players do not see it (board, sector counts, map, shifts, direct links). Check it
  on the live site with `?preview=1`, where it shows with an "Unpublished" marker.
  Flip it to `true` (or remove the line) in a small PR when you want it live. See
  "Shipping dark" in AUTHORING.md.
- Prefer many small merges over one big one. If a slice is risky, hide it behind
  `published: false` first.

## Tags and releases

- After a verified deploy of something players will notice, tag `main`:
  `git tag -a v0.N -m "Short summary" && git push origin v0.N`, and create a
  GitHub release with notes (what is new, anything known to be unverified from
  `CONTENT_TODO.md`).
- Tags are the rollback points.

## Rollback

- Fast: Actions → **Rollback** → Run workflow → enter the last good tag (for
  example `v0.3`). It rebuilds and redeploys that tag without touching `main`.
- Then fix `main`: revert the bad change with a PR (`git revert <merge commit>`)
  so the next deploy does not bring it back.
- The deployed site is static, so there is no data to restore.

## Repository settings this process relies on

- Branch protection on `main`: pull request required (no approvals needed for
  a solo maintainer), status check `build` required and up to date, rules also
  apply to admins, force-push and deletion blocked, conversations resolved.
- Merge method: merge commits only; automatically delete head branches.

# Releasing

UI Studio uses [Semantic Versioning](https://semver.org). The installed version is in `VERSION`; releases are git tags (`v1.2.3`) with a GitHub release each.

- **Patch** (1.0.x): fixes that change nothing the user or the agent relies on.
- **Minor** (1.x.0): new features, and changes to the agent protocol that older instructions still work with.
- **Major** (x.0.0): changes that break existing sessions, CLI commands or the agent protocol.

## Cutting a release

1. As you work, add user-facing notes under `## Unreleased` in `CHANGELOG.md`.
2. On an up-to-date, clean `main`, run:

   ```sh
   bun scripts/release.ts patch    # or minor, major, or an exact X.Y.Z
   ```

   It moves the notes under the new version, writes `VERSION`, commits `Release X.Y.Z`, tags `vX.Y.Z`, pushes `main` with the tag and publishes the GitHub release with the same notes (needs `gh`).

## How users get it

`ui-studio start` checks the latest GitHub release at most once a day (2 s timeout, `UI_STUDIO_NO_UPDATE_CHECK=1` turns it off). When a newer one is out, the studio window shows "Update X.Y.Z" and Claude mentions it once. When the user asks, Claude runs `ui-studio update`, which checks out the newest release tag and prints what changed.

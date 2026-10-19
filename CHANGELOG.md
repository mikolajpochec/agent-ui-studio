# Changelog

Notable changes to UI Studio. Versions follow [Semantic Versioning](https://semver.org); see [RELEASING.md](RELEASING.md).

## Unreleased

## 1.0.3 (2026-10-19)

- While the preview can't show the design (dev server down, page broken mid-edit, reloading), the last working design stays up: shrunk, greyed out, with a big loading indicator.

## 1.0.2 (2026-10-19)

- Questions come with clickable answers in the chat (`uis ask`), so you never have to type a reply. Choices between looks are shown as variants instead.
- Claude keeps studio messages to one to three short lines.

## 1.0.1 (2026-10-19)

- Fixed: the update check no longer breaks `ui-studio list` (its cache moved to `~/.cache/ui-studio`).
- Fixed: the update check waits up to 3 s, so a slow first connection to GitHub doesn't miss a release.

## 1.0.0 (2026-10-19)

First release.

- The studio window: your real component isolated on its own workbench, live tiles for every UX state, a chat with attachments, live status and suggestion cards that follow the work, fullscreen.
- Steer while Claude works: steering prompts and suggestion cards change the current step; new requests queue and can be removed.
- Live variants in a grid (rows and columns from 4 variants), side by side or a slider. Picking one shows it at once while Claude makes it the real code.
- Before / after slider built by the studio: every checkpoint and the original are frozen, so it opens instantly against the last checkpoint or any other one.
- Checkpoints you can restore.
- Finish (or closing the window) ends the session, removes everything studio-specific and summarizes the work in Claude Code.
- Update notice when a newer release is out, and `ui-studio update`.


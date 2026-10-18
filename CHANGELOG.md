# Changelog

Notable changes to UI Studio. Versions follow [Semantic Versioning](https://semver.org); see [RELEASING.md](RELEASING.md).

## Unreleased

## 1.0.0 (2026-10-19)

First release.

- The studio window: your real component isolated on its own workbench, live tiles for every UX state, a chat with attachments, live status and suggestion cards that follow the work, fullscreen.
- Steer while Claude works: steering prompts and suggestion cards change the current step; new requests queue and can be removed.
- Live variants in a grid (rows and columns from 4 variants), side by side or a slider. Picking one shows it at once while Claude makes it the real code.
- Before / after slider built by the studio: every checkpoint and the original are frozen, so it opens instantly against the last checkpoint or any other one.
- Checkpoints you can restore.
- Finish (or closing the window) ends the session, removes everything studio-specific and summarizes the work in Claude Code.
- Update notice when a newer release is out, and `ui-studio update`.


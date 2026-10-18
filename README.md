# UI Studio

A [Claude Code](https://claude.com/claude-code) skill for designing UI live. Point it at a button, a card, a section or a whole page, and it opens a design studio in its own window: your real component running in isolation, every UX state next to it, a chat to steer the redesign, and suggestion cards that follow what Claude is working on. Claude edits the actual code in the background while you watch the preview change.

![UI Studio redesigning a pricing card](docs/studio.png)

## What you get

- **Your real component, live.** Running in isolation on your dev server, not a mockup.
- **Every UX state** as live tiles next to it.
- **Steer while it works:** chat, live status and suggestion cards.
- **Live variants** side by side, plus a before/after slider.
- **Checkpoints and fullscreen.**

## Install

Tell Claude Code:

> Install the UI Studio skill from https://github.com/mikolajpochec/claude-ui-studio

It sets everything up (asking before it installs [Bun](https://bun.sh), if you don't have it) and tells you when it's ready. Later, ask it to update the skill the same way.

The studio opens in a Chromium-based browser window (Chrome, Brave, Edge, Chromium or Vivaldi) and runs on macOS and Linux.

## Use

Start it with the slash command and say what to work on:

```
/ui-studio the Pro pricing card
```

or just ask in plain words, for example "let's redesign the settings save button in the studio". Claude finds the component, decides how to preview it, opens the studio window and starts listening. From then on you talk to it in the studio. Click **Finish** (or close the window) when you're done: the studio closes, Claude removes everything studio-specific, and your main session gets a summary of what changed.

What it can preview:

| Project | Preview |
|---|---|
| Web apps with a dev server (Vite, Next, Nuxt, SvelteKit, Astro, Remix, Angular, Rails, Django, Laravel, Phoenix…) | Live, through your dev server |
| Components with Storybook stories | Live, the story |
| Plain HTML and CSS | Live, served from disk with reload on save |
| React Native with web support | Live, the web rendering |
| Native iOS, Android, Flutter | Device screenshots after each change (the only non-live mode) |

## How it works

- `ui-studio start` launches a small Bun server for the session. It serves the studio UI and a reverse proxy in front of your dev server (with hot reload passing through) that injects a helper script into the page. The helper isolates the element, forces states like `:hover` and `:focus`, and reports render errors.
- Claude works as a background agent that long-polls the studio for your messages and drives it through the `ui-studio` CLI: status, suggestions, chat, checkpoints, compare, states.
- Before a preview is shown, the target is render-checked in every state, so a broken page, a 404 or a half-built workbench never reaches you.
- Everything runs locally and binds to `127.0.0.1` only. Session history and checkpoints are stored in `~/.ui-studio/`.

## Layout

```
SKILL.md                    what Claude reads first: picking the target and preview mode, starting the studio
references/agent-loop.md    the background agent's loop, events, workbench and states recipes
scripts/ui-studio           CLI entry point (scripts/cli.ts)
scripts/server.ts           studio server, proxy and agent API
ui/                         the studio UI and the script injected into previews
docs/                       README images
```

## For agents

If a user asks you to install this skill:

1. Check that Bun is available: `bun --version`. If it is missing, ask the user before installing it (`brew install oven-sh/bun/bun` on macOS, or `curl -fsSL https://bun.sh/install | bash`).
2. Clone the repository into the user's personal skills directory, `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/ui-studio`, unless the user wants it only for the current project; then use `<project root>/.claude/skills/ui-studio`. If the directory already exists, `git pull` inside it instead.
3. Verify: `<skill dir>/scripts/ui-studio --help` prints the command list.
4. Tell the user it's installed and that they can start with `/ui-studio <what to redesign>`. If `/ui-studio` does not show up yet, a restart of Claude Code loads it.

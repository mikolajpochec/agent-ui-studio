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

> Install the UI Studio skill from https://github.com/mikolajpochec/agent-ui-studio

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

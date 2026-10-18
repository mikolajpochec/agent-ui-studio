---
name: ui-studio
description: Interactive UI/UX design studio. Opens a standalone app window with a live, interactive preview of one part of the UI (a button, a section, a whole page) mounted on its own minimal workbench, live tiles for its UX states (hover, focus, pressed, disabled, loading…), a scoped chat with attachments, live "working on…" status, context-aware suggestion cards, fullscreen mode with a floating prompt, and a compare mode (variant grid, side by side, before/after slider) where every variant is the real running code. A background fork of this session does the redesign and listens to the studio. Use when the user wants to rework, redesign, restyle, polish or iterate on part of an interface visually, wants to see design options or a before/after, or says "design studio", "UI studio", "let's design this".
---

# UI Studio

Each rework gets its own studio: a local server, a standalone app window and a background **fork** of this conversation (so it has the full context of the main thread). The user steers in the studio; the fork edits the real code and streams what it is doing. The main thread stays free.

What the user sees for the target:
- **Only the element.** By default the preview is isolated: just the element, cropped to its bounds, on a dotted workbench whose tone contrasts with it. An element without its own background shows only the color it normally sits on.
- **Only the logic it needs.** The fork mounts the element on a small **workbench** page (the real component, only the providers, props, mock data and handlers it needs), served by the project's own dev server. The full app page is used only when the element cannot be mounted alone.
- **Its UX, every time.** Live tiles show every state (hover, focus, pressed, plus prop states like disabled, loading, error) next to the interactive main preview. Declaring the states is obligatory; the only exception is an element that truly has a single state.

`SKILL_DIR` below means the base directory of this skill (shown when the skill loaded). The CLI is `SKILL_DIR/scripts/ui-studio` (needs `bun`).

## 1. Pin down the target

From the request and the code, determine:

- **What**: the element, section or page, and the source files that render it (component, styles, tokens).
- **Route**: the URL path where it is visible (`/settings`, `/`, a Storybook story URL).
- **Selector**: a CSS selector that matches it uniquely on that page. This is the starting view; the fork then switches to the workbench. Prefer an existing stable hook (`#id`, `[data-testid]`, `[aria-label]`, a unique class). If none exists, add `data-ui-studio="<name>"` to the element; the fork removes it before finishing. For a whole page, the selector is optional and the scope is `page`.
- **Direction**: whatever the user already said about where it should go. It is fine if they said nothing.
- **Title**: a short, specific name that tells this rework apart from others, as `Area · Element` (for example "Settings · Save button", "Pricing · Hero", "Checkout page"). It names the window, the session (starting again with the same title resumes it), the fork's task and its color.

Do not ask the user for things you can find in the code. Ask only if the target itself is ambiguous (for example two "save buttons" on different pages).

## 2. Pick the preview mode (decide, don't ask)

The preview must be the real app: real HTML, CSS and JS, interactive. Pick the most faithful option that works:

| Project | Mode | How |
|---|---|---|
| Web app with a dev server (Vite, Next, Nuxt, SvelteKit, Astro, Remix, Angular, CRA, Rails/Django/Laravel/Phoenix) | `app` | Reuse a running dev server if there is one (check listening ports with `lsof -iTCP -sTCP:LISTEN -P -n`, confirm with `curl -sI`); otherwise start it with `run_in_background`. Add `--watch` when the server has no hot reload (server-rendered templates). |
| A single component that already has Storybook stories | `app` against Storybook | `--upstream http://localhost:6006 --route "/iframe.html?id=<story-id>&viewMode=story"`, scope `page` or `element`. Best isolation; use only if Storybook is already set up. |
| Plain HTML/CSS, no build step | `static` | `--root <dir containing the html>`; reloads on save. |
| Electron | `app` | Point `--upstream` at the renderer dev server. If the renderer is not served over http, use `frames`. |
| React Native / Expo with working web support (`react-native-web` installed) and a target that is not native-only | `app` against the web build | Real interactive preview in the browser. Tell the user it is the web rendering of their RN UI. |
| Native iOS/Android, Flutter, RN without web, other native UI | `frames` | The UI cannot run in a browser, so the fork pushes device screenshots after each change (argent tools if available, otherwise `xcrun simctl io booted screenshot` / `adb exec-out screencap -p`). This is the only mode that shows images instead of the live app. |

## 3. Start the studio

```bash
SKILL_DIR/scripts/ui-studio start --project <repo root> --title "Save button" \
  --mode app --upstream http://localhost:5173 --route /settings \
  --selector '[data-testid="save"]' --brief "<user's direction, if any>"
```

It opens the studio as a standalone app window (Chromium `--app` mode: no address bar, tabs or back/forward buttons; it falls back to the default browser only when no Chromium-based browser is installed) and prints JSON with `port`, `url` and `sessionDir`. The default scope is `isolate`; pass `--scope page` for whole-page reworks. Starting again with the same `--title` resumes that session (history, checkpoints) instead of creating a new one. `ui-studio list` shows running studios.

## 4. Launch the fork

Call the Agent tool with `subagent_type: "fork"`, `description: "UI Studio: <title>"`, and a prompt like this (fill in every field):

```
You are the UI Studio agent for "<title>". Read SKILL_DIR/references/agent-loop.md now and follow it until the user finishes the session. Start by building the workbench and declaring the UX states.
CLI: SKILL_DIR/scripts/ui-studio -p <port>
Studio URL: <url>
Project: <repo root>. Mode: <mode> (<why>). Dev server: <upstream or none>.
Target: <what it is>; route <route>; selector <selector>; files: <files you identified>.
Added data-ui-studio attribute: <yes, in file X | no>.
User's direction: <brief, or "none given: open with distinct directions">.
```

Then tell the user, in one or two lines, that the studio "<title>" is open and they can talk to it there. Do not poll the fork: you are notified when it finishes.

The session ends when the user clicks Finish or closes the studio window (the window closes itself on Finish). The fork then cleans up and reports. When that report arrives, summarize the rework for the user in this session, under its title: what changed visually, the files touched, the final values or tokens, and anything left open. Keep it short and concrete. If it ended because the window was closed, add that running `start` with the same title reopens it with the full history.

## Updates

`start` prints `"update": {current, latest, url}` when a newer release of this skill is out (the studio window shows it too). Tell the user once, in one line after the studio opens: "UI Studio <latest> is out (you have <current>). Say 'update UI Studio' to get it." Never update on your own. When the user asks, run `SKILL_DIR/scripts/ui-studio update` and pass on the short summary of what changed that it prints. Studios already running keep the old version until they are started again.

## Rules for the main thread

- One studio per rework. Several can run at once (different titles); never let two of them work on the same files.
- While a fork is working, do not edit its files from the main thread. If the user asks you to change the rework from the terminal, use SendMessage to the fork instead of editing.
- The studio must never be left without an agent. The fork listens until the user clicks Finish, so its report normally starts with `FINISHED: <title>`. If a fork ends any other way (a report starting `ENDED EARLY`, an error, no report) and `ui-studio list` still shows that studio, relaunch it at once, without asking: launch a new fork with the same prompt plus "This is a resumed session: run `ui-studio -p <port> context` first." Meanwhile the studio shows "Reconnecting to Claude…" and keeps the user's messages queued for the new fork. If the studio itself is gone, run `start` again with the same title first.

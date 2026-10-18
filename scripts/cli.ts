#!/usr/bin/env bun
// ui-studio CLI: starts sessions and lets the agent talk to a running studio.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, openSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const HOME = join(homedir(), ".ui-studio");
const argv = process.argv.slice(2);

function opts(list: string[]) {
  const o: Record<string, any> = { _: [] as string[] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === "-p") o.port = list[++i];
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) o[k] = v;
      else if (i + 1 < list.length && !list[i + 1].startsWith("--")) o[k] = list[++i];
      else o[k] = true;
    } else o._.push(a);
  }
  return o;
}
const o = opts(argv);
const cmd = o._.shift(); // `-p PORT` may come before or after the command
const port = o.port || process.env.UIS_PORT;

function die(msg: string): never { console.error(msg); process.exit(1); }

async function call(path: string, body: any = {}, raw?: ArrayBuffer) {
  if (!port) die("missing -p <port>");
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    body: raw ?? JSON.stringify(body),
    headers: { "content-type": raw ? "application/octet-stream" : "application/json" },
    // @ts-ignore bun-specific: no client timeout for long polls
    timeout: false,
  }).catch((e) => die(`studio on port ${port} not reachable: ${e.message}`));
  const data: any = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!data.ok) die(`error: ${data.error || "failed"}`);
  return data;
}

function printEvents(events: any[]) {
  if (!events?.length) return;
  console.log("EVENTS (handle before continuing):");
  for (const e of events) console.log(JSON.stringify(e));
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// Opens the studio as a standalone app window (no address bar, tabs or history buttons), like an installed PWA.
// Each studio gets its own browser process (own profile in the session dir), so the server can close exactly
// this window when the session finishes; window.close() is unreliable once the preview frames have navigated.
function openAppWindow(url: string, sessionDir: string) {
  const detach = { stdio: "ignore" as const, detached: true };
  const args = [`--user-data-dir=${join(sessionDir, "window")}`, "--no-first-run", "--no-default-browser-check",
    "--hide-crash-restore-bubble", `--app=${url}`, "--window-size=1440,900"];
  const launch = (bin: string, label: string) => {
    const child = spawn(bin, args, detach);
    child.unref();
    if (child.pid) writeFileSync(join(sessionDir, "window.pid"), String(child.pid));
    return `${label} app window`;
  };
  if (process.platform === "darwin") {
    for (const app of ["Google Chrome", "Brave Browser", "Microsoft Edge", "Chromium", "Vivaldi"]) {
      for (const dir of ["/Applications", join(homedir(), "Applications")]) {
        const bin = join(dir, `${app}.app`, "Contents", "MacOS", app);
        if (existsSync(bin)) return launch(bin, app);
      }
    }
    spawn("open", [url], detach).unref();
    return "default browser (no Chromium-based browser found for an app window)";
  }
  if (process.platform === "linux") {
    for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"]) {
      const path = Bun.which(bin);
      if (path) return launch(path, bin);
    }
    spawn("xdg-open", [url], detach).unref();
    return "default browser";
  }
  spawn("cmd", ["/c", "start", "", "msedge", `--app=${url}`], detach).unref();
  return "Edge app window";
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";

switch (cmd) {
  case "start": {
    if (!o.title || o.title === true) die('--title is required: a short name that tells this rework apart, e.g. --title "Settings · Save button"');
    const project = resolve(o.project || process.cwd());
    const name = slug(o.name || o.title);
    const mode = o.mode || (o.upstream ? "app" : "static");
    if (!["app", "static", "frames"].includes(mode)) die("--mode must be app, static or frames");
    if (mode === "app" && !o.upstream) die("app mode needs --upstream <dev server url>");
    const projKey = `${basename(project)}-${createHash("sha1").update(project).digest("hex").slice(0, 6)}`;
    const sessionDir = join(HOME, projKey, name);
    mkdirSync(sessionDir, { recursive: true });
    const runtimeFile = join(sessionDir, "runtime.json");
    if (existsSync(runtimeFile)) {
      const rt = JSON.parse(readFileSync(runtimeFile, "utf8"));
      const alive = await fetch(rt.url + "/ui/app.js").then(() => true, () => false);
      if (alive) {
        const window = o["no-open"] ? "not opened" : openAppWindow(rt.url, sessionDir);
        console.log(JSON.stringify({ ...rt, sessionDir, resumed: true, note: "already running", window }, null, 2));
        break;
      }
    }
    const resumed = existsSync(join(sessionDir, "state.json"));
    writeFileSync(join(sessionDir, "config.json"), JSON.stringify({
      name, title: o.title || name, project, mode, upstream: o.upstream, root: o.root,
      route: o.route || "/", selector: o.selector || "", scope: o.scope || "isolate",
      brief: o.brief || "", watch: !!o.watch, port: o.listen ? Number(o.listen) : 0,
    }, null, 2));
    const log = openSync(join(sessionDir, "server.log"), "a");
    spawn(process.execPath, [join(import.meta.dir, "server.ts"), sessionDir], { detached: true, stdio: ["ignore", log, log] }).unref();
    for (let i = 0; i < 50 && !existsSync(runtimeFile); i++) await Bun.sleep(100);
    if (!existsSync(runtimeFile)) die(`server failed to start, see ${join(sessionDir, "server.log")}`);
    const rt = JSON.parse(readFileSync(runtimeFile, "utf8"));
    const window = o["no-open"] ? "not opened" : openAppWindow(rt.url, sessionDir);
    console.log(JSON.stringify({ ...rt, sessionDir, resumed, window }, null, 2));
    break;
  }
  case "list": {
    if (!existsSync(HOME)) break;
    for (const proj of readdirSync(HOME)) for (const s of readdirSync(join(HOME, proj))) {
      const rt = join(HOME, proj, s, "runtime.json");
      if (!existsSync(rt)) continue;
      const conf = JSON.parse(readFileSync(join(HOME, proj, s, "config.json"), "utf8"));
      console.log(`${conf.title}  ${JSON.parse(readFileSync(rt, "utf8")).url}  (${conf.project})`);
    }
    break;
  }
  case "wait": {
    // Long-poll in 50s chunks until something arrives or --for seconds pass (default fits Bash's 120s default).
    // There is no idle expiry: the agent listens until the user finishes the session.
    const total = Number(o.for || 110) * 1000;
    const t0 = Date.now();
    let res: any;
    do {
      res = await call("/agent/wait", { timeout: Math.min(50, Math.max(1, (total - (Date.now() - t0)) / 1000)) });
      if (res.events.length) break;
    } while (Date.now() - t0 < total - 1000);
    if (res.events.length) printEvents(res.events);
    else console.log("NO_EVENTS: nothing yet, call wait again.");
    break;
  }
  case "tick": { const r = await call("/agent/tick"); if (!r.events.length) console.log("NO_EVENTS"); printEvents(r.events); break; }
  case "status": { const r = await call("/agent/status", { focus: o._[0] || "", text: o._.slice(1).join(" ") }); console.log("ok"); printEvents(r.events); break; }
  case "suggest": { const r = await call("/agent/suggest", { items: o._, focus: o.focus || "" }); console.log("ok"); printEvents(r.events); break; }
  case "say": {
    const text = o._[0] === "-" || !o._.length ? await readStdin() : o._.join(" ");
    const r = await call("/agent/say", { text: text.trim() }); console.log("ok"); printEvents(r.events); break;
  }
  case "track": { const r = await call("/agent/track", { files: o._ }); console.log(`tracked: ${r.tracked.join(", ")}`); printEvents(r.events); break; }
  case "checkpoint": { const r = await call("/agent/checkpoint", { label: o._.join(" ") }); console.log(`checkpoint ${r.id}`); printEvents(r.events); break; }
  case "restore": { const r = await call("/agent/restore", { id: o._[0] }); console.log(`restored ${r.restored}; re-read before editing: ${r.files.join(", ")}`); printEvents(r.events); break; }
  case "show": {
    const r = await call("/agent/show", { id: o._[0], file: o._[1] });
    if (r.content === null) console.log("(file did not exist at that checkpoint)"); else process.stdout.write(r.content);
    printEvents(r.events); break;
  }
  case "compare": {
    // compare original:"Original" a:"Bold" b:"Minimal" --layout grid|side|slider --title "..." ; id@http://... runs a variant on its own dev server
    if (o.close) { const r = await call("/agent/compare", { close: true }); console.log("closed"); printEvents(r.events); break; }
    const variants = o._.map((spec: string) => {
      const m = spec.match(/^([\w-]+)(?:@(\S+?))?(?::(.*))?$/);
      if (!m) die(`bad variant spec: ${spec} (use id[@upstream][:label])`);
      return { id: m[1], upstream: m[2], label: m[3] || m[1] };
    });
    const r = await call("/agent/compare", { variants, layout: o.layout, title: o.title });
    console.log(`compare open: ${r.compare.variants.map((v: any) => `${v.id} -> ${v.appUrl}`).join(", ")}`);
    printEvents(r.events); break;
  }
  case "target": {
    const r = await call("/agent/target", { route: o.route, selector: o.selector, scope: o.scope, force: !!o.force });
    console.log(JSON.stringify(r.target)); printEvents(r.events); break;
  }
  case "frame": {
    const file = o._[0] || die("usage: frame <png> [--variant id]");
    const q = o.variant ? `?variant=${encodeURIComponent(o.variant)}` : "";
    const r = await call(`/agent/frame${q}`, {}, await Bun.file(file).arrayBuffer()); console.log(`frame ${r.url}`); printEvents(r.events); break;
  }
  case "leftovers": {
    const { variants, workbench } = (await call("/agent/leftovers")).leftovers;
    if (variants.length) console.log(`VARIANT SCAFFOLDING (remove when compare ends):\n${variants.join("\n")}`);
    if (workbench.length) console.log(`WORKBENCH (remove before the session ends):\n${workbench.join("\n")}`);
    if (!variants.length && !workbench.length) console.log("clean");
    break;
  }
  case "workbench": { const r = await call("/agent/workbench", { files: o._ }); console.log(`workbench files: ${r.workbench.join(", ")}`); printEvents(r.events); break; }
  case "states": {
    // states hover focus active disabled loading:"Loading…"  (pseudo states are forced; others reach the workbench as __UIS_STATE)
    const names: Record<string, string> = { hover: "Hover", focus: "Focus", "focus-visible": "Focus", active: "Pressed" };
    if (!o.single && !o.clear && !o._.length) die("usage: states <id[:label]>... | states --single (element has only one state) | states --clear");
    const states = o.single || o.clear ? [] : o._.map((spec: string) => {
      const [id, ...label] = spec.split(":");
      return { id, label: label.join(":") || names[id] || id[0].toUpperCase() + id.slice(1) };
    });
    const r = await call("/agent/states", { states, mode: o.single ? "single" : o.clear ? "unset" : "declared" });
    console.log(o.single ? "states: single state (no state strip)" : `states: ${r.states.map((s: any) => s.id).join(", ") || "(cleared)"}`);
    printEvents(r.events); break;
  }
  case "check": {
    const r = await call("/agent/check");
    console.log(`${r.healthy ? "HEALTHY" : "BROKEN"}\n${r.report}`);
    printEvents(r.events);
    if (!r.healthy) process.exit(2);
    break;
  }
  case "context": { const r = await call("/agent/context"); console.log(r.context); printEvents(r.events); break; }
  case "stop": { await call("/agent/stop"); console.log("stopped"); break; }
  default:
    console.log(`ui-studio [-p PORT] <command> ...
  start --project DIR --title "Area · Element" --mode app|static|frames [--upstream URL] [--root DIR]
        [--route /path] [--selector CSS] [--scope element|isolate|page] [--brief TEXT] [--watch] [--no-open]
  list
  wait [--for SECONDS]                         block until the user does something
  tick                                          non-blocking inbox check
  status <focus> [text...]                      "Working on <focus>…" under the preview
  suggest <card>... [--focus F]                 replace the suggestion grid
  say <text> | say -  (stdin)                   chat reply (markdown)
  track <file>...                               snapshot originals BEFORE first edit
  checkpoint <label>                            save tracked files as a restorable step
  restore <id> | show <id> <file>
  compare <id[@upstream][:label]>... [--layout grid|side|slider] [--title T] | compare --close
  target [--route R] [--selector S] [--scope element|isolate|page]   verified first; refused if it would not render
  check                                         render the target in every state and report errors
  workbench <file>...                           register workbench files (never snapshotted; must be gone at the end)
  states <id[:label]>... | states --single      UX states shown next to the preview (required before the first checkpoint;
                                                hover/focus/active are forced; --single only if the element has one state)
  frame <png> [--variant id]                    native/frames mode only
  leftovers                                     list variant scaffolding and workbench files still present
  context | stop`);
}

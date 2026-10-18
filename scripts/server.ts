#!/usr/bin/env bun
// UI Studio server: serves the studio UI, the agent API and live proxies of the app being designed.
// Usage: bun server.ts <sessionDir>   (normally spawned by `ui-studio start`)
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, watch } from "node:fs";
import { join, resolve, relative, dirname, isAbsolute, basename, extname } from "node:path";

const sessionDir = resolve(process.argv[2] ?? "");
const UI_DIR = resolve(import.meta.dir, "../ui");
const cfg = JSON.parse(readFileSync(join(sessionDir, "config.json"), "utf8"));
const projectRoot: string = cfg.project;
const stateFile = join(sessionDir, "state.json");
const enc = new TextEncoder();
// Loopback only: the proxy strips CSP and frame headers and the agent API edits files, so nothing may be reachable from the network.
const HOST = "127.0.0.1";

// ---------- state ----------

const state: any = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : {
      seq: 0,
      messages: [],
      suggestions: [],
      target: { route: cfg.route || "/", selector: cfg.selector || "", scope: cfg.scope || "isolate" },
      tracked: [],
      workbench: [],
      states: [],
      snapshots: [],
      current: null,
      compare: null,
      frames: {},
      finished: false,
    };
state.status = { phase: "idle", focus: "", text: "" };
state.finished = false;
state.workbench ??= [];
state.states ??= [];
state.statesMode ??= "unset"; // unset | declared | single
// A picked variant is shown in the live preview and the state tiles at once, until the agent has made it the real
// code and closes compare. Not kept across restarts: an instance variant's dev server proxy would be gone.
state.preview = null;

const nextId = (p: string) => `${p}${++state.seq}`;
let saveTimer: any;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeFileSync(stateFile, JSON.stringify(state, null, 2)), 100);
}

// ---------- SSE to studio UI ----------

const clients = new Set<ReadableStreamDefaultController>();
function sse(ctrl: ReadableStreamDefaultController, obj: any) {
  try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { clients.delete(ctrl); }
}
function publicState() {
  return {
    ...state,
    agent: agentPresence(),
    config: { name: cfg.name, title: cfg.title, mode: cfg.mode, appUrl: mainAppUrl(), brief: cfg.brief || "", version: cfg.version, update: cfg.update || null },
  };
}
let broadcastTimer: any;
function broadcast() {
  save();
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => { const s = publicState(); for (const c of clients) sse(c, { type: "state", state: s }); }, 30);
}
setInterval(() => { for (const c of clients) try { c.enqueue(enc.encode(": ping\n\n")); } catch { clients.delete(c); } }, 10_000);

// The app window runs in its own browser process (see openAppWindow in cli.ts); closing it means ending that process.
function closeAppWindow() {
  const pidFile = join(sessionDir, "window.pid");
  if (!existsSync(pidFile)) return;
  try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM"); } catch {}
  rmSync(pidFile, { force: true });
}

// Closing the studio window ends the session like Finish. A short grace period covers reloads and reconnects.
let windowSeenAt = 0;
setInterval(() => {
  if (clients.size) { windowSeenAt = Date.now(); return; }
  if (!windowSeenAt || state.finished || Date.now() - windowSeenAt < 20_000) return;
  state.finished = true;
  addMessage({ role: "system", text: "Window closed, session finished" });
  pushEvent({ type: "done", reason: "window_closed" });
}, 5000);

// ---------- agent inbox ----------

const inbox: any[] = [];
const waiters: { resolve: (ev: any[]) => void; timer: any }[] = [];
let lastAgentAt = 0;
let lastUserAt = Date.now();
let lastPresence = "";

function agentPresence() {
  if (waiters.length) return "listening";
  if (Date.now() - lastAgentAt < 45_000) return state.status.phase === "working" ? "working" : "listening";
  return "away";
}
setInterval(() => { const p = agentPresence(); if (p !== lastPresence) { lastPresence = p; broadcast(); } }, 2000);

function pushEvent(ev: any, fromUser = true) {
  inbox.push(ev);
  if (fromUser) lastUserAt = Date.now();
  const w = waiters.shift();
  if (w) { clearTimeout(w.timer); w.resolve(drain(true)); }
  broadcast();
}

// Queued prompts (new requests sent while the agent works) reach it only through `wait`, one per call, so each
// request gets its own turn. Everything else, steering prompts included, is delivered at the agent's next call.
function drain(forWait = false) {
  const events: any[] = [];
  let tookQueued = false;
  for (let i = 0; i < inbox.length; ) {
    const ev = inbox[i];
    if (ev.queued && (!forWait || tookQueued)) { i++; continue; }
    if (ev.queued) tookQueued = true;
    const { queued, ...delivered } = ev; // the agent only needs `steer`
    events.push(delivered);
    inbox.splice(i, 1);
  }
  for (const ev of events) {
    // Any event that came from a chat message (prompt, pick, compare request) marks it as read.
    const m = ev.msgId && state.messages.find((m: any) => m.id === ev.msgId);
    if (m) m.delivered = true;
    if (ev.type === "prompt") state.status = { phase: "working", focus: "", text: "Reading your request…" };
  }
  if (events.length) broadcast();
  return events;
}

function agentReply(extra: any = {}) {
  lastAgentAt = Date.now();
  return Response.json({ ok: true, ...extra, events: drain() });
}

function addMessage(m: any) {
  const msg = { id: nextId("m"), ts: Date.now(), ...m };
  state.messages.push(msg);
  broadcast();
  return msg;
}

// ---------- file tracking and checkpoints ----------

function relPath(f: string) {
  const abs = isAbsolute(f) ? f : join(projectRoot, f);
  const rel = relative(projectRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`file outside project: ${f}`);
  return rel;
}
const snapDir = (id: string) => join(sessionDir, "snapshots", id, "files");
// Frozen HTML of the target per UX state (made by inject.js during the checkpoint's render check), for before/after.
const domDir = (id: string) => join(sessionDir, "snapshots", id, "dom");
function saveDom(id: string, results: any[] = []) {
  const snap = state.snapshots.find((s: any) => s.id === id);
  if (!snap) return;
  const saved: string[] = [];
  for (const r of results) {
    if (!r.found || !r.dom) continue;
    mkdirSync(domDir(id), { recursive: true });
    const name = r.state || "default";
    writeFileSync(join(domDir(id), `${name}.html`), r.dom);
    saved.push(name);
  }
  if (saved.length) { snap.dom = saved; broadcast(); }
}
function domResponse(pathname: string) {
  const m = pathname.match(/^\/__uis\/dom\/(s\d+)\/([\w-]+)\.html$/);
  const file = m && [join(domDir(m[1]), `${m[2]}.html`), join(domDir(m[1]), "default.html")].find((f) => existsSync(f));
  if (!file) return new Response("no snapshot", { status: 404 });
  return new Response(injectHtml(readFileSync(file, "utf8"), false), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
// Opens the studio-built before/after slider (current code vs a frozen checkpoint). `built: false` when that
// checkpoint has no frozen DOM (older session, frames mode): the agent then has to build it live.
function openBeforeAfter(before?: string) {
  const id = before || defaultBefore();
  const snap = state.snapshots.find((s: any) => s.id === id);
  if (!snap) return { error: `unknown checkpoint: ${id}` };
  const label = snap.id === "s0" ? "Original" : snap.label;
  if (!snap.dom?.length || cfg.mode === "frames") return { built: false, id, label };
  state.preview = null;
  state.compare = {
    title: "Before / after", layout: "slider", mode: "before_after", before: id,
    variants: [
      { id: "before", label, appUrl: mainAppUrl(), switch: false, dom: id },
      { id: "live", label: "Current", appUrl: mainAppUrl(), switch: false },
    ],
  };
  broadcast();
  return { built: true, id, label };
}

// Whether the tracked files differ from a checkpoint.
function changedSince(id: string) {
  const snap = state.snapshots.find((s: any) => s.id === id);
  const base = state.snapshots.find((s: any) => s.id === "s0");
  if (!snap || !base) return false;
  for (const rel of state.tracked) {
    const from = rel in snap.files ? snap : base;
    const abs = join(projectRoot, rel);
    const was = from.files[rel] === "absent" ? null : readFileSync(join(snapDir(from.id), rel));
    const now = existsSync(abs) ? readFileSync(abs) : null;
    if (!was || !now ? was !== now : !was.equals(now)) return true;
  }
  return false;
}
// Before/after compares the current code with the last checkpoint: the current one if the code has moved on since,
// otherwise the one before it (the original when there is none).
function defaultBefore() {
  const cur = state.current;
  if (!cur) return "s0";
  if (changedSince(cur)) return cur;
  const i = state.snapshots.findIndex((s: any) => s.id === cur);
  return i > 0 ? state.snapshots[i - 1].id : "s0";
}

function copyInto(id: string, rel: string) {
  const src = join(projectRoot, rel);
  if (!existsSync(src)) return "absent";
  const dst = join(snapDir(id), rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return "exists";
}

function track(files: string[]) {
  let base = state.snapshots.find((s: any) => s.id === "s0");
  if (!base) {
    base = { id: "s0", kind: "baseline", label: "Original", ts: Date.now(), files: {} };
    state.snapshots.unshift(base);
  }
  const added: string[] = [];
  for (const f of files) {
    const rel = relPath(f);
    // Workbench files are tooling, not design: never snapshot or restore them.
    if (state.tracked.includes(rel) || state.workbench.includes(rel)) continue;
    base.files[rel] = copyInto("s0", rel);
    state.tracked.push(rel);
    added.push(rel);
  }
  broadcast();
  return added;
}

function checkpoint(label: string) {
  if (!state.tracked.length) throw new Error("no tracked files; run `track <files>` before editing");
  if (state.statesMode === "unset") throw new Error("declare the UX states first: `states hover focus active disabled …`, or `states --single` if the element truly has only one state");
  const id = `s${state.snapshots.length}`;
  const files: any = {};
  for (const rel of state.tracked) files[rel] = copyInto(id, rel);
  state.snapshots.push({ id, kind: "checkpoint", label, ts: Date.now(), files });
  state.current = id;
  addMessage({ role: "snapshot", snapshotId: id, text: label });
  return id;
}

function restore(id: string) {
  const snap = state.snapshots.find((s: any) => s.id === id);
  const base = state.snapshots.find((s: any) => s.id === "s0");
  if (!snap || !base) throw new Error(`unknown checkpoint: ${id}`);
  for (const rel of state.tracked) {
    const from = rel in snap.files ? snap : base;
    const abs = join(projectRoot, rel);
    if (from.files[rel] === "absent") rmSync(abs, { force: true });
    else { mkdirSync(dirname(abs), { recursive: true }); copyFileSync(join(snapDir(from.id), rel), abs); }
  }
  state.current = id;
  state.preview = null;
  broadcast();
  return snap;
}

function leftovers() {
  // Variant scaffolding goes when compare ends; the workbench goes when the session ends.
  const variants: string[] = [];
  const workbench: string[] = state.workbench.filter((rel: string) => existsSync(join(projectRoot, rel)));
  for (const rel of state.tracked) {
    const abs = join(projectRoot, rel);
    if (!existsSync(abs)) continue;
    readFileSync(abs, "utf8").split("\n").forEach((line, i) => {
      if (/__UIS_VARIANT|data-uis-variant|uis-variant/.test(line)) variants.push(`${rel}:${i + 1}: ${line.trim()}`);
      if (/__UIS_STATE|data-uis-state|uis-workbench/.test(line)) workbench.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return { variants, workbench };
}

// ---------- live app proxies ----------

const INJECT_PATH = "/__uis/inject.js";
const proxies = new Map<string, number>(); // upstream -> port
let staticPort = 0;
const reloadClients = new Set<ReadableStreamDefaultController>();

function injectHtml(html: string, reload: boolean) {
  const tag = `<script src="${INJECT_PATH}${reload ? "?reload=1" : ""}"></script>`;
  // End of <head>: React 19 hydration skips unexpected trailing head tags instead of diffing them against its own.
  const close = html.search(/<\/head>/i);
  if (close >= 0) return html.slice(0, close) + tag + html.slice(close);
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], head[0] + tag);
  const i = html.search(/<script/i);
  return i >= 0 ? html.slice(0, i) + tag + html.slice(i) : tag + html;
}
const injectJs = () => new Response(Bun.file(join(UI_DIR, "inject.js")), { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });

function reloadStream() {
  let ctrl: ReadableStreamDefaultController;
  return new Response(new ReadableStream({
    start(c) { ctrl = c; reloadClients.add(c); c.enqueue(enc.encode(": hi\n\n")); },
    cancel() { reloadClients.delete(ctrl); },
  }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}
let reloadTimer: any;
function triggerReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { for (const c of reloadClients) try { c.enqueue(enc.encode("data: reload\n\n")); } catch { reloadClients.delete(c); } }, 120);
}
function watchDir(dir: string) {
  try {
    watch(dir, { recursive: true }, (_ev, file) => {
      if (!file || /(^|\/)(node_modules|\.git|\.next|\.ui-studio|dist|build)(\/|$)/.test(String(file))) return;
      triggerReload();
    });
  } catch (e) { console.error("watch failed", e); }
}

const STRIP_RES = ["content-encoding", "content-length", "x-frame-options", "content-security-policy", "content-security-policy-report-only", "transfer-encoding"];

function startProxy(upstream: string) {
  if (proxies.has(upstream)) return proxies.get(upstream)!;
  const up = new URL(upstream);
  const wsBase = up.origin.replace(/^http/, "ws");
  const reload = !!cfg.watch;
  const server = Bun.serve<any, any>({
    hostname: HOST,
    port: 0,
    idleTimeout: 120,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === INJECT_PATH) return injectJs();
      if (url.pathname.startsWith("/__uis/dom/")) return domResponse(url.pathname);
      if (url.pathname === "/__uis/reload") { srv.timeout?.(req, 0); return reloadStream(); }
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocols = (req.headers.get("sec-websocket-protocol") || "").split(",").map((s) => s.trim()).filter(Boolean);
        const ok = srv.upgrade(req, {
          data: { path: url.pathname + url.search, protocols, buf: [] as any[] },
          headers: protocols.length ? { "Sec-WebSocket-Protocol": protocols[0] } : undefined,
        });
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      }
      const target = new URL(url.pathname + url.search, up);
      const headers = new Headers(req.headers);
      headers.set("host", up.host);
      headers.set("accept-encoding", "identity");
      if (headers.has("origin")) headers.set("origin", up.origin);
      const ref = headers.get("referer");
      if (ref) { try { const r = new URL(ref); headers.set("referer", up.origin + r.pathname + r.search); } catch {} }
      let res: Response;
      try {
        res = await fetch(target, {
          method: req.method,
          headers,
          body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
          redirect: "manual",
        });
      } catch (e) {
        return new Response(`<!doctype html><body style="font:14px system-ui;padding:24px;color:#888">UI Studio: cannot reach ${upstream} (${(e as Error).message}). Is the dev server running?</body>`, { status: 502, headers: { "content-type": "text/html" } });
      }
      const h = new Headers(res.headers);
      for (const k of STRIP_RES) h.delete(k);
      const loc = h.get("location");
      if (loc) h.set("location", loc.replace(up.origin, `http://localhost:${srv.port}`));
      if ((h.get("content-type") || "").includes("text/html") && req.method === "GET") {
        return new Response(injectHtml(await res.text(), reload), { status: res.status, headers: h });
      }
      return new Response(res.body, { status: res.status, headers: h });
    },
    websocket: {
      open(ws) {
        const d = ws.data;
        const upWs = new WebSocket(wsBase + d.path, { headers: { Origin: up.origin }, protocols: d.protocols } as any);
        upWs.binaryType = "arraybuffer";
        d.up = upWs;
        upWs.onopen = () => { for (const m of d.buf) upWs.send(m); d.buf = null; };
        upWs.onmessage = (e) => ws.send(e.data as any);
        upWs.onclose = (e) => { try { ws.close(e.code === 1000 || (e.code >= 3000 && e.code < 5000) ? e.code : 1000); } catch {} };
        upWs.onerror = () => { try { ws.close(1011); } catch {} };
      },
      message(ws, msg) { const d = ws.data; if (d.buf) d.buf.push(msg); else try { d.up.send(msg); } catch {} },
      close(ws) { try { ws.data.up?.close(); } catch {} },
    },
  });
  proxies.set(upstream, server.port);
  return server.port;
}

function startStatic(root: string) {
  const server = Bun.serve({
    hostname: HOST,
    port: 0,
    idleTimeout: 120,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === INJECT_PATH) return injectJs();
      if (url.pathname.startsWith("/__uis/dom/")) return domResponse(url.pathname);
      if (url.pathname === "/__uis/reload") { srv.timeout?.(req, 0); return reloadStream(); }
      let p = resolve(root, "." + decodeURIComponent(url.pathname));
      if (!p.startsWith(root)) return new Response("forbidden", { status: 403 });
      let f = Bun.file(p);
      if (!(await f.exists()) || url.pathname.endsWith("/")) { p = join(p, "index.html"); f = Bun.file(p); }
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      const headers = { "cache-control": "no-store", "content-type": f.type };
      if (extname(p) === ".html") return new Response(injectHtml(await f.text(), true), { headers });
      return new Response(f, { headers });
    },
  });
  watchDir(root);
  return server.port;
}

function mainAppUrl() {
  if (cfg.mode === "app") return `http://localhost:${startProxy(cfg.upstream)}`;
  if (cfg.mode === "static") return `http://localhost:${staticPort}`;
  return null;
}
if (cfg.mode === "static") staticPort = startStatic(resolve(cfg.root || projectRoot));
if (cfg.mode === "app") { startProxy(cfg.upstream); if (cfg.watch) watchDir(projectRoot); }

// ---------- compare ----------

function setCompare(body: any) {
  state.preview = null; // the agent closing compare (or opening a new one) means the pick is real code now
  if (!body || body.close) { state.compare = null; broadcast(); return; }
  const variants = (body.variants || []).map((v: any) => ({
    id: String(v.id),
    label: v.label || String(v.id),
    // Instance variants run on their own dev server; switch variants share the main one.
    appUrl: v.upstream ? `http://localhost:${startProxy(v.upstream)}` : mainAppUrl(),
    switch: !v.upstream,
    frame: v.frame || null,
  }));
  if (!variants.length) throw new Error("compare needs at least one variant");
  state.compare = { title: body.title || "Compare", layout: body.layout || (variants.length === 2 ? "side" : "grid"), variants };
  broadcast();
}

// ---------- preview verification ----------
// Nothing is shown to the user unless it renders: targets and checkpoints are verified first,
// by HTTP (waiting for the dev server to compile) and by an off-screen render in the studio window.

const probes = new Map<string, (r: any) => void>();
const stateTargets = () => [{ id: null, label: "Default" }, ...(state.statesMode === "single" ? [] : state.states)];

async function httpCheck(route: string) {
  const base = mainAppUrl();
  if (!base) return { ok: true, status: 0 };
  const deadline = Date.now() + 25_000;
  let status = 0;
  for (;;) {
    try { const r = await fetch(base + route, { redirect: "follow" }); status = r.status; await r.arrayBuffer(); } catch { status = 0; }
    if (status >= 200 && status < 400) return { ok: true, status };
    if (Date.now() > deadline) return { ok: false, status };
    await Bun.sleep(1500);
  }
}

function browserCheck(target: any, states: any[], capture = false): Promise<any> {
  if (!clients.size) return Promise.resolve({ skipped: true });
  const id = nextId("p");
  return new Promise((resolve) => {
    const t = setTimeout(() => { probes.delete(id); resolve({ timeout: true }); }, 45_000);
    probes.set(id, (r) => { clearTimeout(t); probes.delete(id); resolve(r); });
    for (const c of clients) sse(c, { type: "probe", id, target, states, capture });
  });
}

async function verify(target: any, states = stateTargets(), capture = false) {
  if (cfg.mode === "frames") return { ok: true, report: "frames mode: not verified" };
  const http = await httpCheck(target.route);
  if (!http.ok) return { ok: false, report: `${target.route} answers HTTP ${http.status || "nothing"} (waited 25s for the dev server)` };
  const b = await browserCheck(target, states, capture);
  if (b.skipped) return { ok: true, report: `HTTP ${http.status}; render check skipped (no studio window open)` };
  if (b.timeout) return { ok: false, report: "the studio window did not finish rendering the previews within 45s" };
  const bad = b.results.filter((r: any) => !r.found || r.errors.length);
  const report = b.results.map((r: any) =>
    `${r.label}: ${r.found ? "renders" : `TARGET NOT FOUND (${target.selector})`}${r.errors.length ? `; errors: ${r.errors.join(" | ")}` : ""}`).join("\n");
  return { ok: !bad.length, report, results: b.results };
}

// Runtime errors from previews go to the agent (deduped), never to the user.
const seenErrors = new Map<string, number>();
function pageError(message: string, where: string) {
  const key = message.slice(0, 200);
  const last = seenErrors.get(key) || 0;
  seenErrors.set(key, Date.now());
  if (Date.now() - last < 60_000) return;
  pushEvent({ type: "page_error", message, where }, false);
}

// ---------- context for resumed agents ----------

function contextText() {
  const lines = [
    `UI Studio session "${cfg.title}" (${cfg.mode} mode), project ${projectRoot}`,
    `Target: route ${state.target.route} selector ${state.target.selector || "(none)"} scope ${state.target.scope}`,
    `Brief: ${cfg.brief || "(none)"}`,
    `Tracked files: ${state.tracked.join(", ") || "(none)"}`,
    `Workbench files: ${state.workbench.join(", ") || "(none)"}`,
    `UX states: ${state.statesMode === "single" ? "single state" : state.states.map((s: any) => s.id).join(", ") || "(not declared yet)"}`,
    `Checkpoints: ${state.snapshots.map((s: any) => `${s.id} "${s.label}"`).join(", ") || "(none)"}; current ${state.current || "-"}`,
    `Compare open: ${!state.compare ? "no" : state.compare.mode === "before_after" ? `before/after vs ${state.compare.before} (built by the studio, nothing to do)` : state.compare.variants.map((v: any) => v.id).join(", ")}`,
    `Picked variant shown in the preview: ${state.preview ? `${state.preview.id} (until you run compare --close)` : "none"}`,
    "", "Conversation:",
  ];
  for (const m of state.messages) {
    if (m.role === "snapshot") lines.push(`  [checkpoint ${m.snapshotId}] ${m.text}`);
    else lines.push(`  [${m.role}${m.role === "user" && m.delivered === false && !m.steer ? ", queued: arrives through wait" : ""}] ${m.text}${m.attachments?.length ? ` (attachments: ${m.attachments.map((a: any) => a.path).join(", ")})` : ""}`);
  }
  return lines.join("\n");
}

// ---------- studio server ----------

const json = async (req: Request) => { try { return await req.json(); } catch { return {}; } };

const studio = Bun.serve({
  hostname: HOST,
  port: cfg.port || 0,
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      // --- studio UI ---
      if (p === "/" || p === "/index.html") return new Response(Bun.file(join(UI_DIR, "index.html")), { headers: { "cache-control": "no-store" } });
      if (p.startsWith("/ui/")) {
        const f = Bun.file(join(UI_DIR, basename(p)));
        return (await f.exists()) ? new Response(f, { headers: { "cache-control": "no-store", "content-type": f.type } }) : new Response("not found", { status: 404 });
      }
      if (p.startsWith("/attachments/") || p.startsWith("/frames/")) {
        const f = Bun.file(join(sessionDir, p.split("/")[1], basename(decodeURIComponent(p))));
        return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
      }
      if (p === "/events") {
        srv.timeout?.(req, 0);
        let ctrl: ReadableStreamDefaultController;
        return new Response(new ReadableStream({
          start(c) { ctrl = c; clients.add(c); sse(c, { type: "state", state: publicState() }); },
          cancel() { clients.delete(ctrl); },
        }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }

      // --- user actions from the UI ---
      if (p === "/api/prompt" && req.method === "POST") {
        const form = await req.formData();
        const text = String(form.get("text") || "").trim();
        const about = JSON.parse(String(form.get("about") || "[]"));
        const attachments: any[] = [];
        const dir = join(sessionDir, "attachments");
        mkdirSync(dir, { recursive: true });
        for (const f of form.getAll("files")) {
          if (typeof f === "string") continue;
          const name = `${Date.now().toString(36)}-${(f as File).name.replace(/[^\w.-]+/g, "_")}`;
          await Bun.write(join(dir, name), f as File);
          attachments.push({ name: (f as File).name, path: join(dir, name), url: `/attachments/${name}`, type: (f as File).type });
        }
        if (!text && !attachments.length) return Response.json({ ok: false });
        // Steering goes into the current step; anything else is a new request and waits its turn.
        const steer = form.get("steer") === "1";
        const m = addMessage({ role: "user", text, attachments, about, delivered: false, steer });
        pushEvent({ type: "prompt", id: m.id, msgId: m.id, text, attachments: attachments.map((a) => a.path), about, steer, queued: !steer });
        return Response.json({ ok: true });
      }
      if (p === "/api/unqueue" && req.method === "POST") {
        const { id } = await json(req);
        const i = inbox.findIndex((e) => e.queued && e.msgId === id);
        if (i < 0) return Response.json({ ok: false, error: "already picked up" });
        inbox.splice(i, 1);
        state.messages = state.messages.filter((m: any) => m.id !== id);
        broadcast();
        return Response.json({ ok: true });
      }
      if (p === "/api/interrupt" && req.method === "POST") {
        addMessage({ role: "system", text: "Stop requested" });
        state.status = { ...state.status, text: "Stopping…" };
        pushEvent({ type: "interrupt" });
        return Response.json({ ok: true });
      }
      if (p === "/api/restore" && req.method === "POST") {
        const { id } = await json(req);
        const snap = restore(id);
        addMessage({ role: "system", text: `Restored “${snap.label}”` });
        pushEvent({ type: "restored", checkpoint: id, label: snap.label });
        return Response.json({ ok: true });
      }
      if (p === "/api/compare-request" && req.method === "POST") {
        const body = await json(req);
        const snaps = (body.ids || []).map((id: string) => {
          if (id === "live") return { id: "live", label: "Current" };
          const s = state.snapshots.find((s: any) => s.id === id);
          return s && { id: s.id, label: s.label };
        }).filter(Boolean);
        const m = addMessage({ role: "user", text: `Compare: ${snaps.map((s: any) => s.label).join(" vs ")}`, delivered: false });
        pushEvent({ type: "compare_request", checkpoints: snaps, mode: body.mode || "compare", msgId: m.id });
        return Response.json({ ok: true });
      }
      // Before/after is built by the studio from the checkpoint's frozen DOM: the agent is not involved. Without one
      // (an older session, frames mode) it falls back to asking the agent for a live comparison.
      if (p === "/api/before-after" && req.method === "POST") {
        const { before } = await json(req);
        const r = openBeforeAfter(before);
        if (r.error) return Response.json({ ok: false, error: r.error });
        if (!r.built) {
          const m = addMessage({ role: "user", text: `Compare: ${r.label} vs Current`, delivered: false });
          pushEvent({ type: "compare_request", checkpoints: [{ id: r.id, label: r.label }, { id: "live", label: "Current" }], mode: "before_after", msgId: m.id });
        }
        return Response.json({ ok: true, built: r.built });
      }
      if (p === "/api/answer" && req.method === "POST") {
        const { id, option } = await json(req);
        const q = state.messages.find((m: any) => m.id === id && m.options);
        if (!q || q.answered || !q.options.includes(option)) return Response.json({ ok: false, error: "not an open question" });
        q.answered = option;
        const m = addMessage({ role: "user", text: option, delivered: false, steer: true });
        pushEvent({ type: "answer", question: q.text, answer: option, msgId: m.id });
        return Response.json({ ok: true });
      }
      if (p === "/api/pick" && req.method === "POST") {
        const { id } = await json(req);
        if (state.compare?.mode === "before_after") return Response.json({ ok: false, error: "nothing to pick in before/after" });
        const v = state.compare?.variants.find((v: any) => v.id === id);
        if (!v) return Response.json({ ok: false, error: "unknown variant" });
        // The user sees the pick at once: compare closes and the live preview renders that variant until the agent
        // has turned it into the real code.
        state.preview = { id: v.id, label: v.label, appUrl: v.appUrl, switch: v.switch, frame: v.frame || state.frames[v.id] || null };
        state.compare = null;
        const m = addMessage({ role: "user", text: `Picked “${v.label}”`, delivered: false });
        pushEvent({ type: "pick", variant: v.id, label: v.label, msgId: m.id });
        broadcast();
        return Response.json({ ok: true });
      }
      if (p === "/api/compare-layout" && req.method === "POST") {
        const { layout } = await json(req);
        if (state.compare) { state.compare.layout = layout; broadcast(); }
        return Response.json({ ok: true });
      }
      if (p === "/api/compare-close" && req.method === "POST") {
        // A studio-built before/after has no variant code behind it, so the agent has nothing to clean up.
        if (state.compare) { const ba = state.compare.mode === "before_after"; state.compare = null; if (ba) broadcast(); else pushEvent({ type: "compare_closed" }); }
        return Response.json({ ok: true });
      }
      if (p.startsWith("/api/probe/") && req.method === "POST") {
        probes.get(p.slice("/api/probe/".length))?.(await json(req));
        return Response.json({ ok: true });
      }
      if (p === "/api/page-error" && req.method === "POST") {
        const { message = "", where = "" } = await json(req);
        if (message) pageError(String(message), String(where));
        return Response.json({ ok: true });
      }
      if (p === "/api/preview-error" && req.method === "POST") {
        const { message = "" } = await json(req);
        pushEvent({ type: "preview_error", message }, false);
        return Response.json({ ok: true });
      }
      if (p === "/api/finish" && req.method === "POST") {
        state.finished = true;
        addMessage({ role: "system", text: "Session finished" });
        pushEvent({ type: "done" });
        setTimeout(closeAppWindow, 1200); // let the window show "Finished" for a moment
        return Response.json({ ok: true });
      }

      // --- agent API ---
      if (p === "/agent/wait") {
        srv.timeout?.(req, 0);
        const { timeout = 50 } = await json(req);
        lastAgentAt = Date.now();
        const ready = drain(true);
        if (ready.length) return Response.json({ ok: true, events: ready, idleFor: Math.round((Date.now() - lastUserAt) / 1000) });
        state.status = { phase: "idle", focus: "", text: "" };
        broadcast();
        const events = await new Promise<any[]>((res) => {
          const w = { resolve: res, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); res([]); }, Math.min(timeout, 55) * 1000) };
          waiters.push(w);
          broadcast();
        });
        lastAgentAt = Date.now();
        broadcast();
        return Response.json({ ok: true, events, idleFor: Math.round((Date.now() - lastUserAt) / 1000) });
      }
      if (p === "/agent/tick") return agentReply();
      if (p === "/agent/status") {
        const { focus = "", text = "" } = await json(req);
        state.status = { phase: "working", focus, text: text || (focus ? `Working on ${focus}…` : "Working…") };
        broadcast();
        return agentReply();
      }
      if (p === "/agent/suggest") {
        const { items = [], focus = "" } = await json(req);
        state.suggestions = items.map((t: string) => ({ text: t, focus }));
        broadcast();
        return agentReply();
      }
      // A question with clickable answers in the chat: the user never has to type a reply.
      if (p === "/agent/ask") {
        const { question = "", options = [] } = await json(req);
        if (!question || options.length < 2) throw new Error("ask needs a question and at least 2 options");
        const m = addMessage({ role: "agent", text: question, options: options.slice(0, 5), answered: null });
        return agentReply({ id: m.id });
      }
      if (p === "/agent/say") {
        const { text = "" } = await json(req);
        addMessage({ role: "agent", text });
        return agentReply();
      }
      if (p === "/agent/track") {
        srv.timeout?.(req, 0);
        const { files = [] } = await json(req);
        const first = !state.snapshots.some((s: any) => s.id === "s0");
        const added = track(files);
        // The original's look is frozen now, before the first edit, for before/after.
        if (first && cfg.mode !== "frames") { const v = await verify(state.target, stateTargets(), true); saveDom("s0", v.results); }
        return agentReply({ added, tracked: state.tracked });
      }
      if (p === "/agent/checkpoint") {
        srv.timeout?.(req, 0);
        const { label = "Checkpoint" } = await json(req);
        if (state.statesMode === "unset") checkpoint(label); // throws the states message first
        const v = await verify(state.target, stateTargets(), true);
        if (!v.ok) throw new Error(`checkpoint refused, the preview is broken:\n${v.report}`);
        state.preview = null; // a checkpoint is the real code, so a picked variant no longer needs to be shown
        const id = checkpoint(label);
        saveDom(id, v.results);
        return agentReply({ id });
      }
      if (p === "/agent/check") {
        srv.timeout?.(req, 0);
        const v = await verify(state.target);
        return agentReply({ healthy: v.ok, report: v.report });
      }
      if (p === "/agent/restore") {
        const { id } = await json(req);
        const snap = restore(id);
        return agentReply({ restored: snap.id, files: state.tracked });
      }
      if (p === "/agent/show") {
        // Prints a tracked file as it was in a checkpoint, without touching the working tree.
        const { id, file } = await json(req);
        const rel = relPath(file);
        const snap = state.snapshots.find((s: any) => s.id === id);
        if (!snap) throw new Error(`unknown checkpoint: ${id}`);
        const from = rel in snap.files ? snap : state.snapshots.find((s: any) => s.id === "s0");
        if (!from || !(rel in from.files)) throw new Error(`${rel} is not tracked`);
        const content = from.files[rel] === "absent" ? null : readFileSync(join(snapDir(from.id), rel), "utf8");
        return agentReply({ content });
      }
      if (p === "/agent/before-after") {
        const { before } = await json(req);
        const r = openBeforeAfter(before);
        if (r.error) throw new Error(r.error);
        return agentReply(r);
      }
      if (p === "/agent/compare") {
        setCompare(await json(req));
        return agentReply({ compare: state.compare });
      }
      if (p === "/agent/target") {
        srv.timeout?.(req, 0);
        const body = await json(req);
        const next = { ...state.target };
        for (const k of ["route", "selector", "scope"]) if (body[k] != null) next[k] = body[k];
        if (!body.force) {
          const v = await verify(next);
          if (!v.ok) throw new Error(`target NOT applied, the preview would be broken:\n${v.report}`);
        }
        state.target = next;
        broadcast();
        return agentReply({ target: state.target });
      }
      if (p === "/agent/frame") {
        const variant = url.searchParams.get("variant") || "live";
        const dir = join(sessionDir, "frames");
        mkdirSync(dir, { recursive: true });
        const name = `${variant}-${Date.now().toString(36)}.png`;
        await Bun.write(join(dir, name), await req.arrayBuffer());
        state.frames[variant] = `/frames/${name}`;
        broadcast();
        return agentReply({ url: state.frames[variant] });
      }
      if (p === "/agent/leftovers") return agentReply({ leftovers: leftovers() });
      if (p === "/agent/workbench") {
        const { files = [] } = await json(req);
        for (const f of files) { const rel = relPath(f); if (!state.workbench.includes(rel)) state.workbench.push(rel); }
        broadcast();
        return agentReply({ workbench: state.workbench });
      }
      if (p === "/agent/states") {
        const { states = [], mode } = await json(req);
        state.states = states;
        state.statesMode = mode || (states.length ? "declared" : "unset");
        broadcast();
        return agentReply({ states: state.states });
      }
      if (p === "/agent/context") return agentReply({ context: contextText() });
      if (p === "/agent/stop") {
        closeAppWindow();
        setTimeout(() => {
          rmSync(join(sessionDir, "runtime.json"), { force: true });
          rmSync(join(sessionDir, "window"), { recursive: true, force: true });
          writeFileSync(stateFile, JSON.stringify(state, null, 2));
          process.exit(0);
        }, 1500);
        for (const c of clients) sse(c, { type: "stopped" });
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
    }
  },
});

writeFileSync(join(sessionDir, "runtime.json"), JSON.stringify({ pid: process.pid, port: studio.port, url: `http://localhost:${studio.port}`, appUrl: mainAppUrl() }, null, 2));
console.log(`UI Studio on http://localhost:${studio.port}`);

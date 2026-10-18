// UI Studio client. Server state arrives over SSE; user actions go out as POSTs.
const $ = (s) => document.querySelector(s);
const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem("uis:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("uis:" + k, JSON.stringify(v)); } catch {} },
};
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

let S = null;
let currentRoute = "";
const prefs = { scope: store.get("scope", null), preset: store.get("preset", "fit") };
const PRESETS = { 1440: [1440, 900], 1024: [1024, 768], 768: [768, 1024], 390: [390, 844] };
const letter = (i) => String.fromCharCode(65 + i);
const scope = () => prefs.scope || S?.target.scope || "isolate";
const ISO_MARGIN = 14; // css px kept around an isolated element for shadows and focus rings

// ---------- live views ----------
// A View is a real instance of the app in an iframe, transformed to frame the target.
// `variant` and `state` reach the page through window.name (read by inject.js).

const views = new Set();
const HEAL_DELAYS = [1500, 3000, 6000, 12000];

class View {
  constructor(host, { url, variant = null, state = null, scope: fixedScope = null, selector, still = false, maxZoom = 3, heal = true, probe = false, group, image = null }) {
    this.host = host;
    this.group = group;
    this.state = state;
    this.selectorOverride = selector;
    this.still = still;
    this.heal = heal;
    this.retries = 0;
    this.errors = probe ? [] : null; // render checks collect errors instead of forwarding them
    this.fixedScope = fixedScope;
    this.maxZoom = maxZoom;
    this.box = h("div", "view" + (still ? " still" : ""));
    host.append(this.box);
    views.add(this);
    if (image) {
      this.img = h("img", "frame");
      this.img.src = image;
      this.box.append(this.img);
      return;
    }
    this.frame = document.createElement("iframe");
    const params = new URLSearchParams();
    if (variant) params.set("v", variant);
    if (state) params.set("s", state);
    if ([...params].length) this.frame.name = "uis:" + params;
    if (still) this.frame.tabIndex = -1;
    this.url = url;
    this.frame.src = url;
    this.backdrop = h("div", "backdrop");
    this.mask = h("div", "mask");
    this.backdrop.hidden = this.mask.hidden = true;
    // The page is never shown until the target has rendered: a 404, a blank or a half-hydrated page stays covered.
    this.cover = h("div", "cover");
    this.cover.append(h("span", "spinner"), h("span", "cover-text"));
    this.box.append(this.backdrop, this.frame, this.mask, this.cover);
    this.showCover(false);
    this.frame.addEventListener("load", () => {
      clearTimeout(this.loadWatch);
      this.loadWatch = setTimeout(() => { if (!this.info) this.missing(); }, 10_000); // page without our script (proxy error, crash)
    });
    this.info = null;
    this.ro = new ResizeObserver(() => (this === live ? layoutAll() : layoutGroup(this.group)));
    this.ro.observe(host);
    layoutGroup(group);
  }
  scope() { return this.fixedScope || scope(); }
  sel() { return this.selectorOverride ?? S?.target.selector ?? ""; }
  setUrl(url) { if (this.frame && url !== this.url) { this.url = url; this.retries = 0; this.reload(); } }
  setImage(src) { if (this.img && this.img.getAttribute("src") !== src) this.img.src = src; }
  reload() { if (this.frame) { this.info = null; this.showCover(false); this.frame.src = this.url; } }
  configure() {
    try { this.frame?.contentWindow?.postMessage({ __uis: true, type: "config", selector: this.sel(), scope: this.scope() }, "*"); } catch {}
  }
  setInfo(d) {
    this.info = d;
    if (d.found || !this.sel()) {
      this.retries = 0;
      clearTimeout(this.healTimer);
      this.healTimer = null;
      this.cover.hidden = true;
    } else this.missing();
  }
  showCover(failed) {
    this.cover.hidden = false;
    this.cover.classList.toggle("failed", failed);
    this.cover.lastElementChild.textContent = failed
      ? (this.still ? "Unavailable" : "This preview can't render the element right now. The agent has been notified.")
      : (this.still ? "" : "Loading preview…");
  }
  // Target missing: reload with backoff (a route that appeared late, a compile error mid-edit), then report once.
  missing() {
    if (!this.frame || this.healTimer) return;
    if (!this.heal) return this.showCover(false);
    if (this.retries >= HEAL_DELAYS.length) {
      this.showCover(true);
      reportPreviewError(`Target ${this.sel()} does not render at ${this.url} after ${HEAL_DELAYS.length} reloads`);
      return;
    }
    this.showCover(false);
    this.healTimer = setTimeout(() => { this.healTimer = null; if (!this.info?.found) this.reload(); }, HEAL_DELAYS[this.retries++]);
  }
  measure() {
    const W = this.host.clientWidth, H = this.host.clientHeight;
    const pr = PRESETS[prefs.preset];
    // Every view lays the page out at the main preview's viewport, so small tiles only scale, never reflow.
    const vp = live?.frame && live !== this ? live.host : this.host;
    let p = pr ? { w: pr[0], h: pr[1] } : { w: Math.max(vp.clientWidth, 1), h: Math.max(vp.clientHeight, 1) };
    const i = this.info;
    const sc = this.scope();
    if (!i || !i.found || i.page || sc === "page") return { mode: "page", W, H, p, s: Math.min(1, W / p.w, H / p.h) };
    // A target larger than the frame's layout viewport would be cut off at the frame's edge: grow the frame to
    // contain it (height always, width only without a fixed width preset), then scale to fit as usual. Skipped
    // for elements that size themselves to the viewport (a 100vh hero would grow with the frame), and capped.
    const cur = this.frameSize || p, need = { w: i.rect.x + i.rect.w + 24, h: i.rect.y + i.rect.h + 24 };
    if (need.h > p.h && Math.abs(i.rect.h - cur.h) > 2) p = { ...p, h: Math.min(Math.ceil(need.h), p.h * 4) };
    if (!pr && need.w > p.w && Math.abs(i.rect.w - cur.w) > 2) p = { ...p, w: Math.min(Math.ceil(need.w), p.w * 4) };
    const iso = sc === "isolate";
    const pad = iso ? Math.max(12, Math.min(72, Math.min(W, H) * 0.12)) : Math.max(20, Math.min(96, Math.min(W, H) * 0.16));
    const m = iso ? ISO_MARGIN : 0;
    const r = i.rect;
    const fit = (rect) => Math.max(0.1, Math.min(this.maxZoom, (W - 2 * pad) / Math.max(rect.w + 2 * m, 1), (H - 2 * pad) / Math.max(rect.h + 2 * m, 1)));
    return { mode: iso ? "iso" : "el", W, H, p, r, fit, s: fit(r) };
  }
  apply(m, s, bench) {
    const f = this.frame;
    f.style.width = m.p.w + "px";
    f.style.height = m.p.h + "px";
    this.frameSize = m.p;
    const look = m.mode === "iso" ? this.info.look : null;
    this.box.classList.toggle("el", m.mode !== "page");
    this.box.classList.toggle("iso", m.mode === "iso");
    // Isolated: transparent page on a workbench whose tone contrasts with the element.
    if (look) this.box.dataset.bench = bench || look.bench;
    else delete this.box.dataset.bench;
    f.style.colorScheme = look ? look.colorScheme : "";
    let tx, ty;
    this.mask.hidden = this.backdrop.hidden = true;
    f.style.clipPath = "";
    if (m.mode === "page") {
      tx = Math.max(0, (m.W - m.p.w * s) / 2);
      ty = Math.max(0, (m.H - m.p.h * s) / 2);
    } else {
      const r = m.r;
      const c = m.c || r; // framing rect: own element, or the shared one in a wipe
      tx = m.W / 2 - s * (c.x + c.w / 2);
      ty = m.H / 2 - s * (c.y + c.h / 2);
      if (m.mode === "el") {
        this.mask.hidden = false;
        Object.assign(this.mask.style, { left: tx + s * r.x - 6 + "px", top: ty + s * r.y - 6 + "px", width: s * r.w + 12 + "px", height: s * r.h + 12 + "px" });
      } else {
        const g = ISO_MARGIN;
        f.style.clipPath = `inset(${r.y - g}px ${m.p.w - r.x - r.w - g}px ${m.p.h - r.y - r.h - g}px ${r.x - g}px)`;
        const k = 8; // backdrop margin: just enough to read as the surface the element sits on
        // Not self-contained (no own background or border): show only the color it normally sits on.
        if (look.backdrop) {
          this.backdrop.hidden = false;
          Object.assign(this.backdrop.style, {
            left: tx + s * (r.x - k) + "px", top: ty + s * (r.y - k) + "px",
            width: s * (r.w + 2 * k) + "px", height: s * (r.h + 2 * k) + "px", background: look.backdrop,
          });
        }
      }
    }
    f.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  }
  destroy() { clearTimeout(this.healTimer); clearTimeout(this.loadWatch); this.ro?.disconnect(); views.delete(this); this.box.remove(); }
}

// Views in one group share a zoom level so variants and states are compared at the same scale.
function layoutGroup(g) {
  const vs = [...views].filter((v) => v.group === g && v.frame);
  if (!vs.length) return;
  const ms = vs.map((v) => v.measure());
  const el = ms.filter((m) => m.mode !== "page");
  // A wipe overlays two layers, so both frame the union of their elements: same scale, same offset.
  if (g === "wipe" && el.length) {
    const x = Math.min(...el.map((m) => m.r.x)), y = Math.min(...el.map((m) => m.r.y));
    const u = { x, y, w: Math.max(...el.map((m) => m.r.x + m.r.w)) - x, h: Math.max(...el.map((m) => m.r.y + m.r.h)) - y };
    for (const m of el) { m.c = u; m.s = m.fit(u); }
  }
  const common = el.length ? Math.min(...el.map((m) => m.s)) : 0;
  // One bench tone per group so tiles read as one set: the tone whose worst contrast across the tiles is best.
  const lums = vs.map((v) => v.info?.look?.lum).filter((l) => l != null);
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const bench = lums.length
    ? (Math.min(...lums.map((l) => ratio(l, 0.007))) >= Math.min(...lums.map((l) => ratio(l, 0.83))) ? "dark" : "light")
    : undefined;
  vs.forEach((v, i) => v.apply(ms[i], ms[i].mode !== "page" ? common : ms[i].s, bench));
}
const layoutAll = () => new Set([...views].map((v) => v.group)).forEach(layoutGroup);
const configureAll = () => views.forEach((v) => v.configure());

addEventListener("message", (e) => {
  const d = e.data;
  if (!d || !d.__uis) return;
  const v = [...views].find((v) => v.frame && v.frame.contentWindow === e.source);
  if (!v) return;
  if (d.type === "ready") { v.info = null; v.configure(); if (v === live) setRoute(d.url); }
  else if (d.type === "rect") { v.setInfo(d); layoutGroup(v.group); if (v === live) renderStates(); }
  else if (d.type === "nav" && v === live) setRoute(d.url);
  else if (d.type === "dom") v.onDom?.(d.html);
  else if (d.type === "error") {
    if (v.errors) v.errors.push(d.message);
    else forwardError(d.message, `${v.group}${v.state ? ` (${v.state})` : ""} ${d.where || ""}`.trim());
  }
});

// Errors from previews go to the agent through the server; each message at most every 30s.
const sentErrors = new Map();
function forwardError(message, where) {
  const key = message.slice(0, 200);
  if (Date.now() - (sentErrors.get(key) || 0) < 30_000) return;
  sentErrors.set(key, Date.now());
  post("/api/page-error", { message, where });
}
const sentPreviewErrors = new Set();
function reportPreviewError(message) {
  if (sentPreviewErrors.has(message)) return;
  sentPreviewErrors.add(message);
  post("/api/preview-error", { message });
}

// Render check requested by the server before a target switch or checkpoint: render the target
// off-screen in every state and report whether it appears and which errors the page logged.
// Asks a view's page for its target as frozen HTML (see inject.js); null if it can't.
function serializeView(v) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { v.onDom = null; resolve(null); }, 5000);
    v.onDom = (html) => { clearTimeout(t); v.onDom = null; resolve(html); };
    try { v.frame.contentWindow.postMessage({ __uis: true, type: "serialize" }, "*"); } catch { clearTimeout(t); resolve(null); }
  });
}

// With `capture` (checkpoints and the original), each rendered state is also frozen for before/after.
function runProbe({ id, target, states, capture }) {
  const host = $("#probeHost");
  host.style.width = (live?.host.clientWidth || 1000) + "px";
  host.style.height = (live?.host.clientHeight || 700) + "px";
  Promise.all(states.map((st) => new Promise((resolve) => {
    const cell = h("div", "probe-cell");
    host.append(cell);
    const v = new View(cell, {
      url: S.config.appUrl + target.route, state: st.id, scope: target.scope, selector: target.selector,
      still: true, heal: false, probe: true, group: "probe:" + id,
    });
    let done = false;
    const finish = (found) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      // After it renders, keep listening briefly: hydration errors arrive right after.
      setTimeout(async () => {
        const errors = [...new Set(v.errors)].slice(0, 5);
        const dom = capture && found ? await serializeView(v) : null;
        v.destroy();
        cell.remove();
        resolve({ label: st.label, state: st.id, found, errors, dom });
      }, found ? 1500 : 0);
    };
    const poll = setInterval(() => { if (v.info && (v.info.found || !target.selector)) finish(true); }, 150);
    const timer = setTimeout(() => finish(false), 25_000);
  }))).then((results) => post(`/api/probe/${id}`, { results }));
}

function setRoute(url) {
  currentRoute = url;
  $("#route").textContent = `${url}${S?.target.selector ? "  ·  " + S.target.selector : ""}`;
  if (S?.config.appUrl) $("#openBtn").href = S.config.appUrl + url;
}

// ---------- render ----------

let live = null;
let lastTarget = "";
// What the live preview and the state tiles render: the app, or a variant the user just picked (until the agent has
// made it the real code).
const source = () => {
  const p = S.preview;
  return { appUrl: p?.appUrl || S.config.appUrl, variant: p?.switch ? p.id : null };
};
let liveVariant = null;
let liveSwapping = false;

// Each rework gets its own color from its title, so several studio windows are easy to tell apart.
let identity = "";
function applyIdentity(title) {
  if (title === identity) return;
  identity = title;
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + ch.codePointAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  const color = `hsl(${hue} 70% 55%)`;
  document.documentElement.style.setProperty("--rework", color);
  const initial = (title.match(/[\p{L}\p{N}]/u) || ["U"])[0].toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${color}"/><text x="32" y="44" font-family="system-ui,sans-serif" font-size="34" font-weight="700" text-anchor="middle" fill="#fff">${initial}</text></svg>`;
  $("#favicon").href = "data:image/svg+xml," + encodeURIComponent(svg);
  $("#logo").textContent = initial;
}

function render() {
  const c = S.config;
  $("#title").textContent = c.title;
  document.title = `${c.title} · UI Studio`;
  applyIdentity(c.title);
  if (!currentRoute) setRoute(S.target.route);
  renderLive();
  renderStates();
  renderCompare();
  renderChat();
  renderStatus();
  renderCards();
  renderPill();
  renderSegs();
  $("#beforeAfterBtn").disabled = !S.snapshots.some((s) => s.id === "s0");
  $("#beforeAfterBtn").title = $("#beforeAfterBtn").disabled ? "Available after the agent starts editing" : "Slide between the current version and the last checkpoint";
}

function renderLive() {
  const host = $("#live");
  if (S.config.mode === "frames") {
    const src = (S.preview && (S.preview.frame || S.frames[S.preview.id])) || S.frames.live;
    if (!src) { if (!host.querySelector(".empty")) host.replaceChildren(h("div", "empty", "Waiting for the first frame from the device…")); return; }
    if (!live) { host.replaceChildren(); live = new View(host, { image: src, group: "live" }); }
    else live.setImage(src);
    return;
  }
  const { appUrl, variant } = source();
  const url = appUrl + S.target.route;
  if (!live) { live = new View(host, { url, variant, group: "live" }); liveVariant = variant; }
  else if (variant !== liveVariant || url !== live.url) swapLive(url, variant);
  const t = JSON.stringify(S.target);
  if (t !== lastTarget) {
    lastTarget = t;
    views.forEach((v) => { v.retries = 0; });
    configureAll();
    setRoute(currentRoute || S.target.route);
  }
}

// A new variant (or app) is built over the current preview and shown once it has rendered, so a pick shows up
// without a loading flash. Compare stays up until then (see renderCompare).
function swapLive(url, variant) {
  liveVariant = variant;
  liveSwapping = true;
  const fresh = new View($("#live"), { url, variant, group: "live" });
  fresh.box.style.opacity = "0";
  live = fresh;
  const t0 = Date.now();
  const reveal = () => {
    if (live !== fresh) return; // superseded by a newer swap
    if (!fresh.info?.found && Date.now() - t0 < 3000) return void setTimeout(reveal, 40);
    fresh.box.style.opacity = "";
    [...views].filter((v) => v.group === "live" && v !== fresh).forEach((v) => v.destroy());
    liveSwapping = false;
    renderCompare();
  };
  reveal();
}

// ---------- UX states ----------
// Live tiles of the target in each state, always next to the main preview.
// Pseudo states (hover, focus, active) are forced by inject.js; others are rendered by the workbench via __UIS_STATE.

const AUTO_STATES = [{ id: "hover", label: "Hover" }, { id: "focus", label: "Focus" }, { id: "active", label: "Pressed" }];
let statesKey = "";

function stateList() {
  if (!S || S.config.mode === "frames" || S.statesMode === "single") return [];
  if (S.states?.length) return S.states;
  return live?.info?.interactive ? AUTO_STATES : [];
}

function renderStates() {
  if (!S) return;
  const list = stateList();
  const src = source();
  const key = JSON.stringify([list, src, S.target.route, S.target.selector]);
  if (key === statesKey) return;
  statesKey = key;
  [...views].filter((v) => v.group === "states").forEach((v) => v.destroy());
  const box = $("#states");
  box.replaceChildren();
  box.hidden = !list.length;
  renderStateSelect(list);
  for (const st of list.length ? [{ id: null, label: "Default" }, ...list] : []) {
    const slot = h("div", "st-slot");
    const t = h("div", "st-tile");
    const stage = h("div", "st-stage");
    slot.title = `${st.label}: hover to enlarge, click to open`;
    slot.onclick = () => openStatePop(st.id);
    t.append(h("span", "st-label", st.label), stage);
    slot.append(t);
    box.append(slot);
    requestAnimationFrame(() => new View(stage, { url: src.appUrl + S.target.route, variant: src.variant, state: st.id, scope: "isolate", still: true, group: "states" }));
  }
}

// Near-fullscreen view of one state, with chips (and arrow keys) to switch between states.
let popState;
const popList = () => [{ id: null, label: "Default" }, ...stateList()];

function openStatePop(id) {
  const list = popList();
  const st = list.find((s) => s.id === id) || list[0];
  popState = st.id;
  const pop = $("#statePop");
  const opening = pop.hidden;
  pop.hidden = false;
  $("#spTitle").textContent = st.label;
  $("#spChips").replaceChildren(...list.map((s) => {
    const b = h("button", s.id === st.id ? "on" : "", s.label);
    b.onclick = () => openStatePop(s.id);
    return b;
  }));
  // The previous state stays up (or the popup stays invisible) until the new one has rendered,
  // so opening and stepping never flash the loading cover. Views overlap: .view is absolute.
  const old = [...views].filter((v) => v.group === "pop");
  const src = source();
  const view = new View($("#spStage"), { url: src.appUrl + S.target.route, variant: src.variant, state: st.id, scope: "isolate", still: true, maxZoom: 4, group: "pop" });
  view.box.style.opacity = "0";
  if (opening) pop.style.opacity = "0";
  const t0 = Date.now();
  const reveal = () => {
    if (!views.has(view)) return;
    if (!view.info?.found && Date.now() - t0 < 1500) return void setTimeout(reveal, 30);
    view.box.style.opacity = "";
    pop.style.opacity = "";
    old.forEach((v) => v.destroy());
  };
  reveal();
}
function closeStatePop() {
  $("#statePop").hidden = true;
  $("#statePop").style.opacity = "";
  [...views].filter((v) => v.group === "pop").forEach((v) => v.destroy());
}
function stepStatePop(dir) {
  const list = popList();
  const i = list.findIndex((s) => s.id === popState);
  openStatePop(list[(i + dir + list.length) % list.length].id);
}
$("#spClose").onclick = closeStatePop;
$("#statePop").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeStatePop(); });

function renderStateSelect(list) {
  const sel = $("#cmpState");
  sel.replaceChildren(...[{ id: "", label: "Interactive" }, ...list].map((st) => { const o = h("option", null, st.label); o.value = st.id; return o; }));
  if (!list.some((st) => st.id === cmpState)) cmpState = null;
  sel.value = cmpState || "";
  $("#cmpStateWrap").hidden = !list.length;
}

// ---------- compare ----------

let cmpKey = "";
let cmpState = null;
let sliderSel = null;
let wipePos = store.get("wipe", 50);

let cmpPending = null; // tiles being built on top of the current ones (see renderCompare)
const cmpViews = (body) => [...views].filter((v) => (v.group === "cmp" || v.group === "wipe") && body.contains(v.host));

function renderCompare() {
  const c = S.compare;
  if (!c && liveSwapping && cmpKey) return; // a pick is loading in the live preview: compare stays up until it shows
  $("#compare").hidden = !c;
  const key = c ? JSON.stringify([c, sliderSel, cmpState]) : "";
  if (key === cmpKey) return;
  const sameSet = c && cmpKey && cmpKey.startsWith(JSON.stringify([c, sliderSel]).slice(0, -1) + ",");
  const opening = c && !cmpKey;
  cmpKey = key;
  if (cmpPending) { cmpViews(cmpPending).forEach((v) => v.destroy()); cmpPending.remove(); cmpPending = null; }
  const old = $("#cmpBody");
  if (!sameSet) {
    cmpViews(old).forEach((v) => v.destroy());
    old.replaceChildren();
    if (c) fillCompare(c, old);
    if (opening) revealWhenRendered($("#compare"), old, key);
    return;
  }
  // Only the state changed: build the new tiles over the old ones and swap once they have rendered,
  // so the grid never flashes empty while every tile reloads.
  const body = old.cloneNode(false);
  body.removeAttribute("id");
  Object.assign(body.style, { position: "absolute", left: old.offsetLeft + "px", top: old.offsetTop + "px", width: old.offsetWidth + "px", height: old.offsetHeight + "px", opacity: "0" });
  old.after(body);
  cmpPending = body;
  fillCompare(c, body);
  const t0 = Date.now();
  const swap = () => {
    if (cmpPending !== body) return; // superseded by a newer change
    const fresh = cmpViews(body); // tiles create their views on the next frame
    if (!(fresh.length && fresh.every((v) => v.img || v.info?.found)) && Date.now() - t0 < 4000) return void setTimeout(swap, 60);
    cmpPending = null;
    cmpViews(old).forEach((v) => v.destroy());
    old.remove();
    body.id = "cmpBody";
    body.removeAttribute("style");
    fitGrid(body);
  };
  swap();
}

// A freshly opened compare stays invisible until its tiles have rendered (at most 3s), like the state popup.
function revealWhenRendered(el, body, key) {
  el.style.opacity = "0";
  const t0 = Date.now();
  const check = () => {
    const vs = cmpViews(body);
    if (cmpKey === key && !(vs.length && vs.every((v) => v.img || v.info?.found)) && Date.now() - t0 < 3000) return void setTimeout(check, 40);
    el.style.opacity = "";
  };
  check();
}

function fillCompare(c, body) {
  $("#cmpTitle").textContent = c.title;
  body.className = "cmp-body lay-" + c.layout;
  const slider = c.layout === "slider";
  $("#sliderPick").hidden = !slider || c.variants.length < 3;
  // Before/after: the checkpoint on the left can be any other one.
  const ba = c.mode === "before_after";
  $("#baPick").hidden = !ba;
  if (ba) {
    const sel = $("#baBefore");
    sel.replaceChildren(...S.snapshots.filter((x) => x.dom?.length).map((x) => {
      const o = h("option", null, x.id === "s0" ? "Original" : `${x.id} · ${x.label}`);
      o.value = x.id;
      return o;
    }));
    sel.value = c.before;
  }
  if (slider) renderWipe(c, body);
  else c.variants.forEach((v, i) => body.append(tile(v, i)));
  fitGrid(body);
}

// Grid: up to 3 variants in one row; from 4 on, rows and columns, picking the column count that gives every
// tile the largest preview at the main preview's aspect ratio.
const TILE_HEAD = 36, GAP = 10;
function fitGrid(body = $("#cmpBody")) {
  if (!body.classList.contains("lay-grid")) { body.style.removeProperty("--cols"); body.style.removeProperty("--rows"); return; }
  const n = body.children.length;
  let best = { cols: n, rows: 1 };
  if (n > 3) {
    const W = body.clientWidth - GAP, H = body.clientHeight - GAP;
    const a = (live?.host.clientWidth || 16) / (live?.host.clientHeight || 9);
    let bestScale = -1;
    for (let cols = 2; cols < n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = W / cols - GAP, h = H / rows - GAP - TILE_HEAD;
      const scale = Math.min(w / a, h);
      if (scale > bestScale) { bestScale = scale; best = { cols, rows }; }
    }
  }
  body.style.setProperty("--cols", best.cols);
  body.style.setProperty("--rows", best.rows);
}
new ResizeObserver(() => fitGrid()).observe($("#compare"));

const variantUrl = (v) => v.appUrl + (currentRoute || S.target.route);
const variantImage = (v) => (S.config.mode === "frames" ? v.frame || S.frames[v.id] || null : null);
// With a state picked, tiles show that state and are not interactive; otherwise they are fully live.
const variantView = (host, v, group = "cmp") => v.dom
  // A checkpoint frozen by the studio: static HTML of the target in the chosen state.
  ? new View(host, { url: `${v.appUrl}/__uis/dom/${v.dom}/${cmpState || "default"}.html`, selector: "[data-uis-snap-root]", still: !!cmpState, group })
  : new View(host, { url: variantUrl(v), variant: v.switch ? v.id : null, state: cmpState, still: !!cmpState, group, image: variantImage(v) });
$("#cmpState").onchange = (e) => { cmpState = e.target.value || null; renderCompare(); };

function variantActions(v) {
  const frag = document.createDocumentFragment();
  const comment = h("button", "btn ghost small", "Comment");
  comment.onclick = () => addAbout(v);
  frag.append(comment);
  if (S.compare?.mode === "before_after") return frag; // nothing to pick: one side is a frozen checkpoint
  const pick = h("button", "btn primary small", "Use this");
  pick.onclick = () => post("/api/pick", { id: v.id });
  frag.append(pick);
  return frag;
}

function tile(v, i) {
  const t = h("div", "tile");
  const head = h("div", "tile-head");
  head.append(h("span", "badge", letter(i)), h("span", "tile-label", v.label), h("span", "spacer"), variantActions(v));
  const stage = h("div", "tile-stage");
  t.append(head, stage);
  requestAnimationFrame(() => variantView(stage, v));
  return t;
}

function renderWipe(c, body) {
  const ids = c.variants.map((v) => v.id);
  if (!sliderSel || !ids.includes(sliderSel[0]) || !ids.includes(sliderSel[1])) sliderSel = [ids[0], ids[1] || ids[0]];
  for (const [sel, idx] of [[$("#sliderA"), 0], [$("#sliderB"), 1]]) {
    sel.replaceChildren(...c.variants.map((v, i) => { const o = h("option", null, `${letter(i)} · ${v.label}`); o.value = v.id; return o; }));
    sel.value = sliderSel[idx];
    sel.onchange = () => { sliderSel = [$("#sliderA").value, $("#sliderB").value]; renderCompare(); };
  }
  const a = c.variants.find((v) => v.id === sliderSel[0]);
  const b = c.variants.find((v) => v.id === sliderSel[1]);
  const wipe = h("div", "wipe");
  const bottom = h("div", "layer");
  const top = h("div", "layer top");
  const handle = h("div", "wipe-handle");
  const la = h("div", "wipe-label l");
  la.append(h("span", "badge", letter(ids.indexOf(a.id))), h("span", null, a.label), variantActions(a));
  const lb = h("div", "wipe-label r");
  lb.append(h("span", "badge", letter(ids.indexOf(b.id))), h("span", null, b.label), variantActions(b));
  wipe.append(bottom, top, handle, la, lb);
  body.append(wipe);
  const place = () => { top.style.clipPath = `inset(0 ${100 - wipePos}% 0 0)`; handle.style.left = wipePos + "%"; };
  place();
  handle.addEventListener("pointerdown", (e) => {
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("dragging");
    const move = (ev) => { const r = wipe.getBoundingClientRect(); wipePos = Math.min(100, Math.max(0, ((ev.clientX - r.left) / r.width) * 100)); place(); };
    const up = () => { document.body.classList.remove("dragging"); store.set("wipe", wipePos); handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  requestAnimationFrame(() => {
    variantView(bottom, b, "wipe");
    variantView(top, a, "wipe");
  });
}

$("#layoutSeg").addEventListener("click", (e) => { const v = e.target.closest("button")?.dataset.v; if (v) post("/api/compare-layout", { layout: v }); });
$("#cmpClose").onclick = () => post("/api/compare-close");

// ---------- chat ----------

const selected = new Set();
let chatKey = "";
let lastCount = 0;

function md(src) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<em>$2</em>");
  const out = [];
  const blocks = src.split(/```/);
  blocks.forEach((b, i) => {
    if (i % 2) { out.push(`<pre><code>${esc(b.replace(/^\w*\n/, ""))}</code></pre>`); return; }
    for (const para of b.split(/\n{2,}/)) {
      const lines = para.split("\n").filter((l) => l.trim());
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*[-*] /.test(l))) out.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`);
      else out.push(`<p>${lines.map(inline).join("<br>")}</p>`);
    }
  });
  return out.join("");
}

function renderChat() {
  const key = JSON.stringify([S.messages.map((m) => [m.id, m.delivered]), S.current, [...selected], S.config.brief]);
  if (key === chatKey) return;
  chatKey = key;
  const chat = $("#chat");
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
  chat.replaceChildren();
  if (!S.messages.length) {
    chat.append(h("div", "intro", S.config.brief ? `Starting direction: ${S.config.brief}` : "Tell the agent what to change, or pick a suggestion below the preview. You can interrupt at any time."));
  }
  for (const m of S.messages) {
    if (m.role === "snapshot") { chat.append(snapRow(m)); continue; }
    const el = h("div", "msg " + m.role);
    if (m.role === "agent") el.innerHTML = md(m.text);
    else {
      if (m.about?.length) el.append(h("div", "about", "re: " + m.about.map((a) => a.label).join(", ")));
      if (m.text) el.append(h("div", null, m.text));
      if (m.attachments?.length) {
        const atts = h("div", "atts");
        for (const a of m.attachments) {
          if ((a.type || "").startsWith("image/")) { const img = h("img"); img.src = a.url; img.alt = a.name; atts.append(img); }
          else atts.append(h("span", "file", a.name));
        }
        el.append(atts);
      }
      if (m.role === "user" && m.delivered === false) {
        if (m.steer) el.append(h("span", "queued", "Steering, the agent reads it at its next step"));
        else {
          // New requests wait their turn; until the agent picks one up it can be removed.
          const n = S.messages.filter((x) => x.role === "user" && x.delivered === false && !x.steer).findIndex((x) => x.id === m.id) + 1;
          const q = h("span", "queued", `Queued #${n}, runs after the current request · `);
          const rm = h("button", "unqueue", "Remove");
          rm.onclick = () => post("/api/unqueue", { id: m.id });
          q.append(rm);
          el.append(q);
        }
      }
    }
    chat.append(el);
  }
  if (nearBottom || S.messages.length !== lastCount) chat.scrollTop = chat.scrollHeight;
  lastCount = S.messages.length;
  renderCompareSel();
}

function snapRow(m) {
  const id = m.snapshotId;
  const row = h("div", "snap" + (S.current === id ? " current" : ""));
  const lbl = h("span", "lbl");
  lbl.append(h("small", null, id), document.createTextNode(m.text));
  const cb = h("input");
  cb.type = "checkbox";
  cb.checked = selected.has(id);
  cb.onchange = () => { cb.checked ? selected.add(id) : selected.delete(id); chatKey = ""; renderChat(); };
  const lab = h("label");
  lab.append(cb, document.createTextNode("compare"));
  const restore = h("button", "btn ghost small", S.current === id ? "Current" : "Restore");
  restore.disabled = S.current === id;
  restore.onclick = () => post("/api/restore", { id });
  row.append(h("span", "dot"), lbl, lab, restore);
  return row;
}

function renderCompareSel() {
  const btn = $("#compareSelBtn");
  btn.hidden = selected.size === 0;
  btn.textContent = selected.size === 1 ? "Compare with current" : `Compare ${selected.size}`;
}
$("#compareSelBtn").onclick = () => {
  const ids = [...selected];
  if (ids.length === 1) ids.push("live");
  post("/api/compare-request", { ids, mode: "compare" });
  selected.clear();
  chatKey = "";
  renderChat();
};
$("#beforeAfterBtn").onclick = () => post("/api/before-after", {});
$("#baBefore").onchange = (e) => post("/api/before-after", { before: e.target.value });

// ---------- status, suggestions, agent ----------

function renderStatus() {
  const st = S.status;
  const el = $("#status");
  const working = st.phase === "working";
  el.replaceChildren();
  el.classList.toggle("working", working);
  let plain;
  if (working) {
    el.append(h("span", "spinner"));
    if (st.focus) el.append(h("span", "focus-tag", st.focus));
    el.append(h("span", null, st.text || "Working…"));
    plain = st.text || "Working…";
  } else if (S.agent === "away") {
    // Messages stay queued; the main thread relaunches the agent when it ends.
    plain = "Reconnecting to Claude…";
    el.append(h("span", "spinner"), h("span", null, plain));
  } else {
    plain = S.suggestions.length ? "Ready. Pick a next step or type a prompt." : "Ready. Describe what you want to change.";
    el.append(h("span", null, plain));
  }
  const fsStatus = $("#floatStatus");
  fsStatus.replaceChildren();
  if (working) fsStatus.append(h("span", "spinner"));
  fsStatus.append(h("span", null, plain));
  $("#stopBtn").hidden = !working;
  // While the agent works, Enter queues a new request and Steer (⌘↵) adjusts the current one.
  $("#steerBtn").hidden = !working;
  $("#sendBtn").textContent = working ? "Queue" : "Send";
}

let shownCards = new Set();
function renderCards() {
  const box = $("#cards");
  const texts = S.suggestions.map((s) => s.text);
  if (texts.join("\n") === [...shownCards].join("\n")) return;
  box.replaceChildren(...texts.map((t) => {
    const b = h("button", "card" + (shownCards.has(t) ? "" : " new"), t);
    b.title = "Click to send. Shift+click to edit before sending.";
    b.onclick = (e) => {
      if (e.shiftKey || e.altKey) { input.value = t; autosize(); input.focus(); }
      else send(t, [], [], S.status.phase === "working"); // a card clicked mid-work steers the current step
    };
    return b;
  }));
  shownCards = new Set(texts);
}

function renderPill() {
  const pill = $("#agentPill");
  pill.className = "pill " + S.agent;
  pill.lastElementChild.textContent = { listening: "Agent listening", working: "Agent working", away: "Reconnecting" }[S.agent];
}

function renderSegs() {
  for (const b of $("#scopeSeg").children) b.classList.toggle("on", b.dataset.v === scope());
  for (const b of $("#presetSeg").children) b.classList.toggle("on", b.dataset.v === prefs.preset);
  if (S.compare) for (const b of $("#layoutSeg").children) b.classList.toggle("on", b.dataset.v === S.compare.layout);
}

$("#scopeSeg").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.v;
  if (!v) return;
  prefs.scope = v;
  store.set("scope", v);
  renderSegs();
  configureAll();
  layoutAll();
});
$("#presetSeg").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.v;
  if (!v) return;
  prefs.preset = v;
  store.set("preset", v);
  renderSegs();
  layoutAll();
});
$("#reloadBtn").onclick = () => views.forEach((v) => v.reload());

let finishArmed = null;
$("#finishBtn").onclick = () => {
  const b = $("#finishBtn");
  if (finishArmed) {
    clearTimeout(finishArmed); finishArmed = null; b.classList.remove("armed"); b.textContent = "Finish";
    // Claude wraps up in the background and reports in the terminal; the server closes this window.
    post("/api/finish").finally(() => closeWindow("Finished. Claude is wrapping up and will summarize in your terminal."));
    return;
  }
  b.classList.add("armed");
  b.textContent = "Confirm finish";
  finishArmed = setTimeout(() => { finishArmed = null; b.classList.remove("armed"); b.textContent = "Finish"; }, 3000);
};
$("#stopBtn").onclick = () => post("/api/interrupt");

// ---------- composer ----------

const input = $("#input");
const draft = { files: [], about: [] };

function autosize() { input.style.height = "auto"; input.style.height = Math.min(160, input.scrollHeight) + "px"; }
input.addEventListener("input", autosize);

function renderChips() {
  const box = $("#chips");
  box.replaceChildren();
  draft.about.forEach((a, i) => {
    const c = h("span", "chip");
    c.append(h("span", "badge", "re"), h("span", null, a.label));
    const x = h("button", null, "×");
    x.type = "button";
    x.onclick = () => { draft.about.splice(i, 1); renderChips(); };
    c.append(x);
    box.append(c);
  });
  draft.files.forEach((f, i) => {
    const c = h("span", "chip");
    if (f.type.startsWith("image/")) { const img = h("img"); img.src = URL.createObjectURL(f); c.append(img); }
    c.append(h("span", null, f.name || "image"));
    const x = h("button", null, "×");
    x.type = "button";
    x.onclick = () => { draft.files.splice(i, 1); renderChips(); };
    c.append(x);
    box.append(c);
  });
}

function addFiles(list) {
  for (const f of list) draft.files.push(f.name ? f : new File([f], `pasted-${Date.now()}.png`, { type: f.type }));
  renderChips();
}
function addAbout(v) {
  if (!draft.about.some((a) => a.id === v.id)) draft.about.push({ id: v.id, label: v.label });
  renderChips();
  if (document.querySelector(".app.fs")) showFloat(true);
  input.focus();
}

async function send(text, files, about, steer = false) {
  if (!text.trim() && !files.length) return;
  const fd = new FormData();
  fd.append("text", text);
  fd.append("steer", steer ? "1" : "0");
  fd.append("about", JSON.stringify(about));
  for (const f of files) fd.append("files", f, f.name);
  await fetch("/api/prompt", { method: "POST", body: fd });
}

function submitDraft(steer) {
  const text = input.value;
  if (!text.trim() && !draft.files.length) return;
  send(text, draft.files, draft.about, steer && S.status.phase === "working");
  input.value = "";
  draft.files = [];
  draft.about = [];
  renderChips();
  autosize();
}
$("#composer").addEventListener("submit", (e) => { e.preventDefault(); submitDraft(false); });
$("#steerBtn").onclick = () => submitDraft(true);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitDraft(e.metaKey || e.ctrlKey); }
});
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
$("#attachBtn").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; $("#dropHint").hidden = false; document.body.classList.add("dragging"); } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#dropHint").hidden = true; document.body.classList.remove("dragging"); } });
addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("#dropHint").hidden = true;
  document.body.classList.remove("dragging");
  addFiles(e.dataTransfer.files);
});

// ---------- fullscreen + floating prompt ----------

const app = $("#app");
const float = $("#float");
let floatHidden = false;

function setFs(on) {
  app.classList.toggle("fs", on);
  (on ? $("#floatSlot") : $("#dock")).append($("#composer"));
  if (on) { floatHidden = false; placeFloat(); }
  float.hidden = !on || floatHidden;
  $("#floatShow").hidden = !on || !floatHidden;
}
function showFloat(show) {
  floatHidden = !show;
  float.hidden = !show;
  $("#floatShow").hidden = show;
  if (show) { placeFloat(); input.focus(); }
}
function placeFloat(pos = store.get("floatPos", null)) {
  const w = float.offsetWidth || 560, hgt = float.offsetHeight || 120;
  const p = pos || { x: (innerWidth - w) / 2, y: innerHeight - hgt - 28 };
  float.style.left = Math.min(Math.max(8, p.x), innerWidth - w - 8) + "px";
  float.style.top = Math.min(Math.max(8, p.y), innerHeight - hgt - 8) + "px";
}
addEventListener("resize", () => { if (!float.hidden) placeFloat(); });

$("#fsBtn").onclick = () => setFs(true);
$("#fsExit").onclick = () => setFs(false);
$("#floatHide").onclick = () => showFloat(false);
$("#floatShow").onclick = () => showFloat(true);

$("#floatHandle").addEventListener("pointerdown", (e) => {
  if (e.target.closest("button")) return;
  const h0 = $("#floatHandle");
  h0.setPointerCapture(e.pointerId);
  document.body.classList.add("dragging");
  const r = float.getBoundingClientRect();
  const dx = e.clientX - r.left, dy = e.clientY - r.top;
  const move = (ev) => placeFloat({ x: ev.clientX - dx, y: ev.clientY - dy });
  const up = () => {
    document.body.classList.remove("dragging");
    store.set("floatPos", { x: parseFloat(float.style.left), y: parseFloat(float.style.top) });
    h0.removeEventListener("pointermove", move);
    h0.removeEventListener("pointerup", up);
  };
  h0.addEventListener("pointermove", move);
  h0.addEventListener("pointerup", up);
});

addEventListener("keydown", (e) => {
  const typing = e.target.closest?.("textarea, input, select");
  const fs = app.classList.contains("fs");
  if (!$("#statePop").hidden) {
    if (e.key === "Escape") { e.preventDefault(); closeStatePop(); }
    else if (e.key === "ArrowRight" && !typing) stepStatePop(1);
    else if (e.key === "ArrowLeft" && !typing) stepStatePop(-1);
    return;
  }
  if (e.key === "Escape" && fs) { setFs(false); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "f") { e.preventDefault(); setFs(!fs); }
  else if (e.key === "h" && fs) { e.preventDefault(); showFloat(floatHidden); }
});

// ---------- connection ----------

// The server closes the app window; this covers a regular browser tab, where it can't.
function closeWindow(text) {
  $("#ended").firstElementChild.textContent = `${text} You can close this window.`;
  $("#ended").hidden = false;
  window.close();
}

const es = new EventSource("/events");
es.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.type === "state") { S = d.state; render(); }
  else if (d.type === "probe") runProbe(d);
  else if (d.type === "stopped") { es.close(); closeWindow("Session ended."); }
};
es.onerror = () => {
  const pill = $("#agentPill");
  pill.className = "pill away";
  pill.lastElementChild.textContent = "Studio disconnected";
};

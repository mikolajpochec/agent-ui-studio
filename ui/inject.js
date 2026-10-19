// Injected into every proxied app page. Runs before the app's own scripts.
// - exposes the variant and UX state this frame renders (window.__UIS_VARIANT / __UIS_STATE, :root attributes)
// - forces pseudo-class states (hover, focus, active) on the target for state previews
// - scopes the view to the target element and reports its rect and look to the studio
// - live-reloads static pages
(() => {
  if (window.__uisInjected) return;
  window.__uisInjected = true;

  const root = document.documentElement;
  const params = new URLSearchParams(window.name.startsWith("uis:") ? window.name.slice(4) : "");
  const variant = params.get("v");
  const state = params.get("s");

  // Server-rendered pages get hydrated by their framework; touching the DOM before that causes hydration
  // mismatches. Globals are safe right away; DOM changes wait until the page is hydrated.
  const serverRendered = () => [...(document.body?.children || [])].some(
    (el) => !/^(SCRIPT|NOSCRIPT|TEMPLATE|LINK|STYLE)$/.test(el.tagName) && el.childElementCount > 0);
  function whenSafe(fn) {
    const afterHydration = () => {
      const run = () => setTimeout(fn, 300);
      if (document.readyState === "complete") run();
      else addEventListener("load", run, { once: true });
    };
    const go = () => (serverRendered() ? afterHydration() : fn());
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go, { once: true });
    else go();
  }

  // Frameworks that own <html> may drop our attributes on render; put them back.
  const pin = (attr, val) => {
    root.setAttribute(attr, val);
    new MutationObserver(() => { if (root.getAttribute(attr) !== val) root.setAttribute(attr, val); })
      .observe(root, { attributes: true, attributeFilter: [attr] });
  };
  if (variant) window.__UIS_VARIANT = variant;
  if (state) window.__UIS_STATE = state;
  whenSafe(() => {
    if (variant) pin("data-uis-variant", variant);
    if (state) pin("data-uis-state", state);
  });

  const script = document.currentScript;
  if (script && script.src.includes("reload=1")) {
    const es = new EventSource("/__uis/reload");
    es.onmessage = () => location.reload();
  }

  if (window.parent === window) return;

  const post = (msg) => window.parent.postMessage({ __uis: true, ...msg }, "*");

  // Runtime errors go to the studio (and from there to the agent), so they get fixed instead of shown.
  const text = (x) => {
    if (typeof x === "string") return x;
    if (x instanceof Error) return `${x.name}: ${x.message}`;
    try { return JSON.stringify(x); } catch { return String(x); }
  };
  const report = (message, where = "") => { try { post({ type: "error", message: String(message).slice(0, 800), where }); } catch {} };
  addEventListener("error", (e) => report(e.error ? text(e.error) : e.message || "Error", e.filename ? `${e.filename}:${e.lineno}` : ""));
  addEventListener("unhandledrejection", (e) => report(`Unhandled rejection: ${text(e.reason)}`));
  const consoleError = console.error;
  console.error = function (...args) { report(args.map(text).join(" "), "console.error"); return consoleError.apply(this, args); };
  let cfg = { selector: "", scope: "isolate" };
  let target = null;
  let last = "";

  const style = document.createElement("style");
  style.setAttribute("data-uis-own", "");
  style.textContent =
    "html.uis-isolate,html.uis-isolate body{background:transparent!important;background-image:none!important;scrollbar-width:none}" +
    "html.uis-isolate::-webkit-scrollbar{display:none}" +
    "html.uis-isolate body *:not([data-uis-target],[data-uis-target] *){visibility:hidden!important}" +
    "html.uis-isolate [data-uis-target]{visibility:visible!important}" +
    // Element and isolate views are framed by the studio; the page itself must not scroll under the frame.
    "html.uis-framed,html.uis-framed body{overflow:hidden!important}" +
    // Framework dev badges and overlays are not part of the design; errors reach the agent instead.
    "nextjs-portal,vite-error-overlay,astro-dev-toolbar,#webpack-dev-server-client-overlay,#__next-build-watcher{display:none!important}";

  // ---------- colors ----------

  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  // Normalizes any CSS color (oklch, color-mix, named…) to [r, g, b, a].
  function rgba(c) {
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = "transparent";
    cx.fillStyle = c;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const css = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;
  // Bench tone with the higher contrast against the given color.
  const benchFor = (c) => ((lum(c) + 0.05) / (0.012 + 0.05) > (0.86 + 0.05) / (lum(c) + 0.05) ? "dark" : "light");

  function look(el) {
    const cs = getComputedStyle(el);
    const own = rgba(cs.backgroundColor);
    // Self-contained = paints its own surface. Outlined or translucent elements show the color they sit on.
    const selfContained = own[3] > 0.6 || cs.backgroundImage !== "none";
    let backdrop = null;
    if (!selfContained) {
      for (let a = el.parentElement; a && !backdrop; a = a.parentElement) {
        const c = rgba(getComputedStyle(a).backgroundColor);
        if (c[3] > 0.6) backdrop = c;
      }
      if (!backdrop) {
        const dark = getComputedStyle(root).colorScheme.includes("dark") && matchMedia("(prefers-color-scheme: dark)").matches;
        backdrop = dark ? [18, 18, 18, 1] : [255, 255, 255, 1];
      }
    }
    const basis = own[3] > 0.6 ? own : backdrop || rgba(cs.color);
    return {
      selfContained,
      backdrop: backdrop && css(backdrop),
      bench: benchFor(basis),
      lum: lum(basis),
      colorScheme: getComputedStyle(root).colorScheme || "normal",
    };
  }

  // ---------- forced pseudo states ----------

  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=menuitem],[role=option],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const FORCE = { hover: ["hover"], focus: ["focus", "focus-within"], "focus-visible": ["focus", "focus-within"], active: ["hover", "active"] };
  const forced = FORCE[state] || null;
  const doneSheets = new WeakSet();
  let marked = [];

  function rewrite(list, owner) {
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (r.cssRules && r.cssRules.length) rewrite(r.cssRules, r);
      const sel = r.selectorText;
      if (!sel || !/:(hover|active|focus)/.test(sel) || !r.cssText.startsWith(sel)) continue;
      const next = sel
        .replace(/:focus-visible\b/g, "[data-uis-focus]")
        .replace(/:focus-within\b/g, "[data-uis-focus-within]")
        .replace(/:focus\b(?!-)/g, "[data-uis-focus]")
        .replace(/:hover\b/g, "[data-uis-hover]")
        .replace(/:active\b/g, "[data-uis-active]");
      try { owner.insertRule(next + r.cssText.slice(sel.length), i + 1); } catch {}
    }
  }
  function rewriteSheets() {
    for (const sh of document.styleSheets) {
      if (doneSheets.has(sh) || sh.ownerNode === style) continue;
      doneSheets.add(sh);
      try { rewrite(sh.cssRules, sh); } catch {}
    }
  }
  // The element a pointer or keyboard would actually act on.
  function actor(el) {
    if (el.matches(INTERACTIVE)) return el;
    const inner = el.querySelectorAll(INTERACTIVE);
    return inner.length === 1 ? inner[0] : el;
  }
  function applyForced() {
    for (const [el, a] of marked) el.removeAttribute(a);
    marked = [];
    if (!forced || !target) return;
    const t = actor(target);
    const mark = (el, a) => { el.setAttribute(a, ""); marked.push([el, a]); };
    for (const f of forced) {
      if (f === "focus") { mark(t, "data-uis-focus"); continue; }
      for (let a = t; a && a !== root; a = a.parentElement) mark(a, `data-uis-${f}`);
    }
  }

  // ---------- scoping ----------

  function find() {
    if (!cfg.selector) return null;
    try { return document.querySelector(cfg.selector); } catch { return null; }
  }

  function update() {
    if (!style.isConnected) (document.head || root).appendChild(style);
    if (forced) rewriteSheets();
    const el = find();
    if (el !== target) {
      if (target) target.removeAttribute("data-uis-target");
      target = el;
      if (el) el.setAttribute("data-uis-target", "");
    }
    if (forced && (!marked.length || !marked[0][0].isConnected || !target?.contains(marked[0][0]))) applyForced();
    root.classList.toggle("uis-isolate", !!el && cfg.scope === "isolate");
    root.classList.toggle("uis-framed", !!el && cfg.scope !== "page");
    let msg;
    if (!el) {
      msg = { type: "rect", found: false, page: true };
    } else {
      const interactive = el.matches(INTERACTIVE) || el.querySelectorAll(INTERACTIVE).length === 1;
      if (cfg.scope === "page") {
        msg = { type: "rect", found: true, page: true, interactive };
      } else {
        let r = el.getBoundingClientRect();
        // Not fully in view: bring its top-left corner in (with a margin). The studio grows the frame when the
        // element is larger than the viewport, so the whole element ends up inside it.
        if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) {
          const x = Math.max(0, r.left + scrollX - 24), y = Math.max(0, r.top + scrollY - 24);
          if (x !== scrollX || y !== scrollY) { scrollTo(x, y); r = el.getBoundingClientRect(); }
        }
        msg = { type: "rect", found: true, interactive, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, look: look(el) };
      }
    }
    const key = JSON.stringify(msg);
    if (key !== last) { last = key; post(msg); }
  }

  // ---------- DOM snapshot (checkpoints for before/after) ----------
  // The target as static HTML: every element carries its computed style inline (only what differs from both the
  // tag's default and its parent, so inheritance stays right), pseudo-elements become rules, and the page's
  // @font-face and used @keyframes rules come along. The studio keeps one per checkpoint and UX state.

  const SKIP = /^(SCRIPT|NOSCRIPT|TEMPLATE|STYLE|LINK)$/;
  const tagDefaults = new Map();
  function defaultsFor(tag, ns) {
    const key = ns + tag;
    if (tagDefaults.has(key)) return tagDefaults.get(key);
    const box = document.createElement("div");
    box.style.cssText = "all:initial;position:absolute;left:-9999px;top:0";
    const el = ns === "svg" ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
    if (ns === "svg" && tag !== "svg") { const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.append(el); box.append(svg); }
    else box.append(el);
    root.append(box);
    const cs = getComputedStyle(el), o = {};
    for (const p of cs) o[p] = cs.getPropertyValue(p);
    box.remove();
    tagDefaults.set(key, o);
    return o;
  }
  const props = (cs) => [...cs].filter((p) => !p.startsWith("--"));
  function styleText(cs, def, parent) {
    let out = "";
    for (const p of props(cs)) {
      const v = cs.getPropertyValue(p);
      if (v === def[p] && (!parent || v === parent.getPropertyValue(p))) continue;
      out += `${p}:${v};`;
    }
    return out;
  }
  function snapshotDoc() {
    const src = target || document.body;
    const rules = [], anims = new Set();
    let n = 0;
    const walk = (el, clone, parentCs) => {
      const cs = getComputedStyle(el);
      const ns = el instanceof SVGElement ? "svg" : "html";
      const def = defaultsFor(el.localName, ns);
      clone.removeAttribute("style");
      for (const a of [...clone.attributes]) if (a.name.startsWith("data-uis-") || a.name.startsWith("on")) clone.removeAttribute(a.name);
      clone.setAttribute("style", styleText(cs, def, parentCs));
      if (cs.animationName && cs.animationName !== "none") cs.animationName.split(",").forEach((a) => anims.add(a.trim()));
      for (const pseudo of ["::before", "::after"]) {
        const ps = getComputedStyle(el, pseudo);
        if (!ps.content || ps.content === "none" || ps.content === "normal") continue;
        clone.setAttribute("data-uis-p", String(++n));
        rules.push(`[data-uis-p="${n}"]${pseudo}{${styleText(ps, defaultsFor("span", "html"), cs)}}`);
      }
      if (el.localName === "img") { clone.setAttribute("src", el.currentSrc || el.src); clone.removeAttribute("srcset"); clone.removeAttribute("loading"); }
      if (el.localName === "canvas") { try { const img = document.createElement("img"); img.src = el.toDataURL(); img.setAttribute("style", clone.getAttribute("style")); clone.replaceWith(img); } catch {} return; }
      if (el.localName === "input" || el.localName === "textarea") { clone.setAttribute("value", el.value); if (el.localName === "textarea") clone.textContent = el.value; if (el.checked) clone.setAttribute("checked", ""); }
      if (cs.display === "none") { clone.replaceChildren(); return; }
      const kids = [...el.children], ckids = [...clone.children];
      for (let i = 0; i < kids.length; i++) {
        if (SKIP.test(kids[i].tagName)) { ckids[i].remove(); continue; }
        walk(kids[i], ckids[i], cs);
      }
    };
    const clone = src.cloneNode(true);
    walk(src, clone, null);
    if (src !== document.body) clone.setAttribute("data-uis-snap-root", "");
    const sheetRules = [];
    for (const sh of document.styleSheets) {
      let list;
      try { list = sh.cssRules; } catch { continue; }
      const base = sh.href || location.href;
      for (const r of list) {
        if (r instanceof CSSFontFaceRule) sheetRules.push(r.cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, u) => { try { return `url("${new URL(u, base).href}")`; } catch { return m; } }));
        else if (r instanceof CSSKeyframesRule && anims.has(r.name)) sheetRules.push(r.cssText);
      }
    }
    const bg = target ? look(target).backdrop : null;
    const body = src === document.body ? `<div data-uis-snap-root style="${clone.getAttribute("style") || ""}">${clone.innerHTML}</div>` : clone.outerHTML;
    return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}body{padding:48px}${sheetRules.join("\n")}\n${rules.join("\n")}</style></head>` +
      `<body><div style="display:flow-root;width:max-content;${bg ? `background:${bg};` : ""}">${body}</div></body></html>`;
  }

  // The main preview (`keep`) sends a frozen copy of the target whenever the page settles after a change, so the
  // studio can still show the last working design while the page is broken or reloading.
  let keepTimer = null;
  function keepFresh() {
    if (!cfg.keep) return;
    clearTimeout(keepTimer);
    keepTimer = setTimeout(() => {
      if (!find()) return; // broken right now: keep the previous copy
      try { post({ type: "dom", keep: true, html: snapshotDoc() }); } catch {}
    }, 1200);
  }

  let queued = false;
  // rAF is paused in off-screen cross-origin frames (used for render checks), so a timer backs it up.
  const schedule = () => {
    if (queued) return;
    queued = true;
    const run = () => { if (queued) { queued = false; update(); } };
    requestAnimationFrame(run);
    setTimeout(run, 120);
  };

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || !d.__uis || e.source !== window.parent) return;
    if (d.type === "config") { cfg = { ...cfg, selector: d.selector, scope: d.scope, keep: !!d.keep }; last = ""; schedule(); keepFresh(); }
    if (d.type === "serialize") { let html = null; try { update(); html = snapshotDoc(); } catch (err) { report(`snapshot failed: ${text(err)}`); } post({ type: "dom", req: d.req, html }); }
  });

  const start = () => {
    (document.head || root).appendChild(style);
    new MutationObserver((list) => {
      schedule();
      // Our own markers don't count as a change of the design.
      if (cfg.keep && list.some((m) => !(m.type === "attributes" && m.attributeName?.startsWith("data-uis")) && !(m.target === root && m.attributeName === "class"))) keepFresh();
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    addEventListener("resize", schedule);
    addEventListener("scroll", schedule, true);
    setInterval(schedule, 700);
    post({ type: "ready", url: location.pathname + location.search, variant, state });
  };
  whenSafe(start);

  // Report client-side navigations so the studio can show the current route.
  for (const fn of ["pushState", "replaceState"]) {
    const orig = history[fn];
    history[fn] = function (...args) { const r = orig.apply(this, args); post({ type: "nav", url: location.pathname + location.search }); return r; };
  }
  addEventListener("popstate", () => post({ type: "nav", url: location.pathname + location.search }));
})();

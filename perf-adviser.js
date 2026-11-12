// perf-adviser.js - in-app performance adviser for this Spotify + Spicetify setup.
//
// What it does
//   - injects three measured, individually switchable fixes:
//       1. removes the sticky-header backdrop blur (opaque theme background)
//       2. hides the Home card play button only while scrolling (its tooltip
//          is repositioned on every scroll frame)
//       3. pauses the decorative rotating cover art, which Chromium runs on the
//          main thread because the same element also carries clip-path
//   - one optional cosmetic bundle (marketplace card border, active-button
//     colour, 72 px player bar) - not a performance fix, off by default
//   - scans the live environment (Marketplace extensions/snippets, theme,
//     header blur, page zoom, CSS-editor leftovers, running animations)
//   - runs the same scroll FPS test used by the offline harness, inside Spotify
//   - lists measured offenders with the fps cost measured on this machine
//   - includes the profiler that used to live in spx-perf.js: start recording,
//     scroll, stop, and see cost attributed by extension/script
//
// What it never does
//   - it does not disable, uninstall or update any extension/snippet/theme
//   - it makes no network requests
//   - it does not touch Spotify's own files
//   - it does not run timers, observers or animation frames while idle
//
// Kill switch: "Disable all fixes" in the panel (or "Remove applied fixes")
// stops every injected rule. Fix state is stored in
// localStorage["perf-adviser:state"].
//
// Uninstall:
//   spicetify config extensions perf-adviser.js-
//   spicetify apply -n
// (or delete %APPDATA%\spicetify\Extensions\perf-adviser.js and remove it from
//  the `extensions` line in config)
(function PerfAdviser() {
  "use strict";
  if (window.__perfAdviser) return;

  const VERSION = "1.0.0";
  const STATE_KEY = "perf-adviser:state";
  const FIX_ID = "perf-adviser-fixes";
  const SCROLL_CLASS = "perf-adviser-scrolling";

  // ---------------------------------------------------------------- CSS blocks
  // Each fix is a separate block so it can be measured and disabled on its own.
  // Every rule is scoped to Spotify's own class names and is reversible.

  // 1. Sticky header surfaces: drop the per-frame backdrop blur and use an opaque,
  //    theme-coloured background so scrolling content does not show through.
  //    Measured +5.8 fps on Home on top of the card fix (66.2 -> 72.0 median);
  //    on its own the gain is within noise (+1.5 fps).
  const HEADER_CSS = [
    "/* Perf Adviser fix 1: remove the sticky-header backdrop blur. */",
    ":root { --header-filters: none !important; }",
    ".main-topBar-background:not(#a):not(#b),",
    ".search-searchCategory-SearchCategory:not(#a):not(#b),",
    ".main-home-filterChipsSection:not(#a):not(#b),",
    ".main-trackList-trackListHeader:not(#a):not(#b),",
    ".main-trackList-trackListHeaderStuck:not(#a):not(#b) {",
    "  background-color: var(--clr-surface-1, var(--background-base, #121212)) !important;",
    "}",
  ].join("\n");

  const HEADER_SELECTORS = [
    ".main-topBar-background",
    ".search-searchCategory-SearchCategory",
    ".main-home-filterChipsSection",
    ".main-trackList-trackListHeader",
    ".main-trackList-trackListHeaderStuck",
  ];

  // 2. Spotify mounts a tippy tooltip on the card's hover play button and
  //    repositions it on every scroll event. Hiding the button only while
  //    scrolling keeps it usable at rest and scoped to Home (Marketplace
  //    install/uninstall buttons use the same class and must not be touched).
  //    Measured 27.7 -> 66.2 fps median (3 paired 8 s runs, pointer on a card
  //    play button so its tooltip is mounted).
  const CARDPLAY_CSS = [
    "/* Perf Adviser fix 2: hide the Home card play button only while scrolling. */",
    "html." + SCROLL_CLASS + " [data-testid=\"home-page\"] .main-card-PlayButtonContainer { display: none !important; }",
  ].join("\n");

  // 3. Many themes/snippets put a slow full rotation on .cover-art. That element
  //    also carries clip-path and border-radius, so Chromium cannot composite the
  //    transform and runs it on the main thread every frame. The rotation is
  //    decorative; pausing it keeps the circular crop. Measured 85.9 -> 123.0 fps
  //    median on Home (3 paired 8 s runs).
  const COVER_CSS = [
    "/* Perf Adviser fix 3: pause the decorative rotating cover art. */",
    ".cover-art,",
    ".main-nowPlayingView-coverArtContainer::before,",
    ".main-nowPlayingView-coverArtContainer::after {",
    "  animation-play-state: paused !important;",
    "}",
  ].join("\n");

  // Cosmetic bundle that used to live in the CSS editor. Theme-specific, not a
  // measured performance win, so it is off by default and never part of the
  // recommended preset.
  const THEME_CSS = [
    "/* Perf Adviser optional theme tweaks (cosmetic, not a performance fix). */",
    ".marketplace-card--installed {",
    "  flex: 0 !important;",
    "  -webkit-box-flex: 0 !important;",
    "  border: 2px solid #814fff;",
    "}",
    ":root { --spice-button-active: #7b3bff; }",
    ".main-nowPlayingBar-nowPlayingBar:not(#a):not(#b) { height: 72px !important; }",
  ].join("\n");

  // Costs measured on this machine and documented in REPORT.md.
  const KNOWN = [
    {
      id: "sort-play",
      re: /sort[-_ ]?play/i,
      name: "Sort Play",
      severity: "high",
      impact: "Playlists: 4.5 -> 14.8 fps when disabled (3.3x). 3.7 MB script, ~10,600 listeners.",
      action: "Keep it disabled in Marketplace > Extensions.",
    },
    {
      id: "quickqueue",
      re: /quick[-_ ]?queue/i,
      name: "Quick Queue",
      severity: "medium",
      impact: "Playlists: 19.0 -> 24.6 fps when also blocked. The largest remaining third-party cost.",
      action: "If you rarely use the queue button, disable it in Marketplace > Extensions.",
    },
    {
      id: "rotating-cover",
      re: /rotating[-_ ]?cover/i,
      name: "Rotating Cover Art",
      severity: "low",
      impact: "Part of a group measured at -3.0 fps Home / -2.3 fps playlist when re-enabled.",
      action: "Optional: disable in Marketplace > Snippets.",
    },
    {
      id: "pill-player",
      re: /pill[-_ ]?player/i,
      name: "Pill Player and Rounded UI",
      severity: "low",
      impact: "Part of a group measured at -3.0 fps Home / -2.3 fps playlist when re-enabled.",
      action: "Optional: disable in Marketplace > Snippets.",
    },
    {
      id: "upcoming-song",
      re: /upcoming[-_ ]?song/i,
      name: "Upcoming Song",
      severity: "low",
      impact: "Part of a group measured at -3.0 fps Home / -2.3 fps playlist when re-enabled.",
      action: "Optional: disable in Marketplace > Extensions.",
    },
  ];

  // ---------------------------------------------------------------- state
  // Recommended defaults: the three fixes that measured a clear win.
  // themeTweaks is cosmetic and stays off unless the user turns it on.
  const DEFAULTS = {
    headerFix: true,
    cardPlayFix: true,
    coverPause: true,
    themeTweaks: false,
    cssOff: false,
  };
  function loadState() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(STATE_KEY) || "{}") || {}; } catch (e) { stored = {}; }
    const s = {};
    for (const k of Object.keys(DEFAULTS)) s[k] = k in stored ? !!stored[k] : DEFAULTS[k];
    return s;
  }
  function saveState(s) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }
  const state = loadState();

  function activeBlocks() {
    if (state.cssOff) return [];
    const blocks = [];
    if (state.headerFix) blocks.push(HEADER_CSS);
    if (state.cardPlayFix) blocks.push(CARDPLAY_CSS);
    if (state.coverPause) blocks.push(COVER_CSS);
    if (state.themeTweaks) blocks.push(THEME_CSS);
    return blocks;
  }

  function applyInjectedFixes() {
    const blocks = activeBlocks();
    let el = document.getElementById(FIX_ID);
    if (!blocks.length) {
      if (el) el.remove();
      document.documentElement.classList.remove(SCROLL_CLASS);
      return;
    }
    if (!el) {
      el = document.createElement("style");
      el.id = FIX_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = blocks.join("\n");
    if (state.cssOff || !state.cardPlayFix) document.documentElement.classList.remove(SCROLL_CLASS);
  }
  function clearInjectedFixes() {
    const el = document.getElementById(FIX_ID);
    if (el) el.remove();
    document.documentElement.classList.remove(SCROLL_CLASS);
  }
  applyInjectedFixes();

  // Scroll-scoped card play button: one class toggle at the start and end of a
  // scroll, instead of the tooltip's ~1500 inline-style writes per 4 s.
  let scrollTimer = null;
  function onScrollSignal() {
    if (!state.cardPlayFix || state.cssOff) return;
    const root = document.documentElement;
    if (!root.classList.contains(SCROLL_CLASS)) root.classList.add(SCROLL_CLASS);
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => root.classList.remove(SCROLL_CLASS), 180);
  }
  try {
    document.addEventListener("scroll", onScrollSignal, { capture: true, passive: true });
    document.addEventListener("wheel", onScrollSignal, { capture: true, passive: true });
    document.addEventListener("touchmove", onScrollSignal, { capture: true, passive: true });
  } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------- helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const median = (vals) => {
    const s = [...vals].sort((a, b) => a - b);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  };
  const route = () => {
    try { return Spicetify.Platform.History.location.pathname || "/"; } catch (e) { return location.hash || "/"; }
  };
  function notify(msg, isError) {
    try { Spicetify.showNotification(msg, !!isError, 4000); } catch (e) { /* ignore */ }
  }
  function h(tag, css, text) {
    const node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text != null) node.textContent = text;
    return node;
  }
  const C = {
    text: "var(--spice-text, #fff)",
    sub: "var(--spice-subtext, #b3b3b3)",
    card: "var(--spice-card, rgba(255,255,255,.07))",
    green: "#1ed760",
    amber: "#ffa42b",
    red: "#f15e6c",
    blue: "#4cb3d4",
  };
  const SEV = { high: C.red, medium: C.amber, low: C.blue, ok: C.green, info: C.blue };

  // ZoomAPI levels are percentages: 0 = 100%, -50 = 91.287%, 50 = 109.5%.
  function zoomPct(level) {
    if (level == null) return "unknown";
    return Math.round(Math.pow(1.2, level / 100) * 100) + "% (level " + level + ")";
  }

  // ---------------------------------------------------------------- profiler
  // Compact port of spx-perf.js (that extension is no longer installed). All
  // wrappers are installed only while a recording runs, so profiling costs
  // nothing when you are not using it.
  const prof = (() => {
    const CORE = "spotify-core";
    const UNKNOWN = "(unknown)";
    const ANON = "(anonymous/eval)";
    const CORE_RE = /^(vendor[~-])?xpui[\w.~-]*\.js$/i;
    const INFRA = new Set(["spicetifyWrapper.js", "perf-adviser.js"]);
    const HOT = new Set(["scroll", "wheel", "mousewheel", "mousemove", "mouseover", "pointermove", "pointerover", "touchmove", "touchstart", "resize"]);
    const FORCED_MS = 2;

    const orig = {
      setTimeout: window.setTimeout,
      clearTimeout: window.clearTimeout,
      setInterval: window.setInterval,
      raf: window.requestAnimationFrame,
      MO: window.MutationObserver,
      add: EventTarget.prototype.addEventListener,
      remove: EventTarget.prototype.removeEventListener,
    };
    const later = (fn, ms) => orig.setTimeout.call(window, fn, ms);

    let recording = false;
    let startedAt = 0;
    let activeSource = null;
    let stats = new Map();
    let inventory = new Map();
    let frameDeltas = [];
    let lastFrame = 0;
    let longTasks = { count: 0, totalMs: 0, maxMs: 0 };
    let loaf = { supported: false, frames: 0, blockingMs: 0, scripts: new Map() };
    let lastReport = null;
    let undo = [];
    let perfObservers = [];

    function stat(src) {
      let s = stats.get(src);
      if (!s) {
        s = { source: src, total: 0, count: 0, max: 0, kinds: {}, forcedMs: 0, forcedCount: 0, forcedProps: {} };
        stats.set(src, s);
      }
      return s;
    }
    function rec(src, kind, ms) {
      const s = stat(src);
      s.total += ms; s.count++; if (ms > s.max) s.max = ms;
      const k = s.kinds[kind] || (s.kinds[kind] = { count: 0, ms: 0 });
      k.count++; k.ms += ms;
    }
    function inv(src, kind) {
      let i = inventory.get(src);
      if (!i) { i = { source: src, interval: 0, observer: 0, broadObserver: 0, listener: 0 }; inventory.set(src, i); }
      i[kind]++;
    }

    const baseName = (u) => {
      u = String(u).split("?")[0].split("#")[0];
      const p = u.split("/");
      return p[p.length - 1] || u;
    };
    const URL_RE = /((?:https?|file|spotify):\/\/[^\s)]+?|blob:[^\s)]+?):\d+:\d+/;
    function frameLabel(line) {
      const m = URL_RE.exec(line);
      if (/\beval at\b/.test(line)) return "eval:" + (m ? baseName(m[1]) : "?");
      if (m) return baseName(m[1]);
      if (/<anonymous>:\d+:\d+/.test(line)) return ANON;
      return null;
    }
    // First frame that is not Spotify core, not Spicetify's wrapper, not us.
    function attribute() {
      let stack = "";
      try { stack = new Error().stack || ""; } catch (e) { return UNKNOWN; }
      const lines = stack.split("\n").slice(1);
      let sawCore = false, sawAnon = false;
      for (const line of lines) {
        if (/perf-adviser\.js|pa_/.test(line)) continue;
        const l = frameLabel(line);
        if (!l) continue;
        if (INFRA.has(l)) continue;
        if (l === ANON) { sawAnon = true; continue; }
        if (CORE_RE.test(l)) { sawCore = true; continue; }
        return l;
      }
      if (sawAnon) return ANON;
      return sawCore ? CORE : UNKNOWN;
    }

    function wrapCb(fn, src, kind) {
      return function pa_cb() {
        if (!recording) return fn.apply(this, arguments);
        const prev = activeSource;
        activeSource = src;
        const t = performance.now();
        try { return fn.apply(this, arguments); }
        finally { activeSource = prev; rec(src, kind, performance.now() - t); }
      };
    }

    // ------------------------------------------------------------ forced reads
    function noteForced(prop, ms) {
      const src = attribute();
      const s = stat(src);
      s.forcedMs += ms; s.forcedCount++; if (ms > s.forcedMax || !s.forcedMax) s.forcedMax = ms;
      s.forcedProps[prop] = (s.forcedProps[prop] || 0) + 1;
    }
    function installProbes() {
      const getters = [
        [Element.prototype, ["scrollTop", "scrollLeft", "scrollHeight", "scrollWidth", "clientHeight", "clientWidth"]],
        [HTMLElement.prototype, ["offsetHeight", "offsetWidth", "offsetTop", "offsetLeft"]],
      ];
      for (const [proto, names] of getters) {
        for (const name of names) {
          try {
            const desc = Object.getOwnPropertyDescriptor(proto, name);
            if (!desc || !desc.get) continue;
            const g = desc.get;
            Object.defineProperty(proto, name, {
              configurable: true, enumerable: desc.enumerable, set: desc.set,
              get: function pa_get() {
                const t = performance.now();
                const v = g.call(this);
                const d = performance.now() - t;
                if (d > FORCED_MS) noteForced(name, d);
                return v;
              },
            });
            undo.push(() => Object.defineProperty(proto, name, desc));
          } catch (e) { /* ignore */ }
        }
      }
      for (const name of ["getBoundingClientRect", "getClientRects"]) {
        try {
          const desc = Object.getOwnPropertyDescriptor(Element.prototype, name);
          if (!desc || typeof desc.value !== "function") continue;
          const f = desc.value;
          Object.defineProperty(Element.prototype, name, {
            configurable: true, enumerable: desc.enumerable, writable: true,
            value: function pa_method() {
              const t = performance.now();
              const v = f.apply(this, arguments);
              const d = performance.now() - t;
              if (d > FORCED_MS) noteForced(name, d);
              return v;
            },
          });
          undo.push(() => Object.defineProperty(Element.prototype, name, desc));
        } catch (e) { /* ignore */ }
      }
    }

    // ------------------------------------------------------------ patch/unpatch
    function patch() {
      if (!recording) return;
      window.setInterval = function pa_setInterval(fn) {
        const args = Array.prototype.slice.call(arguments);
        try {
          if (typeof fn === "function") {
            const src = activeSource || attribute();
            inv(src, "interval");
            if (src !== CORE) args[0] = wrapCb(fn, src, "interval");
          }
        } catch (e) { /* ignore */ }
        return orig.setInterval.apply(window, args);
      };
      undo.push(() => { window.setInterval = orig.setInterval; });

      window.setTimeout = function pa_setTimeout(fn) {
        const args = Array.prototype.slice.call(arguments);
        try {
          if (typeof fn === "function") {
            const src = activeSource || attribute();
            if (src !== CORE) args[0] = wrapCb(fn, src, "timeout");
          }
        } catch (e) { /* ignore */ }
        return orig.setTimeout.apply(window, args);
      };
      undo.push(() => { window.setTimeout = orig.setTimeout; });

      window.requestAnimationFrame = function pa_raf(fn) {
        try {
          if (typeof fn === "function") {
            const src = activeSource || attribute();
            if (src !== CORE) fn = wrapCb(fn, src, "raf");
          }
        } catch (e) { /* ignore */ }
        return orig.raf.call(window, fn);
      };
      undo.push(() => { window.requestAnimationFrame = orig.raf; });

      EventTarget.prototype.addEventListener = function pa_add(type, listener, options) {
        try {
          if (typeof listener === "function" && typeof type === "string") {
            const src = activeSource || attribute();
            if (src !== CORE) {
              inv(src, "listener");
              const w = wrapCb(listener, src, "listener:" + type);
              return orig.add.call(this, type, w, options);
            }
          }
        } catch (e) { /* fall through */ }
        return orig.add.call(this, type, listener, options);
      };
      undo.push(() => { EventTarget.prototype.addEventListener = orig.add; });

      // MutationObserver: attribute callback time to whoever created the observer.
      class PaMO extends orig.MO {
        constructor(cb) {
          let src = UNKNOWN;
          try { src = activeSource || attribute(); } catch (e) { /* ignore */ }
          const wrapped = function (records, obs) {
            if (!recording || src === CORE) return cb.call(obs, records, obs);
            const prev = activeSource;
            activeSource = src;
            const t = performance.now();
            try { return cb.call(obs, records, obs); }
            finally { activeSource = prev; rec(src, "observer", performance.now() - t); }
          };
          super(typeof cb === "function" ? wrapped : cb);
          this.__paSrc = src;
          if (src !== CORE) inv(src, "observer");
        }
        observe(target, options) {
          try {
            if (options && options.subtree && this.__paSrc !== CORE &&
                (target === document.body || target === document || target === document.documentElement)) {
              inv(this.__paSrc, "broadObserver");
            }
          } catch (e) { /* ignore */ }
          return super.observe(target, options);
        }
      }
      window.MutationObserver = PaMO;
      undo.push(() => { window.MutationObserver = orig.MO; });
    }

    function startObservers() {
      try {
        const types = (window.PerformanceObserver && PerformanceObserver.supportedEntryTypes) || [];
        if (types.includes("long-animation-frame")) {
          loaf.supported = true;
          const o = new PerformanceObserver((list) => {
            if (!recording) return;
            for (const e of list.getEntries()) {
              loaf.frames++;
              loaf.blockingMs += e.blockingDuration || 0;
              for (const s of e.scripts || []) {
                const label = baseName(s.sourceURL || s.invoker || "?");
                let r = loaf.scripts.get(label);
                if (!r) { r = { source: label, ms: 0, forcedMs: 0, count: 0 }; loaf.scripts.set(label, r); }
                r.ms += s.duration || 0;
                r.forcedMs += s.forcedStyleAndLayoutDuration || 0;
                r.count++;
              }
            }
          });
          o.observe({ type: "long-animation-frame" });
          perfObservers.push(o);
        }
        if (types.includes("longtask")) {
          const o = new PerformanceObserver((list) => {
            if (!recording) return;
            for (const e of list.getEntries()) {
              longTasks.count++; longTasks.totalMs += e.duration;
              if (e.duration > longTasks.maxMs) longTasks.maxMs = e.duration;
            }
          });
          o.observe({ type: "longtask" });
          perfObservers.push(o);
        }
      } catch (e) { /* unsupported */ }
    }

    function fpsTick() {
      if (!recording) return;
      const now = performance.now();
      if (lastFrame) frameDeltas.push(now - lastFrame);
      lastFrame = now;
      orig.raf.call(window, fpsTick);
    }

    function start() {
      if (recording) return;
      stats = new Map();
      inventory = new Map();
      frameDeltas = [];
      lastFrame = 0;
      longTasks = { count: 0, totalMs: 0, maxMs: 0 };
      loaf = { supported: false, frames: 0, blockingMs: 0, scripts: new Map() };
      undo = [];
      perfObservers = [];
      startedAt = performance.now();
      recording = true;
      patch();
      installProbes();
      startObservers();
      orig.raf.call(window, fpsTick);
    }

    function build() {
      const sorted = frameDeltas.slice().sort((a, b) => a - b);
      const n = sorted.length;
      const mean = n ? sorted.reduce((a, b) => a + b, 0) / n : 0;
      const topProps = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => k + " x" + v).join(", ");
      return {
        version: VERSION,
        recordedMs: Math.round(performance.now() - startedAt),
        fps: n ? {
          avg: +(1000 / mean).toFixed(1),
          p95: +sorted[Math.floor(n * 0.95)].toFixed(1),
          slowPct: +(100 * sorted.filter((d) => d > 33.4).length / n).toFixed(1),
        } : null,
        longTasks: { count: longTasks.count, totalMs: Math.round(longTasks.totalMs), maxMs: Math.round(longTasks.maxMs) },
        sources: [...stats.values()]
          .sort((a, b) => (b.total + b.forcedMs) - (a.total + a.forcedMs))
          .map((s) => ({
            source: s.source,
            totalMs: +s.total.toFixed(1),
            calls: s.count,
            maxMs: +s.max.toFixed(1),
            kinds: Object.entries(s.kinds).sort((a, b) => b[1].ms - a[1].ms).slice(0, 2).map(([k, v]) => k + " " + Math.round(v.ms) + " ms (" + v.count + ")").join(", "),
            forcedMs: +s.forcedMs.toFixed(1),
            forcedCount: s.forcedCount,
            forcedBy: topProps(s.forcedProps),
          })),
        inventory: [...inventory.values()].sort((a, b) =>
          (b.interval + b.observer + b.listener) - (a.interval + a.observer + a.listener)),
        loaf: loaf.supported ? {
          frames: loaf.frames,
          blockingMs: Math.round(loaf.blockingMs),
          scripts: [...loaf.scripts.values()].sort((a, b) => b.ms - a.ms).slice(0, 12)
            .map((r) => ({ source: r.source, ms: Math.round(r.ms), forcedMs: Math.round(r.forcedMs), count: r.count })),
        } : null,
      };
    }

    function stop() {
      if (!recording) return lastReport;
      recording = false;
      for (const fn of undo.reverse()) { try { fn(); } catch (e) { /* ignore */ } }
      undo = [];
      for (const o of perfObservers) { try { o.disconnect(); } catch (e) { /* ignore */ } }
      perfObservers = [];
      lastReport = build();
      return lastReport;
    }

    return {
      get recording() { return recording; },
      get startedAt() { return startedAt; },
      start,
      stop,
      report: () => lastReport,
      reset: () => { lastReport = null; },
    };
  })();

  // ---------------------------------------------------------------- environment
  function timeout(promise, ms, fallback) {
    return Promise.race([promise, sleep(ms).then(() => fallback)]);
  }

  async function readMarketplace() {
    let db = null;
    try {
      if (indexedDB.databases) {
        const dbs = await timeout(indexedDB.databases(), 1500, null);
        if (dbs && !dbs.some((d) => d.name === "spicetify-marketplace")) return null;
      }
      db = await timeout(new Promise((resolve, reject) => {
        const req = indexedDB.open("spicetify-marketplace");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("blocked"));
      }), 2500, null);
      if (!db) return null;

      const read = (key) => new Promise((resolve) => {
        try {
          const tx = db.transaction("settings", "readonly");
          const req = tx.objectStore("settings").get(key);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
      const parseList = (row) => {
        try { return JSON.parse((row && row.value) || "[]"); } catch (e) { return []; }
      };
      const [extRow, snipRow, themeRow] = await Promise.all([
        read("marketplace:installed-extensions"),
        read("marketplace:installed-snippets"),
        read("marketplace:theme-installed"),
      ]);
      const describe = async (key) => {
        const tail = key.replace("marketplace:installed:snippet:", "").replace("marketplace:installed:", "");
        let name = tail.split("/").filter(Boolean).pop() || tail;
        try {
          const row = await read(key);
          const v = JSON.parse((row && row.value) || "{}");
          name = (v.manifest && v.manifest.name) || v.title || name;
        } catch (e) { /* keep tail */ }
        return { key: tail, name };
      };
      const extensions = await Promise.all(parseList(extRow).map(describe));
      const snippets = await Promise.all(parseList(snipRow).map(describe));
      let theme = null;
      if (themeRow && themeRow.value) {
        theme = await describe(String(themeRow.value));
      }
      return { extensions, snippets, theme };
    } catch (e) {
      return null;
    } finally {
      try { if (db) db.close(); } catch (e) { /* ignore */ }
    }
  }

  function headerBlurOffenders() {
    const out = [];
    for (const sel of HEADER_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const f = getComputedStyle(el).backdropFilter;
      if (f && f !== "none") out.push({ sel, filter: f });
    }
    return out;
  }

  async function readZoom() {
    let level = null;
    try {
      level = await Spicetify.Platform.ZoomAPI.getZoomLevel();
      if (typeof level !== "number") level = null;
    } catch (e) { level = null; }
    return { dpr: window.devicePixelRatio, level };
  }

  // How much CSS is still parked in the CSS editor extension.
  function cssEditorChars() {
    let raw = null;
    try { raw = localStorage.getItem("css-editor.css"); } catch (e) { return null; }
    if (raw == null) return 0;
    try {
      const v = JSON.parse(raw);
      if (typeof v === "string") return v.length;
      if (v && typeof v.value === "string") return v.value.length;
    } catch (e) { /* not JSON */ }
    return String(raw).length;
  }

  // Is a rotating-cover animation present at all? animationName stays readable
  // when we have paused it, so this reports the snippet, not our fix.
  function rotatingCoverPresent() {
    const el = document.querySelector(".cover-art");
    if (!el) return false;
    const name = getComputedStyle(el).animationName;
    return !!name && name !== "none" && /rotating/i.test(name);
  }

  async function scan() {
    const [market, zoom] = await Promise.all([readMarketplace(), readZoom()]);
    return {
      market,
      zoom,
      route: route(),
      headerBlur: headerBlurOffenders(),
      headerFilterVar: getComputedStyle(document.documentElement).getPropertyValue("--header-filters").trim(),
      cssEditorChars: cssEditorChars(),
      cssActive: !state.cssOff && !!document.getElementById(FIX_ID),
      headerFix: !!state.headerFix,
      cardPlayFix: !!state.cardPlayFix,
      coverPause: !!state.coverPause,
      themeTweaks: !!state.themeTweaks,
      coverRotating: rotatingCoverPresent(),
      cssOff: !!state.cssOff,
      scrollClassNow: document.documentElement.classList.contains(SCROLL_CLASS),
      cardPlayPresent: !!document.querySelector(".main-card-PlayButtonContainer"),
      profRunning: prof.recording,
      profElapsed: prof.recording ? Math.round((performance.now() - prof.startedAt) / 1000) : null,
    };
  }

  // ---------------------------------------------------------------- benchmark
  function findScroller() {
    const candidates = [...document.querySelectorAll("*")].filter((el) => {
      if (el.scrollHeight <= el.clientHeight + 200) return false;
      return /auto|scroll/.test(getComputedStyle(el).overflowY);
    });
    candidates.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    return candidates[0] || null;
  }

  function measureOnce(durationMs) {
    const el = findScroller();
    const longTasks = [];
    let obs = null;
    try {
      obs = new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(e.duration)));
      obs.observe({ entryTypes: ["longtask"] });
    } catch (e) { obs = null; }

    const frames = [];
    const start = performance.now();
    let last = start;
    const prevScroll = el ? el.scrollTop : 0;
    const max = el ? Math.min(el.scrollHeight - el.clientHeight, 4000) : 0;

    return new Promise((resolve) => {
      function tick(now) {
        frames.push(now - last);
        last = now;
        const t = (now - start) / durationMs;
        if (t >= 1) {
          if (obs) obs.disconnect();
          if (el) el.scrollTop = prevScroll;
          const sorted = [...frames].sort((a, b) => a - b);
          const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
          resolve({
            fps: mean > 0 ? 1000 / mean : 0,
            p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
            slowPct: 100 * frames.filter((f) => f > 33).length / frames.length,
            longTaskCount: longTasks.length,
            longestTaskMs: Math.max(0, ...longTasks),
            scrollable: !!el,
          });
          return;
        }
        if (el) el.scrollTop = (1 - Math.abs(2 * t - 1)) * max;
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  async function benchmark(durationMs, runs) {
    const rows = [];
    // Unmeasured warm-up: the first scroll after a reload is always slower, and
    // it also lets lazy-loaded shelves settle.
    await measureOnce(1500);
    await sleep(400);
    for (let i = 0; i < runs; i++) {
      const r = await measureOnce(durationMs);
      if (r.fps > 0) rows.push(r);
      if (i < runs - 1) await sleep(1200);
    }
    if (!rows.length) return null;
    return {
      fps: +median(rows.map((r) => r.fps)).toFixed(1),
      p95: +median(rows.map((r) => r.p95)).toFixed(1),
      slowPct: +median(rows.map((r) => r.slowPct)).toFixed(1),
      longTaskCount: median(rows.map((r) => r.longTaskCount)),
      longestTaskMs: +median(rows.map((r) => r.longestTaskMs)).toFixed(1),
      scrollable: rows.every((r) => r.scrollable),
      runs: rows.length,
      durationMs,
      route: route(),
    };
  }

  // ---------------------------------------------------------------- panel
  let last = null;
  let busy = false;

  function section(title) {
    const wrap = h("div", "display:flex;flex-direction:column;gap:8px;");
    wrap.appendChild(h("div", `font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${C.sub};`, title));
    return wrap;
  }

  function row(label, value, color) {
    const r = h("div", "display:flex;justify-content:space-between;gap:16px;align-items:baseline;");
    r.appendChild(h("span", `color:${C.sub};font-size:13px;`, label));
    r.appendChild(h("span", `color:${color || C.text};font-size:13px;`, value));
    return r;
  }

  function pill(text, color) {
    return h("span", `display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;border:1px solid ${color};color:${color};`, text);
  }

  function btn(text, onClick, primary) {
    const b = h("button", [
      "padding:7px 14px",
      "border-radius:999px",
      "font-size:13px",
      "cursor:pointer",
      `border:1px solid ${primary ? "transparent" : "rgba(128,128,128,.5)"}`,
      `background:${primary ? C.green : "transparent"}`,
      `color:${primary ? "#000" : C.text}`,
    ].join(";"), text);
    b.addEventListener("click", onClick);
    return b;
  }

  // Compact table for the profiler output.
  function miniTable(headers, rows) {
    const wrap = h("div", "display:flex;flex-direction:column;gap:1px;font-size:11px;font-family:ui-monospace,Consolas,monospace;overflow-x:auto;");
    const head = h("div", `display:grid;grid-template-columns:${headers.map(() => "minmax(0,1fr)").join(" ")};gap:10px;color:${C.sub};padding:2px 0;`);
    for (const hd of headers) head.appendChild(h("div", "", hd));
    wrap.appendChild(head);
    if (!rows.length) {
      wrap.appendChild(h("div", `color:${C.sub};padding:4px 0;`, "nothing recorded"));
      return wrap;
    }
    for (const r of rows) {
      const line = h("div", `display:grid;grid-template-columns:${r.map(() => "minmax(0,1fr)").join(" ")};gap:10px;padding:3px 0;border-top:1px solid rgba(128,128,128,.14);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`);
      for (const cell of r) line.appendChild(h("div", `overflow:hidden;text-overflow:ellipsis;color:${C.text};`, String(cell)));
      wrap.appendChild(line);
    }
    return wrap;
  }

  function buildRecommendations(s) {
    const recs = [];
    if (s.headerBlur.length) {
      recs.push({
        severity: "high",
        title: "Sticky header blur is active",
        body: "Measured +5.8 fps on Home on top of the card fix (66.2 -> 72.0 median). On its own the gain is within noise (+1.5 fps). " + s.headerBlur.length + " surface(s) currently carry backdrop-filter.",
        action: "Turn on 'Sticky header blur' in One-click fixes. If it is already on, some other extension or snippet is re-adding the blur.",
      });
    }
    if (s.cssEditorChars > 0) {
      recs.push({
        severity: "low",
        title: "The CSS editor still has " + s.cssEditorChars + " characters of CSS",
        body: "All current fixes are injected by this extension, so the CSS editor can stay empty and must not duplicate them.",
        action: "Press F12, copy the text somewhere safe, then clear the CSS editor.",
      });
    }
    if (s.zoom.level != null && s.zoom.level !== 0) {
      recs.push({
        severity: "info",
        title: "Page zoom is " + zoomPct(s.zoom.level),
        body: "A non-100% page zoom made the whole UI redraw at the wrong scale after backgrounding. This is a display bug, not fps.",
        action: "Use 'Reset zoom to 100%' below.",
      });
    }
    if (s.route === "/" && !s.cardPlayFix) {
      recs.push({
        severity: "info",
        title: "Home FPS depends on where the mouse rests",
        body: "With the cursor over a card, Spotify's play-button tooltip is repositioned on every scroll frame: 27.7 fps all-off vs 66.2 fps with the button hidden during scroll (paired, 3 rounds).",
        action: "Turn on 'Home card play button' below. It keeps the button usable at rest and only affects Home.",
      });
    }
    if (s.coverRotating && !s.coverPause) {
      recs.push({
        severity: "high",
        title: "Rotating cover art is animating",
        body: "A slow rotation on .cover-art is running on the main thread, because the same element carries clip-path and cannot be composited. Pausing it measured 85.9 -> 123.0 fps median on Home (3 paired 8 s runs).",
        action: "Turn on 'Rotating cover art' below. It is decorative; the circular crop is kept.",
      });
    }

    const items = [];
    if (s.market) {
      for (const item of [...s.market.extensions, ...s.market.snippets]) {
        const text = item.key + " " + item.name;
        for (const known of KNOWN) {
          if (known.re.test(text)) items.push({ known, item });
        }
      }
    }
    for (const hit of items) {
      recs.push({
        severity: hit.known.severity,
        title: hit.known.name,
        body: hit.known.impact,
        action: hit.known.action,
      });
    }
    return { recs, items };
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => notify("Perf Adviser: report copied to clipboard"),
        () => notify("Perf Adviser: could not copy", true)
      );
      return;
    }
    const ta = h("textarea", "position:fixed;left:-9999px;top:0;", text);
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); notify("Perf Adviser: report copied"); } catch (e) { notify("Perf Adviser: could not copy", true); }
    ta.remove();
  }

  function reportText(s, b, p) {
    const lines = [];
    lines.push("Perf Adviser " + VERSION + " - " + new Date().toISOString());
    lines.push("Route: " + (b ? b.route : s.route));
    if (b) {
      lines.push("FPS: " + b.fps + " (p95 " + b.p95 + " ms, slow frames " + b.slowPct + "%, long tasks " + b.longTaskCount + ") - " + b.runs + " x " + (b.durationMs / 1000) + "s " + (b.scrollable ? "scroll" : "idle"));
    } else {
      lines.push("FPS: not measured");
    }
    lines.push("Zoom: " + zoomPct(s.zoom.level) + ", devicePixelRatio " + s.zoom.dpr.toFixed(4));
    lines.push("Header blur: " + (s.headerBlur.length ? s.headerBlur.map((o) => o.sel + "=" + o.filter).join("; ") : "none") + " (--header-filters: " + (s.headerFilterVar || "unset") + ")");
    lines.push("Injected CSS: " + (s.cssOff ? "DISABLED" : "active") + "; CSS editor: " + (s.cssEditorChars == null ? "unknown" : s.cssEditorChars + " chars"));
    lines.push("Fixes: header blur " + (s.headerFix ? "removed" : "left alone") +
      ", Home card play button " + (s.cardPlayFix ? "hidden while scrolling" : "always shown") +
      ", rotating cover " + (s.coverPause ? "paused" : "left alone") +
      ", theme tweaks " + (s.themeTweaks ? "on" : "off") +
      "; rotating animation present: " + (s.coverRotating ? "yes" : "no"));
    if (p) {
      lines.push("Profile: " + (p.recordedMs / 1000).toFixed(1) + " s" + (p.fps ? ", " + p.fps.avg + " fps, " + p.longTasks.count + " long tasks (max " + p.longTasks.maxMs + " ms)" : ""));
      p.sources.slice(0, 10).forEach((x) => lines.push("  " + x.source + ": " + x.totalMs + " ms in " + x.calls + " calls, max " + x.maxMs + " ms" + (x.forcedCount ? ", forced " + x.forcedMs + " ms" : "")));
      lines.push("Registered since load:");
      p.inventory.slice(0, 10).forEach((x) => lines.push("  " + x.source + ": intervals " + x.interval + ", observers " + x.observer + " (broad " + x.broadObserver + "), hot listeners " + x.listener));
    }
    if (s.market) {
      lines.push("Extensions (" + s.market.extensions.length + "): " + s.market.extensions.map((e) => e.name).join(", "));
      lines.push("Snippets (" + s.market.snippets.length + "): " + s.market.snippets.map((e) => e.name).join(", "));
      lines.push("Theme: " + (s.market.theme ? s.market.theme.name : "unknown"));
    } else {
      lines.push("Marketplace data: unavailable");
    }
    const { recs } = buildRecommendations(s);
    lines.push("Findings:");
    recs.forEach((r, i) => lines.push(" " + (i + 1) + ". [" + r.severity + "] " + r.title + " - " + r.body + " " + r.action));
    return lines.join("\n");
  }

  function showPanel() {
    if (!last) return;
    const { scan: s, bench: b } = last;
    const p = last.prof || null;
    const { recs } = buildRecommendations(s);

    const root = h("div", "display:flex;flex-direction:column;gap:16px;min-width:min(620px,78vw);max-height:70vh;overflow:auto;padding:4px 2px 8px;");

    // header
    const head = h("div", "display:flex;align-items:center;justify-content:space-between;gap:12px;");
    const titleWrap = h("div", "display:flex;flex-direction:column;gap:2px;");
    titleWrap.appendChild(h("div", `font-size:12px;color:${C.sub};`, "v" + VERSION + " - " + (b ? b.route : s.route) + " - nothing is disabled automatically"));
    titleWrap.appendChild(h("div", `font-size:11px;color:${C.sub};`, "Fixes are CSS injected by this extension. Extensions, snippets and themes are never changed."));
    head.appendChild(titleWrap);
    head.appendChild(h("span", `font-size:11px;color:${C.sub};`, "no network"));
    root.appendChild(head);

    // score
    const score = h("div", `display:flex;gap:22px;align-items:flex-end;background:${C.card};border-radius:12px;padding:14px 16px;flex-wrap:wrap;`);
    const big = h("div", "display:flex;flex-direction:column;");
    big.appendChild(h("div", `font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${C.sub};`, "Scroll FPS"));
    big.appendChild(h("div", `font-size:40px;line-height:1;font-weight:700;color:${b ? (b.fps >= 90 ? C.green : b.fps >= 45 ? C.amber : C.red) : C.sub};`, b ? String(b.fps) : "--"));
    score.appendChild(big);
    if (b) {
      const metrics = h("div", "display:flex;flex-direction:column;gap:3px;");
      metrics.appendChild(row("p95 frame", b.p95 + " ms"));
      metrics.appendChild(row("slow frames", b.slowPct + " %"));
      metrics.appendChild(row("long tasks", String(b.longTaskCount)));
      metrics.appendChild(row("mode", (b.scrollable ? "scroll" : "idle") + " - " + b.runs + " x " + (b.durationMs / 1000) + " s"));
      score.appendChild(metrics);
    }
    const scoreBtns = h("div", "display:flex;gap:8px;margin-left:auto;align-self:center;");
    scoreBtns.appendChild(btn("Measure again", () => runBench(false), true));
    scoreBtns.appendChild(btn("Copy report", () => copyText(reportText(s, b, p))));
    score.appendChild(scoreBtns);
    root.appendChild(score);
    if (b && b.runs === 1) {
      root.appendChild(h("div", `font-size:11px;color:${C.sub};margin-top:-8px;`, "One short run (after a warm-up). Home FPS also depends on where the mouse rests: over a card, Spotify's play-button tooltip churns every scroll frame. 'Measure again' runs 2 x 6 s."));
    }

    // findings
    const findings = section("What to change");
    if (!recs.length) {
      findings.appendChild(h("div", `font-size:13px;color:${C.green};`, "No known offenders detected and the header blur / zoom / CSS-editor checks are clean."));
    }
    for (const r of recs) {
      const box = h("div", `display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid rgba(128,128,128,.18);`);
      const dot = h("div", `flex:0 0 8px;width:8px;height:8px;border-radius:50%;margin-top:6px;background:${SEV[r.severity] || C.sub};`);
      const body = h("div", "display:flex;flex-direction:column;gap:2px;");
      body.appendChild(h("div", `font-size:13px;font-weight:600;color:${C.text};`, r.title));
      body.appendChild(h("div", `font-size:12px;color:${C.sub};line-height:1.45;`, r.body));
      body.appendChild(h("div", `font-size:12px;color:${C.text};line-height:1.45;`, r.action));
      box.appendChild(dot);
      box.appendChild(body);
      findings.appendChild(box);
    }
    root.appendChild(findings);

    // environment
    const env = section("Environment");
    if (s.market) {
      env.appendChild(row("Extensions", String(s.market.extensions.length)));
      env.appendChild(row("Snippets", String(s.market.snippets.length)));
      env.appendChild(row("Theme", s.market.theme ? s.market.theme.name : "unknown"));
    } else {
      env.appendChild(h("div", `font-size:12px;color:${C.amber};`, "Marketplace data unavailable (is the Marketplace app loaded?)."));
    }
    env.appendChild(row("Header blur", s.headerBlur.length ? s.headerBlur.length + " active surface(s)" : "none", s.headerBlur.length ? C.red : C.green));
    env.appendChild(row("Rotating cover", s.coverRotating ? (s.coverPause ? "paused by fix" : "animating") : "not present", s.coverRotating && !s.coverPause ? C.amber : C.green));
    env.appendChild(row("Injected CSS", s.cssOff ? "disabled" : "active", s.cssOff ? C.amber : C.green));
    env.appendChild(row("CSS editor", s.cssEditorChars == null ? "unknown" : s.cssEditorChars ? s.cssEditorChars + " chars" : "empty", s.cssEditorChars ? C.amber : C.green));
    env.appendChild(row("Page zoom", (s.zoom.level == null ? "unknown" : zoomPct(s.zoom.level)) + " / DPR " + s.zoom.dpr.toFixed(3), s.zoom.level === 0 ? C.green : C.amber));
    root.appendChild(env);

    // fixes
    const fixes = section("Fixes (measured)");
    const fixCard = h("div", `display:flex;flex-direction:column;gap:0;background:${C.card};border-radius:12px;padding:4px 14px;`);

    const setFix = (key, value, message) => {
      state[key] = value;
      if (value && state.cssOff) state.cssOff = false;
      saveState(state);
      applyInjectedFixes();
      notify(message);
      refresh();
    };

    const addToggle = (opts) => {
      const row = h("div", "display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap;padding:10px 0;border-top:1px solid rgba(128,128,128,.18);");
      const text = h("div", "display:flex;flex-direction:column;gap:3px;flex:1 1 320px;min-width:240px;");
      const titleLine = h("div", "display:flex;align-items:center;gap:8px;flex-wrap:wrap;");
      titleLine.appendChild(h("div", `font-size:13px;color:${C.text};`, opts.title));
      if (opts.recommended) titleLine.appendChild(pill("recommended", C.green));
      titleLine.appendChild(pill(opts.on ? "on" : "off", opts.on ? C.green : C.sub));
      text.appendChild(titleLine);
      text.appendChild(h("div", `font-size:12px;color:${C.sub};line-height:1.4;`, opts.detail));
      row.appendChild(text);
      row.appendChild(btn(opts.action, opts.onClick, !opts.on && !!opts.recommended));
      return row;
    };

    const recOn = !s.cssOff && s.headerFix && s.cardPlayFix && s.coverPause;
    const presetRow = h("div", "display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap;padding:10px 0;");
    const presetText = h("div", "display:flex;flex-direction:column;gap:3px;flex:1 1 320px;min-width:240px;");
    presetText.appendChild(h("div", `font-size:13px;font-weight:600;color:${C.text};`, "Recommended preset"));
    presetText.appendChild(h("div", `font-size:12px;color:${C.sub};line-height:1.4;`,
      "Turns on the three fixes that measured a clear win: sticky header, Home card button, rotating cover. Cosmetic theme tweaks are left untouched."));
    presetRow.appendChild(presetText);
    if (recOn) {
      presetRow.appendChild(pill("applied", C.green));
    } else {
      presetRow.appendChild(btn("Apply recommended", () => {
        state.headerFix = true;
        state.cardPlayFix = true;
        state.coverPause = true;
        state.cssOff = false;
        saveState(state);
        applyInjectedFixes();
        notify("Perf Adviser: recommended fixes applied");
        refresh();
      }, true));
    }
    fixCard.appendChild(presetRow);

    // 1. header blur
    fixCard.appendChild(addToggle({
      title: "Sticky header blur",
      recommended: true,
      on: !!s.headerFix,
      detail: s.headerFix
        ? "Backdrop blur removed and replaced with an opaque theme background. Measured +5.8 fps on top of the card fix (66.2 -> 72.0 median)."
        : "Spotify's blurred sticky header is active. Removing it measured +5.8 fps on top of the card fix (66.2 -> 72.0 median).",
      action: s.headerFix ? "Restore blur" : "Remove blur",
      onClick: () => setFix("headerFix", !s.headerFix, s.headerFix ? "Perf Adviser: header blur restored" : "Perf Adviser: header blur removed"),
    }));

    // 2. Home card play button while scrolling
    fixCard.appendChild(addToggle({
      title: "Home card play button",
      recommended: true,
      on: !!s.cardPlayFix,
      detail: s.cardPlayFix
        ? "Hidden only while scrolling, so its tooltip stops repositioning every frame. Usable at rest; Home only. Measured 27.7 -> 66.2 fps median."
        : "Spotify repositions this tooltip on every scroll frame while the pointer rests on a card. Measured 27.7 vs 66.2 fps median.",
      action: s.cardPlayFix ? "Show button" : "Hide while scrolling",
      onClick: () => setFix("cardPlayFix", !s.cardPlayFix, s.cardPlayFix ? "Perf Adviser: play button always shown" : "Perf Adviser: play button hidden while scrolling"),
    }));

    // 3. rotating cover art
    fixCard.appendChild(addToggle({
      title: "Rotating cover art",
      recommended: true,
      on: !!s.coverPause,
      detail: s.coverPause
        ? "Decorative .cover-art rotation paused; the circular crop is kept. Measured 85.9 -> 123.0 fps median on Home."
        : (s.coverRotating
          ? "A rotation is running on .cover-art, which Chromium cannot composite because of its clip-path. Pausing it measured 85.9 -> 123.0 fps median."
          : "No rotating cover animation detected right now. Leaving this on is harmless."),
      action: s.coverPause ? "Resume rotation" : "Pause rotation",
      onClick: () => setFix("coverPause", !s.coverPause, s.coverPause ? "Perf Adviser: cover rotation resumed" : "Perf Adviser: cover rotation paused"),
    }));

    // 4. optional cosmetic bundle
    fixCard.appendChild(addToggle({
      title: "Theme tweaks",
      on: !!s.themeTweaks,
      detail: "Cosmetic only: marketplace card border, active-button colour and a 72 px player bar. Not a performance fix; off by default.",
      action: s.themeTweaks ? "Turn off" : "Turn on",
      onClick: () => setFix("themeTweaks", !s.themeTweaks, s.themeTweaks ? "Perf Adviser: theme tweaks off" : "Perf Adviser: theme tweaks on"),
    }));

    // page zoom
    const zoomRow = h("div", "display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap;border-top:1px solid rgba(128,128,128,.18);padding:10px 0;");
    const zoomText = h("div", "display:flex;flex-direction:column;gap:3px;flex:1 1 320px;min-width:240px;");
    zoomText.appendChild(h("div", `font-size:13px;color:${C.text};`, "Page zoom"));
    zoomText.appendChild(h("div", `font-size:12px;color:${C.sub};`, "Reset to 100% (fixes the whole-UI-shrink bug; not an fps fix)"));
    zoomRow.appendChild(zoomText);
    if (s.zoom.level != null && s.zoom.level !== 0) {
      zoomRow.appendChild(btn("Reset zoom to 100%", async () => {
        try {
          await Spicetify.Platform.ZoomAPI.setZoomLevel(0);
          notify("Perf Adviser: zoom reset to 100%");
          await sleep(900);
          refresh();
        } catch (e) {
          notify("Perf Adviser: zoom reset failed", true);
        }
      }, true));
    } else {
      zoomRow.appendChild(pill("100%", C.green));
    }
    fixCard.appendChild(zoomRow);

    // master kill switch
    const killRow = h("div", "display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px solid rgba(128,128,128,.18);padding:10px 0;");
    killRow.appendChild(h("div", `font-size:12px;color:${C.sub};line-height:1.4;flex:1 1 280px;`,
      s.cssOff ? "All injected fixes are off. Nothing is hidden or paused." : "Turn every injected rule off at once (state is kept, so you can switch back)."));
    if (s.cssOff) {
      killRow.appendChild(btn("Enable everything", () => {
        state.cssOff = false;
        saveState(state);
        applyInjectedFixes();
        notify("Perf Adviser: fixes enabled");
        refresh();
      }, true));
    } else {
      killRow.appendChild(btn("Disable all fixes", () => {
        state.cssOff = true;
        saveState(state);
        applyInjectedFixes();
        notify("Perf Adviser: all fixes disabled");
        refresh();
      }));
    }
    fixCard.appendChild(killRow);
    fixes.appendChild(fixCard);
    root.appendChild(fixes);

    // profiler
    const profile = section("Profile (merged from Perf Tools)");
    const pCard = h("div", `display:flex;flex-direction:column;gap:10px;background:${C.card};border-radius:12px;padding:12px 14px;`);
    const pTop = h("div", "display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap;");
    const pText = h("div", "display:flex;flex-direction:column;gap:2px;");
    pText.appendChild(h("div", `font-size:13px;color:${C.text};`, "Attribute cost by extension/script"));
    pText.appendChild(h("div", `font-size:12px;color:${C.sub};`, prof.recording
      ? "Recording - scroll the slow page, then come back and press Stop."
      : "Start, scroll the slow page for ~10 s, then Stop. Wrappers are installed only while recording."));
    pTop.appendChild(pText);
    const pBtns = h("div", "display:flex;gap:8px;flex-wrap:wrap;");
    if (prof.recording) {
      pBtns.appendChild(btn("Stop recording", () => {
        const r = prof.stop();
        last = last || { scan: null, bench: null };
        last.prof = r;
        notify("Perf Adviser: profile finished - " + (r.fps ? r.fps.avg + " fps" : "no frames"));
        refresh();
      }, true));
    } else {
      pBtns.appendChild(btn(p ? "Start again" : "Start recording", () => startProfile(), !p));
      if (p) pBtns.appendChild(btn("Copy JSON", () => copyText(JSON.stringify(p, null, 2))));
    }
    pTop.appendChild(pBtns);
    pCard.appendChild(pTop);

    if (p) {
      const sum = h("div", `font-size:12px;color:${C.sub};border-top:1px solid rgba(128,128,128,.18);padding-top:8px;`,
        (p.recordedMs / 1000).toFixed(1) + " s" + (p.fps ? " - " + p.fps.avg + " fps, p95 " + p.fps.p95 + " ms, " + p.fps.slowPct + "% slow" : "") +
        " - long tasks " + p.longTasks.count + " (max " + p.longTasks.maxMs + " ms)" + (p.loaf ? " - slow frames " + p.loaf.frames : ""));
      pCard.appendChild(sum);
      pCard.appendChild(h("div", `font-size:11px;color:${C.sub};`, "Cost by source (inclusive callback time + forced layout reads)"));
      pCard.appendChild(miniTable(
        ["source", "total ms", "calls", "max ms", "forced"],
        p.sources.slice(0, 10).map((x) => [x.source, x.totalMs, x.calls, x.maxMs, x.forcedCount ? x.forcedMs + " (" + x.forcedCount + ")" : "-"])
      ));
      pCard.appendChild(h("div", `font-size:11px;color:${C.sub};margin-top:4px;`, "Registered since load (intervals / observers / hot listeners)"));
      pCard.appendChild(miniTable(
        ["source", "int", "obs", "broad", "listen"],
        p.inventory.slice(0, 10).map((x) => [x.source, x.interval, x.observer, x.broadObserver, x.listener])
      ));
      if (p.loaf && p.loaf.scripts.length) {
        pCard.appendChild(h("div", `font-size:11px;color:${C.sub};margin-top:4px;`, "Script time by file (browser long-animation-frame data)"));
        pCard.appendChild(miniTable(
          ["file", "script ms", "forced ms", "entries"],
          p.loaf.scripts.map((x) => [x.source, x.ms, x.forcedMs, x.count])
        ));
      }
    }
    profile.appendChild(pCard);
    root.appendChild(profile);

    // footer
    const foot = h("details", `font-size:11px;color:${C.sub};line-height:1.5;`);
    foot.appendChild(h("summary", "cursor:pointer;", "How it measures / uninstall"));
    foot.appendChild(h("div", "margin-top:6px;",
      "The FPS test scrolls the largest scrollable element for a fixed time and reports median frame rate, p95 frame time, slow frames (>33 ms) and long tasks. " +
      "It runs with this panel closed, does one unmeasured warm-up scroll first, and acknowledges that Home FPS depends on where the mouse rests. " +
      "The profiler wraps timers, animation frames, event listeners and MutationObservers only while recording, then restores them. " +
      "When idle the extension runs no timers, observers or animation frames - just three passive scroll listeners. " +
      "Uninstall: run \"spicetify config extensions perf-adviser.js-\" then \"spicetify apply -n\" (or delete perf-adviser.js from %APPDATA%\\spicetify\\Extensions and remove it from config-xpui.ini)."
    ));
    root.appendChild(foot);

    Spicetify.PopupModal.display({ title: "Performance Adviser", content: root, isLarge: true });
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    last = { scan: await scan(), bench: last ? last.bench : null, prof: last ? last.prof : null };
    busy = false;
    showPanel();
  }

  async function runBench(full) {
    if (busy) return;
    busy = true;
    try {
      Spicetify.PopupModal.hide();
    } catch (e) { /* ignore */ }
    notify("Perf Adviser: measuring " + (full ? "2 x 6 s" : "5 s") + " - the page will scroll");
    await sleep(600);
    const b = await benchmark(full ? 6000 : 5000, full ? 2 : 1);
    const s = await scan();
    last = { scan: s, bench: b, prof: last ? last.prof : null };
    busy = false;
    showPanel();
    if (!full) notify("Perf Adviser: click 'Measure again' for a longer, steadier run");
  }

  function startProfile() {
    if (prof.recording) return;
    try { Spicetify.PopupModal.hide(); } catch (e) { /* ignore */ }
    prof.start();
    last = { scan: last ? last.scan : null, bench: last ? last.bench : null, prof: null };
    notify("Perf Adviser: recording - scroll the slow page, then reopen the gauge and press Stop");
  }

  async function openAdviser() {
    if (busy) { notify("Perf Adviser is already measuring"); return; }
    busy = true;
    try {
      const s = await scan();
      if (prof.recording) {
        last = { scan: s, bench: last ? last.bench : null, prof: last ? last.prof : null };
        busy = false;
        showPanel();
        return;
      }
      if (last && (last.bench || last.prof)) {
        last = { scan: s, bench: last.bench, prof: last.prof, when: Date.now() };
        busy = false;
        showPanel();
        return;
      }
      notify("Perf Adviser: measuring (about 7 s)...");
      const b = await benchmark(5000, 1);
      last = { scan: s, bench: b, prof: null, when: Date.now() };
    } finally {
      busy = false;
    }
    showPanel();
  }

  // ------------------------------------------------ keep panel.onopen fresh
  const origShowPanel = showPanel;
  showPanel = function () {
    if (last) last.when = Date.now();
    origShowPanel();
  };

  // ---------------------------------------------------------------- install
  (async function install() {
    for (let i = 0; i < 150 && !(window.Spicetify && Spicetify.PopupModal && (Spicetify.Topbar || Spicetify.Menu)); i++) {
      await sleep(200);
    }
    if (!(window.Spicetify && Spicetify.PopupModal)) return;

    const icon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 7 7h-1.5A5.5 5.5 0 1 1 8 2.5V1z"/><path d="M8 4.5v4l3 1.5.6-1.3-2.4-1.2V4.5z"/></svg>';
    if (Spicetify.Topbar && Spicetify.Topbar.Button) {
      new Spicetify.Topbar.Button("Perf Adviser", icon, openAdviser);
    } else if (Spicetify.Menu && Spicetify.Menu.Item) {
      new Spicetify.Menu.Item("Perf Adviser", false, openAdviser).register();
    }

    window.__perfAdviser = {
      version: VERSION,
      open: openAdviser,
      scan,
      benchmark,
      profile: { start: prof.start, stop: prof.stop, report: prof.report, get recording() { return prof.recording; } },
      cssEditorChars,
      getState: () => Object.assign({}, state),
      setState(patch) {
        Object.assign(state, patch || {});
        saveState(state);
        applyInjectedFixes();
        return Object.assign({}, state);
      },
      removeFixes() {
        state.headerFix = false;
        state.cardPlayFix = false;
        state.coverPause = false;
        state.themeTweaks = false;
        state.cssOff = true;
        saveState(state);
        applyInjectedFixes();
      },
    };
  })();
})();

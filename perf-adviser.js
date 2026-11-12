// perf-adviser.js - in-app performance adviser for this Spotify + Spicetify setup.
//
// What it does
//   - injects two measured, individually switchable fixes (the recommended set):
//       1. removes the sticky-header backdrop blur (opaque theme background)
//       2. hides the Home card play button only while scrolling (its tooltip
//          is repositioned on every scroll frame)
//   - one opt-in override for a rotating .cover-art animation. The rotation is
//     normally added by a snippet/theme the user installed, so the panel first
//     names that source and suggests disabling it; pausing it here is only a
//     fallback for people who want to keep the effect.
//   - one optional cosmetic bundle (marketplace card border, active-button
//     colour, 72 px player bar) - not a performance fix, off by default
//   - runtime CSS patches: Chromium treats every live :has() rule as a
//     document-wide invalidation source, so one tooltip opening can restyle
//     thousands of elements. The patch engine mirrors the two global :has()
//     anchors installed by track-peek and parks :has() rules that currently
//     match nothing, restoring each one as soon as its target appears.
//   - scans the live environment generically: installed Marketplace
//     extensions/snippets/theme, every CSS source (rule counts, :has(), blur,
//     infinite animations), running animations and their source, header blur,
//     page zoom and CSS-editor leftovers. No name has to be on a list.
//   - runs the same scroll FPS test used by the offline harness, inside Spotify
//   - includes the profiler that used to live in spx-perf.js: start recording,
//     scroll, stop, and see cost attributed by extension/script; the biggest
//     non-Spotify sources then become findings automatically
//
// What it never does
//   - it does not disable, uninstall or update any extension/snippet/theme
//   - it makes no network requests
//   - it does not touch Spotify's own files
//   - it does not poll on a timer; the patch engine wakes on DOM mutations and
//     only re-checks rules whose precondition was touched. The one timed retry is
//     a short re-park loop that runs only while a revived rule is still live
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
  const PANEL_ID = "perf-adviser-panel-style";
  const PANEL_MODAL = "perf-adviser-modal";

  // The panel uses Spotify's PopupModal, whose surface is translucent
  // (rgba(...,.7) plus a backdrop blur in Lucid). While our panel is open we
  // give both modal layers an opaque version of that same theme colour, so text
  // stays readable over any page behind it. Scoped to our own modal only.
  const PANEL_CSS = `
.${PANEL_MODAL} {
  background-color: var(--perf-adviser-surface, #121212) !important;
  backdrop-filter: none !important;
}
`;

  // ---------------------------------------------------------------- CSS blocks
  // Each fix is a separate block so it can be measured and disabled on its own.
  // Every rule is scoped to Spotify's own class names and is reversible.

  // 1. Sticky header surfaces: drop the per-frame backdrop blur and use an opaque,
  //    theme-coloured background so scrolling content does not show through.
  //    Measured +5.8 fps on Home on top of the card fix;
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
  //    Measured +38.5 fps median (3 paired 8 s runs, pointer on a card
  //    play button so its tooltip is mounted).
  const CARDPLAY_CSS = [
    "/* Perf Adviser fix 2: hide the Home card play button only while scrolling. */",
    "html." + SCROLL_CLASS + " [data-testid=\"home-page\"] .main-card-PlayButtonContainer { display: none !important; }",
  ].join("\n");

  // 3. OPT-IN override. Many themes/snippets put a slow full rotation on
  //    .cover-art. That element also carries clip-path and border-radius, so
  //    Chromium cannot composite the transform and runs it on the main thread
  //    every frame. The rotation is decorative; removing the snippet/theme that
  //    adds it is the clean fix, so this only runs when the user turns it on.
  //    Pausing it keeps the circular crop; measured +37.1 fps median on
  //    Home (3 paired 8 s runs) when the rotation was active.
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

  // ---------------------------------------------------------------- state
  // Recommended set: the two fixes that measured a clear win on their own.
  // coverPause is opt-in because the rotation almost always comes from a
  // snippet/theme the user installed - naming and removing the source is the
  // honest fix, and the toggle exists for people who want to keep the look.
  // themeTweaks is cosmetic and stays off unless the user turns it on.
  const DEFAULTS = {
    headerFix: true,
    cardPlayFix: true,
    coverPause: false,
    themeTweaks: false,
    runtimePatch: true,
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

  // ------------------------------------------------------- panel surface
  // Spotify's PopupModal surface is translucent (rgba(...,.7) + a 32 px blur in
  // Lucid). Reuse its own colour at full alpha so the panel matches the theme
  // but stays readable over whatever page is behind it. Scoped to our modal.
  function ensurePanelStyle() {
    if (document.getElementById(PANEL_ID)) return;
    const el = document.createElement("style");
    el.id = PANEL_ID;
    el.textContent = PANEL_CSS;
    (document.head || document.documentElement).appendChild(el);
  }

  // Opaque version of whatever surface colour the theme gives this modal.
  function surfaceColor(modal) {
    const cs = getComputedStyle(modal);
    const trip = (cs.getPropertyValue("--clr-surface-rgb") || "").trim();
    if (/^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/.test(trip)) return "rgb(" + trip + ")";
    const parse = (v) => {
      const m = /rgba?\(([^)]+)\)/.exec(v || "");
      if (!m) return null;
      const p = m[1].split(",").map((x) => parseFloat(x));
      if (p.length < 3 || (p.length > 3 && p[3] < 0.01)) return null;
      return "rgb(" + Math.round(p[0]) + "," + Math.round(p[1]) + "," + Math.round(p[2]) + ")";
    };
    return parse(cs.backgroundColor) ||
      parse(cs.getPropertyValue("--spice-main")) ||
      parse(cs.getPropertyValue("--spice-card")) ||
      "#121212";
  }

  function skinModal(attempt) {
    const nodes = document.querySelectorAll(".GenericModal.spicetify-popup");
    const modal = nodes[nodes.length - 1];
    // PopupModal may mount a tick after display() returns; wait for our content.
    if (!modal || !(modal.textContent || "").includes("Runtime CSS patches")) {
      if ((attempt || 0) < 10) setTimeout(() => skinModal((attempt || 0) + 1), 60);
      return;
    }
    ensurePanelStyle();
    for (const el of document.querySelectorAll("." + PANEL_MODAL)) el.classList.remove(PANEL_MODAL);
    const color = surfaceColor(modal);
    modal.style.setProperty("--perf-adviser-surface", color);
    modal.classList.add(PANEL_MODAL);
    // The theme sets its translucent surface with a higher-specificity
    // !important :has() rule, so an inline !important declaration is needed.
    modal.style.setProperty("background-color", color, "important");
    modal.style.setProperty("backdrop-filter", "none", "important");
    const inner = modal.querySelector(".spicetify-popup-container");
    if (inner) {
      inner.style.setProperty("background-color", color, "important");
      inner.style.setProperty("backdrop-filter", "none", "important");
      inner.classList.add(PANEL_MODAL);
    }
  }

  // ------------------------------------------------------- runtime CSS patches
  // Chromium's :has() invalidation is document-wide: while any live :has() rule
  // exists, opening one tooltip can restyle thousands of elements. Two patches:
  //
  //   1. track-peek's stylesheet starts selectors with :has(), so they can
  //      match any element in the document. Mirror those conditions with
  //      classes we keep in sync, and drop the :has() from the selector.
  //   2. Every other :has() rule that currently matches nothing is parked
  //      (selector replaced with an inert one). It is restored as soon as
  //      something it targets appears. Rules that are in use are never touched.
  //
  // Measured on the installed build (3 rounds): one top-bar hover costs
  // 118-160 ms of style recalc over ~1,050-1,100 elements -> 83-93 ms over ~450
  // (median 134 -> 90); restyles over 20 ms: 2 -> 0. A 4 s icon sweep:
  // 563-649 ms and 9-10 big restyles -> 367-421 ms and 0. Card hover worst
  // frame hit ~49 ms in 1 of 3 rounds without the patch; 7 ms in all 3 with it.
  const PARK_PREFIX = "perf-adviser-parked-";
  const PEEK_WRAP = "perf-adviser-peek-wrap";
  const PEEK_ANCHOR = "perf-adviser-peek-anchor";
  const PEEK_WRAP_SEL = ":has(> .track-peek)";
  const PEEK_ANCHOR_SEL = ':has(> [data-testid="player-controls"] .track-peek)';

  const runtime = {
    parked: [],          // { rule, original, sentinel }
    live: 0,
    mirrored: 0,
    precond: "",
    seq: 0,
    scans: 0,
    revives: 0,
    scanTimer: null,
    reviveTimer: null,
    deepTimer: null,
    reparkTimer: null,
    reparkTries: 0,
    pending: [],
    lastRevive: 0,
    installed: false,
    headObserver: null,
    bodyObserver: null,
  };

  function patchesActive() {
    return !!state.runtimePatch && !state.cssOff;
  }

  // Split a selector list on commas that are not inside (), [] or quotes.
  function splitTopLevel(text) {
    const out = [];
    let depth = 0, quote = null, cur = "";
    for (const ch of text) {
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function forEachStyleRule(cb) {
    for (const sheet of [...document.styleSheets]) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      if (!rules) continue;
      const walk = (list) => {
        for (const rule of list) {
          if (rule.cssRules) walk(rule.cssRules);   // @media, @supports, nesting
          if (rule.selectorText) {
            try { cb(rule); } catch (e) { /* ignore one bad rule */ }
          }
        }
      };
      walk(rules);
    }
  }

  // 0 = matches nothing, >0 = in use, 1 = unknown (never park an unknown).
  function matchesAny(selector) {
    let n = 0;
    for (const part of splitTopLevel(selector)) {
      try { n += document.querySelectorAll(part).length; } catch (e) { return 1; }
      if (n > 0) return n;
    }
    return n;
  }

  function mirrorPeekRules(on) {
    let n = 0;
    forEachStyleRule((rule) => {
      const sel = rule.selectorText;
      if (sel === PEEK_ANCHOR_SEL || (on && sel === "." + PEEK_ANCHOR)) {
        rule.selectorText = on ? "." + PEEK_ANCHOR : PEEK_ANCHOR_SEL;
        n++;
      } else if (sel === PEEK_WRAP_SEL || (on && sel === "." + PEEK_WRAP)) {
        rule.selectorText = on ? "." + PEEK_WRAP : PEEK_WRAP_SEL;
        n++;
      }
    });
    return n;
  }

  // Keep the mirror classes equal to what the original :has() rules would match.
  function updatePeekMirrors(on) {
    if (!on) {
      for (const el of document.querySelectorAll("." + PEEK_WRAP)) el.classList.remove(PEEK_WRAP);
      for (const el of document.querySelectorAll("." + PEEK_ANCHOR)) el.classList.remove(PEEK_ANCHOR);
      return;
    }
    for (const peek of document.querySelectorAll(".track-peek")) {
      const wrap = peek.parentElement;
      if (wrap) wrap.classList.add(PEEK_WRAP);
      const controls = peek.closest('[data-testid="player-controls"]');
      if (controls && controls.parentElement) controls.parentElement.classList.add(PEEK_ANCHOR);
    }
    for (const el of document.querySelectorAll("." + PEEK_WRAP)) {
      if (!el.querySelector(":scope > .track-peek")) el.classList.remove(PEEK_WRAP);
    }
    for (const el of document.querySelectorAll("." + PEEK_ANCHOR)) {
      if (!el.querySelector(':scope > [data-testid="player-controls"] .track-peek')) el.classList.remove(PEEK_ANCHOR);
    }
  }

  // Last compound of a relative selector: the part that appears or disappears.
  // Used only as a cheap mutation filter, never as the real match test.
  function lastCompound(rel) {
    let depth = 0, quote = null, cur = "", last = "";
    for (const ch of rel) {
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      const combinator = depth === 0 && (ch === " " || ch === ">" || ch === "+" || ch === "~" || ch === "\n" || ch === "\t");
      if (combinator) { if (cur.trim()) { last = cur.trim(); cur = ""; } continue; }
      cur += ch;
    }
    if (cur.trim()) last = cur.trim();
    return last;
  }

  function preconditionsFor(selector) {
    const out = [];
    let i = 0;
    while ((i = selector.indexOf(":has(", i)) >= 0) {
      let depth = 0, quote = null, j = i + 5;
      for (; j < selector.length; j++) {
        const ch = selector[j];
        if (quote) { if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === "(") depth++;
        else if (ch === ")") { if (depth === 0) break; depth--; }
      }
      const inner = selector.slice(i + 5, j);
      for (const rel of splitTopLevel(inner)) {
        const c = lastCompound(rel);
        if (c && c !== "*" && !c.includes(":has(")) out.push(c);
      }
      i = j + 1;
    }
    return out;
  }

  function rebuildPreconditions() {
    const set = new Set([".track-peek"]);
    for (const p of runtime.parked) {
      const list = preconditionsFor(p.original);
      p.precond = list.join(",");
      for (const c of list) set.add(c);
    }
    runtime.precond = [...set].join(",");
  }

  // Does any mutation in this batch touch a node that could satisfy `selector`?
  // Used to skip the full match test for rules whose precondition is unrelated.
  function nodesTouch(records, selector) {
    if (!selector) return true;
    for (const rec of records) {
      if (rec.type === "attributes") {
        if (safeMatches(rec.target, selector)) return true;
        continue;
      }
      for (const node of rec.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (safeMatches(node, selector) || safeQuery(node, selector)) return true;
      }
    }
    return false;
  }

  function reviveMatching(records) {
    runtime.lastRevive = performance.now();
    let changed = false;
    const filter = records && records.length ? records : null;
    for (const p of runtime.parked) {
      if (!p.rule || !p.rule.parentStyleSheet) continue;
      if (p.rule.selectorText !== p.sentinel) continue;
      if (filter && p.precond && !nodesTouch(filter, p.precond)) continue;
      if (matchesAny(p.original) > 0) {
        try { p.rule.selectorText = p.original; changed = true; } catch (e) { /* ignore */ }
      }
    }
    if (changed) {
      runtime.reparkTries = 0;
      runtime.revives++;
      rebuildPreconditions();
      // The target is visible now; check again later so a rule can be parked
      // again after its dialog/menu closes.
      scheduleScan(1500);
      if (!runtime.deepTimer) {
        runtime.deepTimer = setTimeout(() => {
          runtime.deepTimer = null;
          fullScan();
        }, 6000);
      }
    }
  }

  function scheduleRevive(ms, records) {
    if (records) {
      for (const r of records) {
        runtime.pending.push(r);
        if (runtime.pending.length > 400) runtime.pending.shift();
      }
    }
    if (runtime.reviveTimer) return;
    const wait = Math.max(ms, 800 - (performance.now() - runtime.lastRevive));
    runtime.reviveTimer = setTimeout(() => {
      runtime.reviveTimer = null;
      if (!patchesActive()) { runtime.pending = []; return; }
      const recs = runtime.pending;
      runtime.pending = [];
      updatePeekMirrors(true);
      reviveMatching(recs);
    }, Math.max(0, wait));
  }

  function safeMatches(el, selector) {
    if (!selector) return false;
    try { return el.matches(selector); } catch (e) { return true; }
  }

  function safeQuery(el, selector) {
    if (!selector) return false;
    try { return !!el.querySelector(selector); } catch (e) { return true; }
  }

  // Parked rules that are currently restored because their target appeared.
  function liveParkedCount() {
    let n = 0;
    for (const p of runtime.parked) {
      try { if (p.rule && p.rule.parentStyleSheet && p.rule.selectorText === p.original) n++; } catch (e) { /* ignore */ }
    }
    return n;
  }

  function onPatchMutations(records) {
    const pre = runtime.precond;
    let flip = false;
    for (const rec of records) {
      if (rec.type === "attributes") {
        if (rec.attributeName === "style") continue;
        if (safeMatches(rec.target, pre)) { flip = true; break; }
      } else {
        for (const node of rec.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (safeMatches(node, pre) || (node.firstElementChild && safeQuery(node, pre))) { flip = true; break; }
        }
      }
      if (flip) break;
    }
    const peekTouched = !!document.querySelector(".track-peek, ." + PEEK_WRAP + ", ." + PEEK_ANCHOR);
    // A new track-peek must get its mirror class before the next frame, not
    // after the revive timer, or the pill renders unstyled for a moment.
    if (peekTouched) updatePeekMirrors(true);
    if (flip || peekTouched) scheduleRevive(150, records);
    // Keep trying to park revived rules again (dialog/menu closed) without
    // waiting for a mutation-free window that this app never has.
    if (liveParkedCount() > 0) scheduleRepark(1200);
  }

  function scheduleScan(ms) {
    if (runtime.scanTimer) clearTimeout(runtime.scanTimer);
    runtime.scanTimer = setTimeout(() => {
      runtime.scanTimer = null;
      fullScan();
    }, ms);
  }

  // Retry parking on a fixed cadence. Spotify mutates the DOM every second or
  // so, so a debounced scan would never run; this one is not reset by mutations
  // and keeps retrying until nothing revived is left live.
  function scheduleRepark(ms) {
    if (runtime.reparkTimer) return;
    if (runtime.reparkTries >= 6) return;
    runtime.reparkTimer = setTimeout(() => {
      runtime.reparkTimer = null;
      if (!patchesActive()) return;
      runtime.reparkTries++;
      fullScan();
      if (liveParkedCount() > 0) scheduleRepark(1500);
      else runtime.reparkTries = 0;
    }, ms);
  }

  function fullScan() {
    if (!patchesActive()) return;
    runtime.scans++;
    mirrorPeekRules(true);
    updatePeekMirrors(true);

    runtime.parked = runtime.parked.filter((p) => p.rule && p.rule.parentStyleSheet);

    // Re-check rules we already know about: park them again when their target
    // goes away, restore them when it comes back.
    for (const p of runtime.parked) {
      let sel = "";
      try { sel = p.rule.selectorText; } catch (e) { continue; }
      if (sel === p.sentinel) {
        if (matchesAny(p.original) > 0) {
          try { p.rule.selectorText = p.original; } catch (e) { /* ignore */ }
        }
      } else if (sel === p.original) {
        if (matchesAny(p.original) === 0) {
          try { p.rule.selectorText = p.sentinel; } catch (e) { /* ignore */ }
        }
      }
    }

    const tracked = new Set(runtime.parked.map((p) => p.rule));
    let live = 0;
    forEachStyleRule((rule) => {
      const sel = rule.selectorText;
      if (!sel.includes(":has(")) return;
      if (tracked.has(rule)) return;
      if (sel === "." + PEEK_ANCHOR || sel === "." + PEEK_WRAP) return;
      if (sel.startsWith(PARK_PREFIX)) return;
      if (matchesAny(sel) > 0) { live++; return; }
      const original = sel;
      const sentinel = PARK_PREFIX + (++runtime.seq);
      try { rule.selectorText = sentinel; } catch (e) { return; }
      runtime.parked.push({ rule, original, sentinel, precond: preconditionsFor(original).join(",") });
    });

    runtime.live = live + runtime.parked.filter((p) => {
      try { return p.rule.selectorText === p.original; } catch (e) { return false; }
    }).length;
    runtime.mirrored = document.querySelectorAll("." + PEEK_ANCHOR + ", ." + PEEK_WRAP).length;
    rebuildPreconditions();
  }

  function installPatchObservers() {
    if (runtime.installed) return;
    runtime.installed = true;
    try {
      runtime.headObserver = new MutationObserver(() => scheduleScan(500));
      runtime.headObserver.observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true });
    } catch (e) { /* ignore */ }
    try {
      runtime.bodyObserver = new MutationObserver(onPatchMutations);
      runtime.bodyObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
    } catch (e) { /* ignore */ }
    try {
      document.addEventListener("focusin", () => scheduleRevive(200), true);
      window.addEventListener("popstate", () => scheduleScan(600));
    } catch (e) { /* ignore */ }
    try {
      if (Spicetify.Platform && Spicetify.Platform.History && Spicetify.Platform.History.listen) {
        Spicetify.Platform.History.listen(() => scheduleScan(700));
      }
    } catch (e) { /* ignore */ }
  }

  function syncRuntimePatches() {
    if (!patchesActive()) {
      if (runtime.reparkTimer) { clearTimeout(runtime.reparkTimer); runtime.reparkTimer = null; }
      for (const p of runtime.parked) {
        try { p.rule.selectorText = p.original; } catch (e) { /* ignore */ }
      }
      runtime.parked = [];
      runtime.live = 0;
      runtime.mirrored = 0;
      mirrorPeekRules(false);
      updatePeekMirrors(false);
      rebuildPreconditions();
      return;
    }
    installPatchObservers();
    fullScan();
  }
  syncRuntimePatches();
  // Stylesheets are injected by Marketplace after this file runs; a couple of
  // delayed scans pick them up without polling.
  setTimeout(() => scheduleScan(0), 1500);
  setTimeout(() => scheduleScan(0), 5000);

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

  // The rotation can be added by a snippet, the theme or an extension. The
  // animation name stays readable even when our opt-in CSS has paused it, so it
  // identifies the source, not our fix.
  function coverAnimationName() {
    const el = document.querySelector(".cover-art");
    if (!el) return "";
    const name = getComputedStyle(el).animationName;
    return name && name !== "none" && /rotat|spin/i.test(name) ? name : "";
  }

  // Marketplace packs every snippet into one <style class="marketplaceSnippets">
  // and prefixes each block with "/* Title - description */". Splitting on those
  // comments gives per-snippet CSS without relying on names or a fixed list.
  function snippetSources() {
    const out = [];
    const el = document.querySelector("style.marketplaceSnippets");
    const txt = (el && el.textContent) || "";
    if (!txt) return out;
    const marks = [...txt.matchAll(/\/\*\s*([\s\S]*?)\s*\*\//g)].filter((m) => /\s-\s/.test(m[1]));
    for (let i = 0; i < marks.length; i++) {
      const head = marks[i][1];
      const name = (head.split(" - ")[0] || head).trim();
      const start = marks[i].index + marks[i][0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index : txt.length;
      out.push({ kind: "snippet", name, code: txt.slice(start, end) });
    }
    return out;
  }

  // Theme CSS is either a <style class="marketplaceCSS marketplaceUserCSS"> or a
  // <link href="user.css">. Broken rules in a stylesheet make cssRules throw, so
  // both paths are guarded.
  function themeSources() {
    const st = document.querySelector("style.marketplaceCSS.marketplaceUserCSS");
    if (st && st.textContent) return [{ kind: "theme", name: "Theme user.css", code: st.textContent }];
    const link = document.querySelector("link[href='user.css'], link.userCSS");
    if (!link) return [];
    try {
      const sheet = [...document.styleSheets].find((s) => s.ownerNode === link);
      if (sheet && sheet.cssRules) {
        return [{ kind: "theme", name: "Theme user.css", code: [...sheet.cssRules].map((r) => r.cssText).join("\n") }];
      }
    } catch (e) { /* ignore */ }
    return [{ kind: "theme", name: "Theme user.css (not readable)", code: "" }];
  }

  // Count the signals that make a block of CSS expensive to keep valid during
  // scrolling. These are counts, not measured fps: they say where to look.
  function cssStats(code) {
    const count = (re) => (String(code).match(re) || []).length;
    return {
      chars: String(code).length,
      rules: count(/\{/g),
      has: count(/:has\(/g),
      blur: count(/backdrop-filter|filter\s*:[^;}]*blur/gi),
      anim: count(/animation(-name)?\s*:/gi),
      infinite: count(/\binfinite\b/gi),
      sticky: count(/position\s*:\s*(sticky|fixed)/gi),
      important: count(/!important/g),
    };
  }

  function cssSources() {
    const srcs = [...snippetSources(), ...themeSources()];
    // Extension-injected <style> blocks (not ours, not the Marketplace's).
    for (const el of document.querySelectorAll("style")) {
      if (el.id === FIX_ID) continue;
      if (el.classList.contains("marketplaceSnippets") || el.classList.contains("marketplaceCSS")) continue;
      const code = el.textContent || "";
      if (code.length < 120) continue;
      const label = el.id ? "#" + el.id : "inline <style>";
      srcs.push({ kind: "style", name: label, code });
    }
    const out = [];
    for (const s of srcs) {
      if (!s.code) continue;
      const st = cssStats(s.code);
      st.score = st.has * 3 + st.blur * 3 + st.infinite * 2 + st.anim + Math.round(st.rules / 200);
      out.push({ kind: s.kind, name: s.name, code: s.code, ...st });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  // Which source declares this animation? Exact name first, then a rotation rule
  // aimed at the cover, so a minified name still resolves to its snippet.
  function animationSource(name, sources) {
    if (name) {
      for (const s of sources) if (s.code && s.code.indexOf(name) >= 0) return s;
    }
    for (const s of sources) {
      if (s.code && /animation[^;}]*rotate|rotate[^;}]*infinite/i.test(s.code) && /cover-art|coverArt/i.test(s.code)) return s;
    }
    return null;
  }

  // Infinite animations that are actually running (or paused by our override).
  function infiniteAnimations() {
    let list = [];
    try { list = document.getAnimations ? document.getAnimations() : []; } catch (e) { list = []; }
    const out = [];
    const seen = new Set();
    for (const a of list) {
      let timing = null;
      try { timing = (a.effect && a.effect.getTiming()) || null; } catch (e) { timing = null; }
      if (!timing || timing.iterations !== Infinity) continue;
      const t = a.effect && a.effect.target;
      if (!t || t.id === FIX_ID) continue;
      let nm = a.animationName || "";
      if (!nm) { try { nm = getComputedStyle(t).animationName || ""; } catch (e) { nm = ""; } }
      const cls = (t.className && String(t.className).trim().split(/\s+/).slice(0, 2).join(".")) || t.tagName.toLowerCase();
      const key = nm + "@" + cls;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: nm || "(unnamed)", target: t.tagName.toLowerCase() + (cls ? "." + cls : ""), state: a.playState });
    }
    return out;
  }

  async function scan() {
    const [market, zoom] = await Promise.all([readMarketplace(), readZoom()]);
    const css = cssSources();
    const coverName = coverAnimationName();
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
      coverRotating: !!coverName,
      coverName,
      coverSource: coverName ? animationSource(coverName, css) : null,
      css,
      animations: infiniteAnimations(),
      cssOff: !!state.cssOff,
      runtimePatch: !!state.runtimePatch,
      runtime: {
        active: patchesActive(),
        parked: runtime.parked.length,
        live: runtime.live,
        mirrored: runtime.mirrored,
      },
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

  function buildRecommendations(s, p) {
    const recs = [];
    if (s.headerBlur.length) {
      recs.push({
        severity: "high",
        title: "Sticky header blur is active",
        body: "Measured +5.8 fps on Home on top of the card fix; on its own the gain is within noise (+1.5 fps). " + s.headerBlur.length + " surface(s) currently carry backdrop-filter.",
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
        body: "With the cursor over a card, Spotify's play-button tooltip is repositioned on every scroll frame. Hiding it while scrolling measured +38.5 fps median (paired, 3 rounds).",
        action: "Turn on 'Home card play button' below. It keeps the button usable at rest and only affects Home.",
      });
    }
    const hasRules = (s.css || []).reduce((n, c) => n + (c.has || 0), 0);
    if (!s.runtime || (s.runtime.active === false && hasRules >= 10)) {
      recs.push({
        severity: "medium",
        title: "Idle :has() CSS rules make every hover restyle the app",
        body: "Chromium treats any live :has() rule as document-wide, even one that matches nothing. " + hasRules +
          " :has() selectors are loaded; without the runtime patch, one top-bar tooltip costs 118-160 ms of style recalculation across ~1,050 elements and up to a ~49 ms frame.",
        action: "Turn on 'Runtime CSS patches' below. It only parks rules that match nothing and restores each one when its target appears.",
      });
    }
    if (s.coverRotating) {
      const src = s.coverSource ? s.coverSource.name : "";
      const kind = s.coverSource ? (s.coverSource.kind === "theme" ? "theme" : s.coverSource.kind === "style" ? "style block" : "snippet") : "";
      const where = s.coverSource && s.coverSource.kind === "theme" ? "Marketplace > Themes" : "Marketplace > Snippets";
      if (s.coverPause) {
        recs.push({
          severity: "info",
          title: "Rotating cover art is paused by this extension",
          body: (src ? "The " + kind + " \"" + src + "\" adds the rotation; the pause only overrides it. " : "") +
            "Pausing the rotation measured +37.1 fps median on Home (3 paired 8 s runs).",
          action: src ? "Cleaner: disable \"" + src + "\" in " + where + " and turn this toggle off." : "Keep this on only if you want the rotation gone and cannot find its source.",
        });
      } else {
        recs.push({
          severity: "medium",
          title: src ? "Rotating cover art: source is " + src : "Rotating cover art is animating",
          body: (src ? "The " + kind + " \"" + src + "\" animates .cover-art" : "An installed snippet or theme animates .cover-art") +
            " with an infinite rotation. With it paused, Home gained +37.1 fps median (3 paired 8 s runs). Removing the source is the real fix; 'Pause rotation' only hides the cost.",
          action: src ? "Disable \"" + src + "\" in " + where + " for the same gain. Use 'Pause rotation' only if you want to keep the look." : "Find the snippet or theme that adds it and disable it; or use 'Pause rotation' as an override.",
        });
      }
    }

    // Measured attribution from the built-in profiler. Generic: whatever the
    // user recorded becomes the finding, no allow-list of names involved.
    if (p && p.sources && p.sources.length) {
      const skip = /^(spotify-core|\(unknown\)|\(anonymous\/eval\)|spicetifyWrapper\.js|perf-adviser\.js)$/;
      const heavy = p.sources.filter((x) => !skip.test(x.source) && (x.totalMs + (x.forcedMs || 0)) >= 250).slice(0, 3);
      for (const t of heavy) {
        const ms = Math.round(t.totalMs + (t.forcedMs || 0));
        const share = p.recordedMs ? Math.round((100 * ms) / p.recordedMs) : 0;
        recs.push({
          severity: share >= 25 ? "high" : "medium",
          title: "Profile: " + t.source + " used " + ms + " ms",
          body: ms + " ms in " + t.calls + " callback(s) over " + (p.recordedMs / 1000).toFixed(1) + " s of recording" +
            (share ? " (~" + share + "% of the window)" : "") + ", longest " + Math.round(t.maxMs) + " ms" +
            (t.forcedCount ? "; includes " + Math.round(t.forcedMs) + " ms of forced layout reads" : "") + ". This is measured, not a guess.",
          action: "If you do not need it, disable it in Marketplace and record again to compare.",
        });
      }
    }

    // CSS cost signals, generic. Only the top source and only when the counts are
    // notable; skip when that same source is already named above.
    const cssTop = (s.css || []).find((x) => x.score > 0);
    const coverName = s.coverSource ? s.coverSource.name : "";
    if (cssTop && cssTop.name !== coverName && (cssTop.has >= 80 || cssTop.blur >= 6 || cssTop.infinite >= 2 || cssTop.chars > 400000)) {
      recs.push({
        severity: "info",
        title: "Heavy CSS signals in " + cssTop.name,
        body: cssTop.rules + " rules, " + cssTop.has + " :has() selectors, " + cssTop.blur + " blur rule(s), " +
          Math.round(cssTop.chars / 1024) + " KB of CSS, " + cssTop.infinite + " infinite animation(s). " +
          "These are counts, not a measured fps cost, but they make style recalc more expensive on every scroll.",
        action: "If you do not need it, disable it and press 'Measure again' to compare on your own machine.",
      });
    }

    return { recs };
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
    if (s.coverSource) lines.push("Cover animation source: " + s.coverSource.name + " (" + s.coverSource.kind + ")");
    if (s.animations && s.animations.length) {
      lines.push("Infinite animations: " + s.animations.slice(0, 8).map((a) => a.name + " on " + a.target + " (" + a.state + ")").join(", "));
    }
    if (s.css && s.css.length) {
      lines.push("CSS sources by signal:");
      s.css.slice(0, 5).forEach((x) => lines.push("  " + x.name + " [" + x.kind + "]: " + x.rules + " rules, " + x.has + " :has(), " + x.blur + " blur, " + x.infinite + " infinite, " + Math.round(x.chars / 1024) + " KB"));
    }
    const { recs } = buildRecommendations(s, p);
    lines.push("Findings:");
    recs.forEach((r, i) => lines.push(" " + (i + 1) + ". [" + r.severity + "] " + r.title + " - " + r.body + " " + r.action));
    return lines.join("\n");
  }

  function showPanel() {
    if (!last) return;
    const { scan: s, bench: b } = last;
    const p = last.prof || null;
    const { recs } = buildRecommendations(s, p);

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
    scoreBtns.appendChild(btn("Measure again", () => runBench(true), true));
    scoreBtns.appendChild(btn("Copy report", () => copyText(reportText(s, b, p))));
    score.appendChild(scoreBtns);
    root.appendChild(score);
    if (b && b.runs === 1) {
      root.appendChild(h("div", `font-size:11px;color:${C.sub};margin-top:-8px;`, "One short run (after a warm-up). Home FPS also depends on where the mouse rests: over a card, Spotify's play-button tooltip churns every scroll frame. 'Measure again' runs 2 x 6 s."));
    }

    // findings
    const findings = section("What to change");
    if (!recs.length) {
      findings.appendChild(h("div", `font-size:13px;color:${C.green};`, "No live offender right now: header blur, zoom, CSS-editor leftovers and infinite animations are clean. Record a profile on a slow page for per-script cost."));
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
    env.appendChild(row("Rotating cover", s.coverRotating
      ? (s.coverPause ? "paused by fix" : "animating") + (s.coverSource ? " - from " + s.coverSource.name : "")
      : "not present", s.coverRotating && !s.coverPause ? C.amber : C.green));
    env.appendChild(row("Injected CSS", s.cssOff ? "disabled" : "active", s.cssOff ? C.amber : C.green));
    env.appendChild(row("CSS editor", s.cssEditorChars == null ? "unknown" : s.cssEditorChars ? s.cssEditorChars + " chars" : "empty", s.cssEditorChars ? C.amber : C.green));
    env.appendChild(row("Page zoom", (s.zoom.level == null ? "unknown" : zoomPct(s.zoom.level)) + " / DPR " + s.zoom.dpr.toFixed(3), s.zoom.level === 0 ? C.green : C.amber));
    root.appendChild(env);

    // Generic CSS inventory: every snippet, the theme and extension <style>
    // blocks, ranked by expensive signals. Counts only - the profiler gives
    // measured attribution, so nothing here depends on a name being known.
    const cssSec = section("Installed CSS (signals)");
    const cssCard = h("div", `display:flex;flex-direction:column;gap:8px;background:${C.card};border-radius:12px;padding:12px 14px;`);
    const cssRows = (s.css || []).slice(0, 5).map((x) => [
      x.name, String(x.rules), String(x.has), String(x.blur), String(x.infinite), Math.round(x.chars / 1024) + " KB",
    ]);
    if (cssRows.length) {
      cssCard.appendChild(miniTable(["source", "rules", ":has()", "blur", "infinite", "size"], cssRows));
      cssCard.appendChild(h("div", `font-size:11px;color:${C.sub};line-height:1.4;`,
        "Counts are signals for style-recalc risk, not measured fps. Record a profile on the slow page to attribute real main-thread time."));
    } else {
      cssCard.appendChild(h("div", `font-size:12px;color:${C.sub};`, "No snippet, theme or extension CSS found."));
    }
    cssSec.appendChild(cssCard);
    root.appendChild(cssSec);

    // fixes
    const fixes = section("Fixes (measured)");
    const fixCard = h("div", `display:flex;flex-direction:column;gap:0;background:${C.card};border-radius:12px;padding:4px 14px;`);

    const setFix = (key, value, message) => {
      state[key] = value;
      if (value && state.cssOff) state.cssOff = false;
      saveState(state);
      applyInjectedFixes();
      syncRuntimePatches();
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

    const recOn = !s.cssOff && s.headerFix && s.cardPlayFix;
    const presetRow = h("div", "display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap;padding:10px 0;");
    const presetText = h("div", "display:flex;flex-direction:column;gap:3px;flex:1 1 320px;min-width:240px;");
    presetText.appendChild(h("div", `font-size:13px;font-weight:600;color:${C.text};`, "Recommended preset"));
    presetText.appendChild(h("div", `font-size:12px;color:${C.sub};line-height:1.4;`,
      "Turns on the two fixes that measured a clear win: sticky header blur and the Home card button. Rotating cover is opt-in because an installed snippet or theme usually adds it; removing that source is better than overriding it."));
    presetRow.appendChild(presetText);
    if (recOn) {
      presetRow.appendChild(pill("applied", C.green));
    } else {
      presetRow.appendChild(btn("Apply recommended", () => {
        state.headerFix = true;
        state.cardPlayFix = true;
        state.runtimePatch = true;
        state.cssOff = false;
        saveState(state);
        applyInjectedFixes();
        syncRuntimePatches();
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
        ? "Backdrop blur removed and replaced with an opaque theme background. Measured +5.8 fps on top of the card fix."
        : "Spotify's blurred sticky header is active. Removing it measured +5.8 fps on top of the card fix.",
      action: s.headerFix ? "Restore blur" : "Remove blur",
      onClick: () => setFix("headerFix", !s.headerFix, s.headerFix ? "Perf Adviser: header blur restored" : "Perf Adviser: header blur removed"),
    }));

    // 2. Home card play button while scrolling
    fixCard.appendChild(addToggle({
      title: "Home card play button",
      recommended: true,
      on: !!s.cardPlayFix,
      detail: s.cardPlayFix
        ? "Hidden only while scrolling, so its tooltip stops repositioning every frame. Usable at rest; Home only. Measured +38.5 fps median."
        : "Spotify repositions this tooltip on every scroll frame while the pointer rests on a card. Measured a +38.5 fps median gain.",
      action: s.cardPlayFix ? "Show button" : "Hide while scrolling",
      onClick: () => setFix("cardPlayFix", !s.cardPlayFix, s.cardPlayFix ? "Perf Adviser: play button always shown" : "Perf Adviser: play button hidden while scrolling"),
    }));

    // 3. rotating cover art (opt-in; usually added by an installed snippet/theme)
    const coverSrcName = s.coverSource ? s.coverSource.name : "";
    const coverWhere = s.coverSource && s.coverSource.kind === "theme" ? "Marketplace > Themes" : "Marketplace > Snippets";
    fixCard.appendChild(addToggle({
      title: "Rotating cover art (opt-in)",
      on: !!s.coverPause,
      detail: s.coverPause
        ? "Paused by this extension. " + (coverSrcName ? coverSrcName + " adds the rotation; disabling it is the cleaner fix." : "Disabling the snippet/theme that adds the rotation is the cleaner fix.")
        : (s.coverRotating
          ? (coverSrcName
            ? coverSrcName + " rotates .cover-art. Disabling it in " + coverWhere + " removes the cost at the source. Pausing here is only an override; measured +37.1 fps median."
            : "An installed snippet/theme rotates .cover-art. Disabling it is the cleaner fix; pausing here measured +37.1 fps median.")
          : "No rotating cover animation detected right now, so this toggle would do nothing."),
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
        syncRuntimePatches();
        notify("Perf Adviser: fixes enabled");
        refresh();
      }, true));
    } else {
      killRow.appendChild(btn("Disable all fixes", () => {
        state.cssOff = true;
        saveState(state);
        applyInjectedFixes();
        syncRuntimePatches();
        notify("Perf Adviser: all fixes disabled");
        refresh();
      }));
    }
    fixCard.appendChild(killRow);
    fixes.appendChild(fixCard);
    root.appendChild(fixes);

    // runtime CSS patches (separate: they do not inject any CSS rule)
    const rt = s.runtime || { active: false, parked: 0, live: 0, mirrored: 0 };
    const rtSec = section("Runtime CSS patches");
    const rtCard = h("div", `display:flex;flex-direction:column;gap:0;background:${C.card};border-radius:12px;padding:4px 14px;`);
    const rtRow = h("div", "display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap;padding:10px 0;");
    const rtText = h("div", "display:flex;flex-direction:column;gap:3px;flex:1 1 320px;min-width:240px;");
    const rtTitle = h("div", "display:flex;align-items:center;gap:8px;flex-wrap:wrap;");
    rtTitle.appendChild(h("div", `font-size:13px;color:${C.text};`, "Park idle :has() rules"));
    rtTitle.appendChild(pill(rt.active ? "on" : "off", rt.active ? C.green : C.sub));
    rtTitle.appendChild(pill(rt.parked + " parked", rt.parked ? C.green : C.sub));
    if (rt.mirrored) rtTitle.appendChild(pill(rt.mirrored + " mirrored", C.blue));
    rtText.appendChild(rtTitle);
    rtText.appendChild(h("div", `font-size:12px;color:${C.sub};line-height:1.4;`,
      "Chromium treats any live :has() rule as document-wide, so one tooltip can restyle the whole app. " +
      "This parks rules that currently match nothing and restores each one when its target appears; " +
      "the two global :has() anchors installed by track-peek are mirrored with a class instead. " +
      "Measured on the installed build: one top-bar hover 118-160 ms -> 83-93 ms of style recalc " +
      "(restyles over 20 ms: 2 -> 0); card hover worst frame ~49 ms -> 7 ms. " +
      (rt.live ? rt.live + " :has() rule(s) are in use and untouched." : "")));
    rtRow.appendChild(rtText);
    rtRow.appendChild(btn(rt.active ? "Turn off" : "Turn on", () => {
      state.runtimePatch = !state.runtimePatch;
      if (state.runtimePatch && state.cssOff) state.cssOff = false;
      saveState(state);
      applyInjectedFixes();
      syncRuntimePatches();
      notify(state.runtimePatch ? "Perf Adviser: runtime CSS patches on" : "Perf Adviser: runtime CSS patches off");
      refresh();
    }, !rt.active));
    rtCard.appendChild(rtRow);
    rtSec.appendChild(rtCard);
    root.appendChild(rtSec);

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
      "The CSS/animation inventory is read only when the panel is built, never on a timer. " +
      "Uninstall: run \"spicetify config extensions perf-adviser.js-\" then \"spicetify apply -n\" (or delete perf-adviser.js from %APPDATA%\\spicetify\\Extensions and remove it from config-xpui.ini)."
    ));
    root.appendChild(foot);

    Spicetify.PopupModal.display({ title: "Performance Adviser", content: root, isLarge: true });
    skinModal();
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
        syncRuntimePatches();
        return Object.assign({}, state);
      },
      patchInfo: () => ({
        active: patchesActive(),
        parked: runtime.parked.length,
        live: runtime.live,
        mirrored: runtime.mirrored,
        scans: runtime.scans,
        revives: runtime.revives,
        liveOriginals: runtime.parked
          .filter((p) => { try { return p.rule && p.rule.parentStyleSheet && p.rule.selectorText === p.original; } catch (e) { return false; } })
          .map((p) => p.original.slice(0, 100))
          .slice(0, 10),
        preconditions: runtime.precond,
      }),
      removeFixes() {
        state.headerFix = false;
        state.cardPlayFix = false;
        state.coverPause = false;
        state.themeTweaks = false;
        state.runtimePatch = false;
        state.cssOff = true;
        saveState(state);
        applyInjectedFixes();
        syncRuntimePatches();
      },
    };
  })();
})();

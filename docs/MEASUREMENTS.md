# Measurements

All numbers below were taken on one machine, with the extension loaded in the
user's normal Spicetify setup. They are medians of paired or interleaved runs,
not absolute promises: your hardware, theme and installed snippets will change
the result. The panel measures your own client.

Test conditions unless noted otherwise: Windows 11, Spotify **1.3.8.620**
(Chromium 151), Spicetify **2.46.4**, Lucid theme, 1922 x 1080 viewport, 8 s
synthetic scroll of Home, pointer parked on a card play button with its tooltip
mounted, three interleaved rounds in one session.

## Scroll performance

| Active fixes | Median FPS | p95 frame | Slow frames (>33 ms) | Tooltip style writes / 8 s | Long tasks / 8 s |
|---|---|---|---|---|---|
| None | 27.7 | 138.9 ms | 23.9 % | 1,331 | 47 |
| Header blur only | 29.2 | 138.9 ms | 21.8 % | 1,252 | 45 |
| Card button only | 66.2 | 20.9 ms | 3.4 % | 386 | 12 |
| Rotating cover only | 33.5 | 131.9 ms | 18.3 % | 1,345 | 45 |
| Header + card | 72.0 | 20.9 ms | 3.3 % | 387 | 13 |
| Header + card + cover pause (opt-in) | 104.8 | 14.0 ms | 2.1 % | 388 | 12 |

In that scenario - pointer resting on a Home card, rotating-cover snippet
installed - the recommended preset's header + card row measured **+44.3 fps
(2.6x)** over no fixes.

What the table means:

- The card-button fix is the largest single win here: it cuts tooltip style
  writes from ~1,331 to ~386 per 8 s and long tasks from 47 to 12.
- The cover pause adds most of its gain **after** the card fix (+32.8 fps on top
  of header + card), because the tooltip churn otherwise hides it. On its own it
  measured only +5.8 fps.
- The header fix is small on its own (+1.5 fps, within noise) but adds +5.8 fps
  on top of the card fix. It stays in the preset because it is low risk and
  fixes the visible ghosting of scrolling content through the header.
- The rotation in this test came from the **Rotating Cover Art** snippet, not
  from Spotify. Disabling that snippet removes the same cost without the
  override; the toggle is a fallback.

A separate paired test with the card fix already on measured **+37.1 fps**
(median) when the rotating cover was paused.

## Top-bar hover and idle `:has()` rules

Hovering a top-bar icon mounts a tooltip. In this setup, while many `:has()`
rules were live, a single hover restyled thousands of elements; with the rules
that matched nothing parked, that work dropped. Three rounds on the installed
build, runtime patch off vs on, same session:

| Runtime patch | Style recalc, one hover | Worst frame, card hover | Restyles >20 ms | 4 s top-bar icon sweep |
|---|---|---|---|---|
| Off | 118-160 ms (median 134) | 7.1-7.2 ms in 2 rounds, ~49 ms in 1 | 2 | 563-649 ms, 9-10 big |
| On | 83-93 ms (median 90) | 7.1-7.2 ms in all 3 | 0 | 367-421 ms, 0 big |

A hover on a **Made for you** card behaved the same way: p95 frame time was 7 ms
in every round, but without the patch the worst frame hit ~49 ms in one of three
rounds; with it, the worst frame stayed at 7 ms in all three. The patch left the
11-12 `:has()` rules that were genuinely in use untouched, including the
empty-search-field rule.

The hover table is not a scroll measurement: style recalc and element counts
come from a single tooltip hover, the 4 s sweep is a synthetic pointer sweep
across four top-bar icons, and the worst-frame column comes from holding the
pointer on one card. All are paired in the same session; the absolute element
counts vary with how much of Home has loaded.

## Idle overhead

With the extension loaded but every fix off (kill switch on), versus a reload
where the extension file was blocked at the network layer, 45 s idle windows,
three alternating pairs:

| State | Script time / 45 s | Task time / 45 s | Style time / 45 s | Heap |
|---|---|---|---|---|
| Extension loaded, fixes off | 0.117 s | 40.7 s | 16.4 s | 124.5 MB |
| Stock (extension blocked) | 0.015 s | 41.4 s | 18.7 s | 124.9-200.7 MB |

**Why task time is high in both rows.** These columns come from Chromium's CDP
`Performance` counters. `TaskDuration` is every main-thread task the renderer
ran in the window, and Spotify's own playback UI, animations and timers keep the
main thread busy; ~40 s of work in a 45 s window is normal for both the loaded
and the blocked client. It is not extension work. The extension's own share is
the `ScriptDuration` column: about 0.1 s per 45 s (~2.5 ms/s), and the ~0.7 s
difference between the two task-time columns is within reload-to-reload noise.

With the kill switch on it registers no repeating timers, observers or animation
frames; only three passive scroll/wheel/touchmove listeners, and the profiler
wrappers are installed only during a recording. The CSS/animation inventory is
read when you open the panel or start a measurement, never on a timer.

With **Runtime CSS patches** on, it adds two `MutationObserver`s (body and head),
`focusin`/`popstate`/history listeners, and a short burst of scans while the page
loads and stylesheets arrive. Those scans settle: in a measured session the
engine ran 11-12 scans in the first ~10 seconds and none afterwards, and parked
rules are only re-checked when a mutation or navigation could affect them.

## Caveats, stated plainly

- These are **rAF frame intervals during a synthetic `scrollTop` sweep**, not a
  real wheel scroll, and the display refreshes above 100 Hz, so absolute FPS can
  exceed 60. Compare rows, not the number itself.
- Home content is lazy-loaded and differs between sessions, which is why all
  conditions were interleaved on **one** page instead of reloading between them.
  Reload-based comparisons on this machine swung by more than 3x on identical
  CSS.
- One machine, one theme setup. Your numbers will differ; the panel measures
  yours.

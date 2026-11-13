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

## Hover cost and idle `:has()` rules

Hover numbers are easy to misattribute. If the pointer enters a control from a
different region - the player bar, another shelf - Chromium first clears that
region's hover state and restyles the page. The result then describes the
region change, not the control. The protocol here parks the pointer at a
nearby non-interactive point outside the target, waits, then enters. Each row
is a median of three rounds in one session, runtime patch on vs off, with the
**Made for you** shelf in view.

| Target | Runtime patch on | Runtime patch off |
|---|---|---|
| **Made for you** card title | 378 elements, ~80 ms | 951 elements, ~195 ms |
| Player bar play/pause | 381 elements, ~80 ms | 938 elements, ~162 ms |
| Top-bar icon | 7 elements, ~49 ms | 7 elements, ~68 ms |
| Home filter chip | 4 elements, ~63 ms | 4 elements, ~64 ms |
| Shelf heading | 3 elements, ~60 ms | 3 elements, ~61 ms |
| "Show all" | 3 elements, ~49 ms | 3 elements, ~65 ms |

"Elements" is the largest style recalculation in the hover trace and is the
stable column. The millisecond figure is all style time in the same window and
moves with Spotify's cover animations, so compare it only within a row. The
whole table is one page and one session; a quieter or busier Home changes the
counts a little.

What this means:

- A top-bar icon, a filter chip, a shelf heading and **Show all** were never
  the problem: their hovers restyle 3-7 elements.
- The expensive hovers are the wide card box and the player bar. Parking idle
  `:has()` rules cuts their restyle scope by about 2.5x (951 -> 378 and
  938 -> 381). It does **not** remove the hitch: entering a card still runs one
  main-thread task over 40 ms (~50 ms in the profile) and a ~40 ms layout
  pass, with the patch on or off. The extension's own script time in these
  traces is 0.2-2 ms.
- The trigger is the card box, not the title text. Entering the title and
  entering a blank part of the same card produce the same ~377-element restyle
  and the same task, so moving the hover effect to a narrower target does not
  help.

A realistic sweep across three card titles and the shelf heading (two rounds
per sweep, ~206 frames) still shows the residual:

| Runtime patch | p95 frame | Worst frame | Frames >33 ms | Frames >50 ms |
|---|---|---|---|---|
| On | 27.7-34.7 ms | 76-90 ms | 6-13 | 6 |
| Off | 55.5 ms | 118 ms | 17-20 | 8-10 |

The patch roughly halves the number of slow frames, but it cannot make a card
enter smooth, because the remaining cost is Spotify's own card-hover
re-render. Nine CSS-only candidates were measured and rejected: rewriting
`:hover > *` (five variants), parking all 141 hover-combinator rules,
containment on the shelf/grid/card/tippy roots, `content-visibility` on cards,
blocking the cover videos, and pausing the rotating-cover animation. None
changed the frames or the task.

With the patch on, 160-162 idle `:has()` rules are parked and 11-12 stay live
because they currently match, including the empty-search-field rule. The
engine's scans settle at 11-12 in the first ~10 s and then stay flat. The
track-peek mirror rewrites its two global anchors to classes; it was verified
by selector inspection, not end to end, because track-peek itself was failing
in that session (see the report).

**Retraction.** Earlier versions of this page reported 118-160 ms of style
recalc for one top-bar hover, falling to 83-93 ms with the patch, a
1,050-1,100-element restyle, and a 4 s top-bar sweep of 563-649 ms. Those
figures came from starting the pointer on the player bar; they measured the
region change, not the icon, and are retracted. The earlier "card hover worst
frame ~49 ms, 7 ms with the patch" claim is retracted too: with the corrected
protocol the card hitch is still there with the patch on.

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

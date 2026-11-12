# Performance Adviser

A single-file Spicetify extension that measures your Spotify UI's scroll performance and removes three specific causes of stutter.

![Performance Adviser panel](preview.png)

Performance Adviser does **not** make Spotify's own code faster. It removes UI costs that themes, snippets and Spotify's hover behaviour add on top of it. Each fix is a separate toggle, so you can measure and undo every change.

## Features

- **Measured fixes, not guesses.** Every toggle has a before/after number from the same machine in the panel, and the panel can re-run the scroll test in your own client.
- **Three independent fixes**
  - disables the sticky-header backdrop blur (the single largest cost on blurred themes such as Lucid);
  - hides the Home card play button only while scrolling, which stops Spotify from repositioning its tooltip on every scroll frame;
  - pauses a decorative rotating `.cover-art` animation that Chromium cannot composite.
- **Recommended preset.** One button enables the three fixes that measured a clear win. Nothing cosmetic is included.
- **Built-in profiler.** Record a slow scroll and see callback time attributed by source (extension/script file), forced layout reads, long tasks, and long-animation-frame data. Wrappers exist only while recording and are restored on stop.
- **Live environment scan.** Shows Marketplace extensions and snippets, the active theme, active backdrop-filter surfaces, a rotating cover, page zoom, and leftover CSS.
- **One kill switch.** Removes every injected rule at once, keeping your chosen state for later.
- **No network access, no timers while idle, no changes to other extensions, themes or snippets.** It only injects reversible CSS and reads the DOM.

## Install

### Spicetify Marketplace (recommended)

1. Open **Marketplace → Extensions**.
2. Search for **Performance Adviser** and install it.
3. Restart Spotify when prompted.

### Manually

1. Download `perf-adviser.js` from this repository.
2. Copy it into your Spicetify extensions folder:
   - Windows: `%APPDATA%\spicetify\Extensions\`
   - Linux/macOS: `~/.config/spicetify/Extensions/`
3. Add it as the **first** entry of the extensions list and apply:

   ```sh
   spicetify config extensions perf-adviser.js
   spicetify apply -n
   ```

   Running `spicetify config extensions perf-adviser.js` puts it at the front if the list was empty; if you already have extensions, edit the `extensions` line so that `perf-adviser.js` comes first. Loading it early means its CSS is present before theme styles settle.
4. Restart Spotify.

## Usage

1. Click the gauge icon in the top bar.
2. Read the score card: median scroll FPS, p95 frame time, slow frames and long tasks. **Measure again** runs the test twice more; closing the panel during the test keeps the number honest.
3. **What to change** lists anything the scan found, with the measured cost of each item.
4. Use the toggles under **Fixes (measured)**. Each one applies or removes its CSS immediately and is stored in `localStorage`.
5. If you want a starting point, press **Apply recommended**.
6. For a specific slow page, press **Start recording**, scroll the page for about ten seconds, then **Stop recording**. The profile names the extension or script that owns the cost.

## Settings

| Setting | Default | What it does | Risk |
|---|---|---|---|
| Sticky header blur | On | Sets `--header-filters: none` and gives the five sticky header surfaces an opaque theme background. Removes the per-frame re-blur while content scrolls behind them. | The header loses its frosted look and becomes a solid band. Themes that intentionally use a translucent header will look different. |
| Home card play button | On | Adds a scroll class and hides `.main-card-PlayButtonContainer` **only while scrolling and only under `[data-testid="home-page"]`**, which stops the tooltip from being repositioned every frame. | The button disappears during a scroll and returns when you stop. Marketplace install/remove buttons use the same class and are **not** affected by this scoped rule. |
| Rotating cover art | On | Pauses any running animation on `.cover-art` and the now-playing cover container pseudo-elements, keeping the circular crop. | If a theme uses that animation as a deliberate effect, the cover will look frozen. Harmless when no rotation is present. |
| Theme tweaks | Off | Cosmetic bundle: Marketplace installed-card border, active-button colour, 72 px player bar. Not a performance fix. | Purely visual and theme-specific. Off by default and never part of the recommended preset. |
| Disable all fixes | — | Kill switch for every injected rule. State is kept, so **Enable everything** restores your selection. | None. |

The panel remembers your choices in `localStorage["perf-adviser:state"]`.

## Measured results

Test conditions: Windows, Spotify **1.3.8.620** (Chromium 151), Spicetify **2.46.4**, 1922 × 1080 viewport, 8 s synthetic scroll on Home, pointer parked on a card play button with its tooltip mounted, three interleaved rounds in one session. Values are medians of the three rounds.

| Active fixes | Median FPS | p95 frame | Slow frames (>33 ms) | Tooltip style writes / 8 s | Long tasks / 8 s |
|---|---|---|---|---|---|
| None | 27.7 | 138.9 ms | 23.9 % | 1,331 | 47 |
| Header blur only | 29.2 | 138.9 ms | 21.8 % | 1,252 | 45 |
| Card button only | 66.2 | 20.9 ms | 3.4 % | 386 | 12 |
| Rotating cover only | 33.5 | 131.9 ms | 18.3 % | 1,345 | 45 |
| Header + card | 72.0 | 20.9 ms | 3.3 % | 387 | 13 |
| **Recommended preset** | **104.8** | **14.0 ms** | **2.1 %** | **388** | **12** |

What the table means:

- The card-button fix is the largest single win in this scenario: it cuts tooltip style writes from ~1,331 to ~386 per 8 s and long tasks from 47 to 12.
- The cover pause adds most of its gain **after** the card fix (+32.8 fps on top of header + card), because the tooltip churn otherwise hides it. On its own it measured only +5.8 fps.
- The header fix is small on its own (+1.5 fps, within noise) but adds +5.8 fps on top of the card fix. It stays in the preset because it is low risk and fixes the visible ghosting of scrolling content through the header.
- All three together reach **3.8×** the all-off frame rate in this test.

A separate paired test with the card fix already on measured **85.9 → 123.0 fps** (median) when the rotating cover was paused.

Caveats, stated plainly:

- These are **rAF frame intervals during a synthetic `scrollTop` sweep**, not a real wheel scroll, and the display refreshes above 100 Hz, so absolute FPS can exceed 60. Compare rows, not the number itself.
- Home content is lazy-loaded and differs between sessions, which is why all conditions were interleaved on **one** page instead of reloading between them. Reload-based comparisons on this machine swung from 32 to 110 fps on identical CSS.
- One machine, one theme setup. Your numbers will differ; the panel measures yours.

### Idle overhead

With the extension loaded but every fix off (kill switch on), versus a reload where the extension file was blocked at the network layer, 45 s idle windows, three alternating pairs:

| State | Script time / 45 s | Total task time / 45 s | Heap |
|---|---|---|---|
| Extension loaded, fixes off | 0.117 s | 40.7 s | 124.5 MB |
| Stock (extension blocked) | 0.015 s | 41.4 s | 124.9–200.7 MB |

The extension's own script time is around 2.5 ms per second of idle, and total task time is within reload-to-reload noise. It registers no timers, observers or animation frames while idle; only three passive scroll/wheel/touchmove listeners, and the profiler wrappers are installed only during a recording.

## Compatibility

| Component | Tested |
|---|---|
| Spotify | 1.3.8.620 (Chromium 151), 1.3.7.2752 |
| Spicetify | 2.46.4 |
| OS | Windows 11 |
| Marketplace | Extensions tab, install and remove |

The fixes target Spotify class names and CSS variables (`--header-filters`, `.main-topBar-background`, `.main-home-filterChipsSection`, `[data-testid="home-page"]`, `.main-card-PlayButtonContainer`, `.cover-art`). Spotify UI updates can rename them; if that happens the panel's Environment section will report no active blur or no rotating cover, and the matching fix simply does nothing.

## Known limitations

- **It cannot speed up Spotify's own JavaScript.** Tracklist re-renders, network work and Spotify's React tree are outside its reach. Large playlist gains require disabling heavy third-party extensions (for example sort-play), which this extension will never do for you.
- The header fix only helps when something applies `backdrop-filter` to the sticky header — usually a theme. On a stock-looking client it is inert.
- The cover fix assumes the rotation is decorative. A theme that intentionally animates album art will look frozen while the fix is on.
- "Slow" is relative: a synthetic scroll is harsher than a real wheel scroll, so use the ranking and the toggles to test on your own machine.
- The tooltip fix is Home-specific by design; applying it globally would hide Marketplace install/remove buttons, which reuse the same container class.

## Troubleshooting

| Symptom | Check |
|---|---|
| No gauge button in the top bar | Is `perf-adviser.js` listed in `extensions`? Run `spicetify apply -n` and restart Spotify. |
| Panel opens but a fix does nothing | Check the Environment section: no blur or no rotation means there is nothing to remove on that page/theme. |
| Header is still blurred | Another extension or the theme may re-apply `backdrop-filter` with higher specificity. The Environment section counts active surfaces; report the case with a **Copy report**. |
| FPS looks low right after opening | Home lazy-loads shelves. Let the page settle, keep the pointer off the card grid for a stable baseline, and use **Measure again**. |
| Cover is frozen and you want it back | Turn off **Rotating cover art**. |
| Something else looks wrong | Use **Disable all fixes**, then report the issue with the **Copy report** JSON and your Spotify/Spicetify versions. |

Uninstall in one line:

```sh
spicetify config extensions perf-adviser.js- && spicetify apply -n
```

Then delete `perf-adviser.js` from your Spicetify extensions folder if you wish.

## Contributing

Issues and pull requests are welcome. A useful bug report includes:

- Spotify and Spicetify versions;
- whether each of the three fixes was on;
- the **Copy report** JSON from the panel;
- what page was being scrolled and where the pointer was.

The extension must stay self-contained: one `.js` file, no build step, no remote code, no network requests.

## License

[MIT](LICENSE)

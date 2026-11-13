# Performance Adviser

A single-file Spicetify extension that measures your Spotify UI's scroll performance, finds the installed snippet, theme or extension responsible, and removes the cost with reversible CSS.

![Performance Adviser panel](preview.png)

![Release downloads](https://img.shields.io/github/downloads/10k-Reaper/spicetify-performance-adviser/total?label=release%20downloads)

It does not rewrite Spotify's own JavaScript. Each fix is a separate toggle, and the panel shows the before/after number it measured for that toggle.

## Features

- **Two independent, recommended fixes**
  - removes the sticky-header backdrop blur by setting `--header-filters: none` and giving the five header surfaces a theme-coloured background;
  - hides the Home card play button only while scrolling, which stops Spotify from repositioning its tooltip on every scroll frame.
- **Runtime CSS patches.** In our tests, hovering a wide Home card restyled 951 elements while the idle `:has()` rules were live; parking the rules that matched nothing cut that to 378. It cannot remove Spotify's own card re-render, which is the remaining hover hitch. The engine mirrors track-peek's two global anchors with a class, parks other `:has()` rules that match nothing, and restores each one when its target appears. Rules in use are left alone.
- **Opt-in cover pause.** A rotating `.cover-art` animation is usually added by a snippet you installed, such as Marketplace's [Rotating Cover Art](https://github.com/spicetify/marketplace/blob/main/resources/snippets.json). When the panel can identify the source it names it, because removing the source is the real fix. **Pause rotation** exists only for people who want to keep the look.
- **Generic detection, no allow-list.** Reads every snippet, theme and extension `<style>` block, counts expensive CSS signals (`:has()`, blur, infinite animations, rule count), and turns the profiler's measured per-script cost into findings.
- **Recommended preset.** One button enables the two CSS fixes plus the runtime CSS patches. Nothing cosmetic and nothing snippet-specific is included.
- **Built-in profiler.** Record a slow scroll and see callback time attributed by source, forced layout reads, long tasks and long-animation-frame data. Wrappers exist only while recording and are restored on stop.
- **Live environment scan.** Counts of Marketplace extensions and snippets, the active theme, active backdrop-filter surfaces, the heaviest CSS sources ranked by cost signals, infinite-animation counts per source, and page zoom.
- **One kill switch.** Turns every injected rule and every runtime patch off at once, keeping your chosen state for later.
- **No network, no file edits.** It injects reversible CSS, temporarily rewrites selectors in already-loaded stylesheets, and reads the DOM. It makes no network requests and never writes files or changes installed extensions.
- **What it changes.** In-memory CSS, the selectors of loaded `:has()` rules (restored when their target appears), and - only when you press the button - Spotify's page zoom.

## Install

### Spicetify Marketplace (recommended)

1. Open **Marketplace → Extensions**.
2. Search for **Performance Adviser** and install it.
3. Restart Spotify when prompted.

### Manually

1. Download [`perf-adviser.js`](https://github.com/10k-Reaper/spicetify-performance-adviser/releases/download/v1.0.1/perf-adviser.js) from the [v1.0.1 release](https://github.com/10k-Reaper/spicetify-performance-adviser/releases/tag/v1.0.1) (or `gh release download v1.0.1 -R 10k-Reaper/spicetify-performance-adviser`).
2. Copy it into your Spicetify extensions folder:
   - Windows: `%APPDATA%\spicetify\Extensions\`
   - Linux/macOS: `~/.config/spicetify/Extensions/`
3. Add it to the extensions list and apply:

   ```sh
   spicetify config extensions perf-adviser.js
   spicetify apply -n
   ```

   The command appends `perf-adviser.js` to the list, or creates the line if none exists. Extension order does not matter here: its CSS uses `!important` and the patch engine rescans every loaded stylesheet.
4. Restart Spotify.

> The badge at the top counts **release-asset downloads only**: people who fetch `perf-adviser.js` directly. Marketplace installs are served through jsDelivr, so GitHub never sees them. Read it as a manual-download count, not an install count.

## Usage

1. Click the **Perf Adviser** icon in the top bar (the clock badge).
2. Read the score card: median scroll FPS, p95 frame time, slow frames and long tasks. **Measure again** runs two longer 6 s runs; the panel closes itself for them, because an open popup costs frames.
3. **What to change** lists live evidence: an active header blur, a running animation with the snippet/theme that declares it, CSS blocks with heavy selector counts, or the measured sources from your last profile.
4. Use the toggles under **Fixes (measured)**. Each one applies or removes its CSS immediately and is stored in `localStorage`.
5. If you want a starting point, press **Apply recommended**.
6. If the interface looks shrunken after backgrounding, press **Reset zoom to 100%** under **Page zoom**. This is a display fix, not an FPS fix.
7. For a specific slow page, press **Start recording**, scroll for about ten seconds, then reopen the panel and press **Stop recording**. The profile names the extension or script that owns the cost.

## Settings

| Setting | Default | What it does | Risk |
|---|---|---|---|
| Sticky header blur | On | Sets `--header-filters: none` and gives the five sticky header surfaces the theme's surface colour as a solid background. Removes the per-frame re-blur while content scrolls behind them. | The header loses its frosted look. Themes that intentionally use a translucent header will look different, and themes that hard-code the filter ignore the variable. |
| Home card play button | On | Adds a scroll class and hides `.main-card-PlayButtonContainer` **only while scrolling and only under `[data-testid="home-page"]`**, which stops the tooltip from being repositioned every frame. | The button disappears during a scroll and returns when you stop. Marketplace install/remove buttons use the same class and are **not** affected. |
| Rotating cover art (opt-in) | Off | Pauses animations on `.cover-art` and the now-playing cover pseudo-elements, keeping the circular crop. When it can identify the source, the panel names the snippet/theme that declares the animation. | If a theme or snippet rotates the cover on purpose and you want to keep it, leave this off. |
| Theme tweaks | Off | Cosmetic bundle: Marketplace installed-card border, active-button colour, 72 px player bar. Not a performance fix. | Purely visual and theme-specific. Never part of the recommended preset. |
| Runtime CSS patches | On | Mirrors the two `track-peek` global `:has()` anchors with a class and parks other `:has()` rules that currently match nothing, restoring each one when its target appears. | Other rules that are in use are never touched. A parked rule comes back in well under a second. If a dialog looks wrong, turn this off and report the selector. |
| Page zoom | 100% | Shows the current zoom. When it is not 100%, offers **Reset zoom to 100%**, which fixes the whole-UI-shrink bug after backgrounding. | Changes Spotify's page-zoom setting; this is the only Spotify setting the extension can change, and only when you press the button. |
| Disable all fixes | - | Kill switch for every injected rule and every runtime patch. State is kept, so **Enable everything** restores your selection. | None. |

The panel remembers your choices in `localStorage["perf-adviser:state"]`.

## Results

The package is tuned for the common case: a blurred theme (Lucid) on Home. In a test where the pointer rested on a Home card and the Rotating Cover Art snippet was installed, the recommended preset measured **27.7 → 72.0 fps (+44.3 fps, 2.6×)**; the card-button fix alone accounted for most of it. Those are synthetic scroll numbers from one machine, and your client may differ.

Full tables and caveats - scroll, hover/`:has()`, idle overhead - are in [docs/MEASUREMENTS.md](https://github.com/10k-Reaper/spicetify-performance-adviser/blob/main/docs/MEASUREMENTS.md).

## Compatibility

| Component | Tested |
|---|---|
| Spotify | 1.3.8.620 (Chromium 151), 1.3.7.2752 |
| Spicetify | 2.46.4, 2.46.7 |
| OS | Windows 11 |
| Marketplace | Extensions tab, install and remove |

**Untested on Linux/macOS.** The manual install paths are listed above, but no behaviour was measured there.

The fixes target Spotify class names and CSS variables (`--header-filters`, `.main-topBar-background`, `.main-home-filterChipsSection`, `[data-testid="home-page"]`, `.main-card-PlayButtonContainer`, `.cover-art`). Spotify UI updates can rename them; if that happens, the Environment section reports no active blur or no rotating cover, and the matching fix simply does nothing.

The runtime patch knows only two selectors by name - track-peek's two global `:has()` anchors. Everything else is discovered generically from the loaded stylesheets, so a Spotify class rename does not break it; at worst a rule is parked while its target is absent.

## Known limitations

- **It cannot speed up Spotify's own JavaScript.** Tracklist re-renders, network work and Spotify's React tree are outside its reach. For large playlists, record a profile and test disabling the heavy third-party extensions it names.
- The header fix only works when the theme applies `backdrop-filter` through `--header-filters` (Lucid does). A theme that hard-codes the filter ignores the variable.
- CSS counts (`:has()`, blur, rule count) are **signals**, not measured fps. Only the profiler attributes real main-thread time.
- **Runtime patches are CSS-only.** They cannot make Spotify's JavaScript faster, and they only park `:has()` rules that match nothing. The behaviour depends on how Chromium's `:has()` invalidation works today (measured on Chromium 151); if a future version removes the cost, the patch becomes unnecessary rather than harmful.
- The tooltip fix is Home-specific by design; applying it globally would hide Marketplace install/remove buttons, which reuse the same container class.

## Troubleshooting

| Symptom | Check |
|---|---|
| No Perf Adviser icon in the top bar | Is `perf-adviser.js` listed in `extensions`? Run `spicetify apply -n` and restart Spotify. Without top-bar buttons, use the **Perf Adviser** menu item. |
| Panel opens but a fix does nothing | Check the Environment section: no blur or no rotation means there is nothing to remove on that page/theme. |
| Header is still blurred | Another extension or the theme may re-apply `backdrop-filter` with higher specificity. Report the case with **Copy report**. |
| FPS looks low right after opening | Home lazy-loads shelves. Let the page settle, keep the pointer off the card grid for a stable baseline, and use **Measure again**. |
| Cover is frozen and you want it back | Turn off **Rotating cover art (opt-in)**. |
| A menu or dialog looks wrong after enabling patches | Turn off **Park idle :has() rules**, then report the dialog with the **Copy report** text. |
| Not sure what to disable | Open **Installed CSS (signals)**, then record a profile on the slow page. Any source that used 250 ms or more appears under **What to change**. |
| Something else looks wrong | Use **Disable all fixes**, then report the issue with the **Copy report** text and your Spotify/Spicetify versions. |

Uninstall in one line:

```sh
spicetify config extensions perf-adviser.js- && spicetify apply -n
```

Then delete `perf-adviser.js` from your Spicetify extensions folder if you wish.

## Contributing

Issues and pull requests are welcome. A useful bug report includes:

- Spotify and Spicetify versions;
- whether each recommended fix was on, and whether the opt-in cover pause was on;
- the **Copy report** text from the panel;
- what page was being scrolled and where the pointer was.

The extension must stay self-contained: one `.js` file, no build step, no remote code, no network requests.

## License

[MIT](LICENSE)

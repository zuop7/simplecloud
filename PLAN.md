# SimpleCloud — Plan

A personal desktop shell for SoundCloud. Not an API client: it loads the real site in an
embedded Chromium view and re-skins it — hiding what is useless, reflowing what is kept,
and adding a native player bar, a native queue and a search history.

Status: milestones 4 and 5 are implemented — search records submitted queries and opened results in one local MRU list of ten, and listening mode is a 1180x360 window with a bottom strip outside the site view, a hover-revealed bar (now with a progress line), a fitted waveform hero and a queue that grows the window downward. SoundCloud's own player bar is hidden in both modes, so only one bar paints. Milestone 6 has started with cosmetic comment hiding, diagnostics and safe mode. Browser-mode Home filtering now covers both the SDUI frame and the older `.mixedSelectionModule` layout, including campaign promos. Milestones 2 and 3 remain in place: shell, transport, dark tokens, window persistence, consent auto-reject, profile/search trimming, native queue drawer and stall watchdog. The live probe verifies layout, drawer alignment, the search panel and listening geometry; signed-in control checks are pending. See [README.md](README.md) for run and verification commands.
Target: Windows, Electron, single user, personal use.

---

## Locked decisions

| Area | Decision |
|---|---|
| Name | "SimpleCloud" — evokes SoundCloud without being it, own logo, no shared mark |
| Shell | Electron, one `WebContentsView`, persistent session partition |
| Audio | Site keeps ownership of the audio element; the shell never plays media itself |
| Ad blocking | Optional, user-installed filter pack. Engine bundled but inert; lists downloaded on demand. Never on by default |
| Native bar | Bottom bar, SoundCloud-parity controls, **browser mode only** |
| Listening mode | Waveform hero fitted to the view; hover-reveal bar with progress line and transport |
| Volume | Outside the app — OS mixer / device switcher, no in-app slider |
| Header | Simple top strip of route links + our own search field |
| Search | SoundCloud's own results page, decluttered; custom input with local history |
| History | Remembers queries **and** clicked results, 10 entries, local only |
| Comments | Toggle: hide comment UI and stop fetching comment data |
| Queue | Native panel, click-toggled, dense rows, no thumbnails |
| Stories | Out of scope for v1, rail left as-is |
| Theme | Token layer built now, dark ships, more themes are a file drop later |

---

## Name and branding

- **SimpleCloud**, with an original cloud mark drawn for the project. Different silhouette,
  different palette from SoundCloud's orange-on-white cloud, no shared typeface, no green.
- Window title, tray tooltip, installer name, settings/about pane all use SimpleCloud.
- About pane carries one line: "Unofficial. Not affiliated with, endorsed by, or connected to
  SoundCloud." No SoundCloud logo anywhere in the app, including the tray and taskbar icon.
- The site's own branding stays inside the site view, untouched — nothing is re-hosted.
- Package id: neutral (`com.user.simplecloud`), no `soundcloud` substring in binaries or installer
  metadata where it can be avoided.

---

## Architecture

```
Electron main
|- session "persist:soundcloud"        cookies, login, storage
|- WebContentsView -> soundcloud.com   site view, untouched network
|- adblock layer                       @ghostery/adblocker + session.webRequest
\- BrowserWindow
   |- shell renderer (ours): header, native bar, queue panel, hover bar, overlays
   \- site view slot                     clipped content region
```

**State bridge (preload injected into the site):** polls the player region every ~200 ms and
emits over IPC:

```
{ trackId, title, artist, artworkUrl, duration, position, isPlaying,
  shuffle, repeat, liked, queue: [ { id, artist, title, duration, url } ] }
```

`trackId` is the identity key. The native bar renders keyed on it, so title / artwork / time
update deterministically on every track change instead of inheriting a stale render.

**Commands back to the site:** play/pause, next, prev, seek, shuffle, repeat, like, queue jump,
queue remove, clear queue -> IPC -> synthetic clicks or keyboard events on the real controls,
with optimistic local UI and reconciliation from the next snapshot.

### Playback integrity rules (non-negotiable)

1. **Never `loadURL` while audio is playing.** All navigation is in-page: injected clicks on
   real anchors, never a reload.
2. Mode toggle and header links obey the same rule.
3. **Stall watchdog:** if position does not advance for ~3 s while `isPlaying`, nudge play/pause,
   then seek +0.5 s, then offer a one-click "resync" (reload). Covers ad-blocked segments.
4. A desync detector flags when a command did not change state within 1 s, and offers resync.

---

## Listening mode

Window ~1180x360, resizable, always-on-top off by default (pin toggle). Enter with the
headphones button in the header or `Ctrl+Shift+L`; leave with the bar's window button or `Ctrl+Shift+L`.

```
+----------------------------------------------+
|                                              |
|     big waveform + hero (title, artist, l)   |   only progress + seek UI
|                                              |
+----------------------------------------------+   strip, outside the site view
|  << >>  shuffle repeat  like pin mode   queue |   fades in on hover, idle: queue only
+----------------------------------------------+
```

- Default state is the waveform hero, fitted to the site view so it never scrolls or clips, with
  the bar faded out. A small always-visible **queue glyph** stays at the right.
- The bottom 60 px is a dedicated strip *below* the site view, so the bar never covers the hero
  and hovering never reflows the page. The cursor enters the strip -> the bar fades in over it;
  idle ~2 s -> the controls fade out and the queue glyph stays.
- Hover bar contents: elapsed / seek / duration progress line, prev / play / next, shuffle, repeat,
  like, queue, pin, mode toggle.
- SoundCloud's own player bar is hidden in both modes, so only one bar is visible at a time.
- **Implementation:** the bar is the shell's player strip, not an overlay on the site view (a
  native `WebContentsView` always paints above the shell). The site view occupies the window
  above the strip.
- Always lands on the current track's page; follow-player is unconditional here because the
  waveform must be authoritative. The site header and footer are hidden while listening.
- Queue panel opens by growing the window downward by 200 px; the strip stays above it.

## Browser mode

```
+---------------------------------------------------------------------------+
| Home   Feed   Library   Favourites   Profile      [ search... ]  [pin]  [o] |
+---------------------------------------------------------------------------+
|                                                                           |
|   SoundCloud content, decluttered, clipped to this region                 |
|                                                                           |
+---------------------------------------------------------------------------+
| << >>  shuffle repeat  0:00 ---------*---- 1:28  [art] artist - title  l  q |
+---------------------------------------------------------------------------+
```

### Header (ours)

- Links: Home `/discover`, Feed `/feed`, Library `/you/library`,
  Favourites `/you/likes`, Profile from the signed-in account menu.
- Pin toggle (always-on-top), mode toggle.
- Navigation is always in-page.

### Native bar — final control set

`prev / play / next / shuffle / repeat / elapsed / progress / duration / artwork / artist / title / like / queue`

- **No volume** (use the OS mixer; shell does not override the site's saved level).
- **No add-to-playlist** (the waveform hero already has it).
- Shuffle and repeat live here because the hero does not offer them.
- Progress bar shown here only; it is the sole progress UI in this mode.

### Declutter rules

- Home: exactly three blocks, see below. Everything else hidden.
- Profile: avatar, name, stats, tabs. Hide spotlight and promos.
- Search: SoundCloud's own results layout, minus related searches, promos, footer.
- Feed: page kept, story rail left as-is (stories are out of scope).
- Hide, never `removeChild`: deleting React-owned nodes causes
  "node to be removed is not a child of this node" crashes.

### Home — exactly three blocks

Kept, in the site's own order:

| # | Block | Content |
|---|---|---|
| 1 | **Per te** | the two banners: Daily Drops / Daily Drop, Weekly Wave / Weekly Drop |
| 2 | **Altro di cio che ti piace** | the horizontal recommendation card row |
| 3 | **Mixato per <you>** | the curated mix row (Mix 1..5 and friends) |

Removed: the "I tuoi preferiti" hero banner and its rail, the whole "Tracce trendy per genere"
block (heading, genre chips, three-column track grid), themed/seasonal promos, upsells, footer.

Notes:
- Block 3's heading is personalised ("Mixato per zep"), so match on the `Mixato per` prefix,
  not the exact string.
- Those headings are Italian because the account locale is Italian. Prefer stable links or
  section structure, then normalised localised headings. Do not match by rail position alone.
- If only two of the three blocks are present server-side (Air/AB variants), the page simply
  shows two. Nothing is synthesised.

---

## Queue panel

Click-toggled in both modes (window grows downward in listening mode, right-side drawer in
browser mode). The site's own queue panel is never shown — ours replaces it.

```
A seguire                                  8 brani · 14:12     Cancella   x
+-----------------------------------------------------------------------+
| uluv4melia                                                            |
| Da float at the function                                        3:21  |  <- playing, l
|-----------------------------------------------------------------------|
| uluv4melia                                                            |
| backpack                                                        1:57  |
|-----------------------------------------------------------------------|
| uluv4melia                                                            |
| id do anything                                                  1:40  |
+-----------------------------------------------------------------------+
```

- **Two-line rows, no thumbnails:**
  - line 1: artist, muted, smaller
  - line 2: song name, primary, duration right-aligned
- Full-bleed rows, no side gutters, no card padding. Browser-mode drawer is 344 px wide; the
  site view shrinks and its fixed 960 px containers become fluid below 960 px.
- Active row highlighted with a left accent bar.
- Click a row to jump. Hover reveals *play next* and *remove*.
- Header: title, track count, total remaining time, **Cancella** (clear), close.
- Keyboard: `Up` / `Down` / `Enter` / `Del`.
- Re-read on open and observe while open (throttled) so shuffle/next stay in sync.
- Drag-to-reorder is explicitly out of scope (requires driving internal site state).
- **Recon result:** all 13 rows from a tested playlist stayed mounted with the stock drawer
  closed, but the active marker lagged the player after Next. Derive the highlight from the
  player track link and re-read the queue on open. Longer queues still need testing.

---

## Search

Own input in the header. `Enter` navigates in-page to `/search?q=...`. `Ctrl+F` focuses it,
including from listening mode (which switches to browser mode first).

History: one MRU list, 10 entries, deduped by URL, stored in the local settings file, never sent.

| Type | Rendering | On select |
|---|---|---|
| query | magnifier + text | `/search?q=...` |
| clicked result | small artwork + title - artist | straight to that URL, in-page |

- A click is recorded when a result is actually opened from the results page.
- Re-selecting bumps to top. Rows individually removable; "clear all" in the footer.
- `Up` / `Down` / `Enter` / `Esc`; typing filters live.
- Dedupe: same track twice -> one entry, timestamp updated; same query repeatedly -> one entry.

---

## Comments

Milestone 6 includes the cosmetic **Hide waveform comments** toggle, diagnostics, safe mode, and opt-in ad and tracker request filtering. Tray integration remains pending.

Two planned mechanisms behind one toggle:

1. **Cosmetic:** hide only waveform avatar markers and their pop-up bubbles. Keep the thread, composer and counts visible.
2. **Resource:** block the comments request so the data is never fetched (recon to confirm it is a
   separate call; if it is load-bearing for the track page, fall back to cosmetic-only).

Also trimmed for weight: off-screen related/story rails, insights and promo modules, and
ad/tracker traffic when the optional filter add-on is installed.

---

## Network filtering (optional add-on)

Filtering is not part of the app. The app ships with filtering **off** and the engine inert; the
user opts in, and the lists arrive as a separate download.

- **Engine:** `@ghostery/adblocker` (MIT) matches requests through the SoundCloud session's
  `webRequest`. It doesn't preload, inject cosmetic rules or block top-level navigation.
- **Lists:** EasyList and EasyPrivacy from `easylist.to`, fetched on demand. Stored in the
  app's data folder; nothing is bundled with the installer.
- **UI:** Settings -> "Network filtering (optional)" -> Download / Update / Remove, plus a plain
  statement of what it does and where the lists come from. Off is the default; on is a deliberate
  click.
- **Rationale:** filtering is a user's choice about what their machine talks to — the same
  reasoning as a hosts file or firewall rule. Shipping it as a user-installed add-on, rather than a
  baked-in behaviour, keeps that framing honest and keeps the app itself plain.
- **Engineering note:** it is also a playback fix here. Ad segments stall or derail the player, so
  with filtering on the site behaves better. The stall watchdog covers ad paths either way.
- **Licensing:** library MIT; filter lists CC BY-SA / GPL, so they stay as separate, attributed
  files that the user downloads, never vendored into the bundle.
- Never port the uBlock Origin extension: Electron implements too few extension APIs and uBO is
  MV2-only; uBO itself is GPLv3.

---

## Themes

- Every skin rule uses our own tokens: `--bg`, `--surface`, `--text`, `--muted`, `--accent`,
  `--border`, `--wave`. Never SoundCloud's hashed classes.
- A theme is a small JSON of token values + matching window chrome colours and tray tint.
- Dark ships in v1; light plus extras are file drops, no rebuild.
- Limits: artwork untouched; waveform colour is site-drawn and only approximable via CSS filter.

---

## Resilience

- One selector registry (`selectors.js`), each entry with 3-4 fallbacks:
  `data-testid` -> `aria-label` / `role` -> `href` pattern -> structural heuristic.
- Self-check on every route change; logs any unresolved selector.
- Diagnostics overlay (`Ctrl+Shift+D`) listing what resolved and what did not.
- **Safe mode:** loads the vanilla site untouched, so a broken skin can never lock the user out.
- Selector overrides load from a local JSON so a break can be patched without a rebuild.
- De-risking: the skin can be prototyped first as a userscript + userstyle before any shell code.

---

## Milestones

| # | Work | Est. |
|---|---|---|
| 0 | Recon: player controls, queue mount behaviour, hero, home (three blocks), feed/profile/search, comments endpoint, stall behaviour -> `selectors.md` | 1 d |
| 1 | Bridge prototype: inject poller, log snapshots, verify track-change keying | 1-2 d |
| 2 | Shell + native bar + theme tokens: window, header shell, bar, in-page navigation rules, geometry | 3 d |
| 3 | Browser mode: route links, home three-block filter, profile/search cleanup, queue drawer, stall watchdog | 2 d |
| 4 | Search: input, click-recording, mixed MRU history, keyboard, persistence | 1 d |
| 5 | Listening mode: hero window, hover bar, queue glyph, pin, queue-grow | 2 d |
| 6 | Comments + filtering add-on + polish: suppression toggle, opt-in filter download, tray, diagnostics, safe mode | 1-2 d |

Total: roughly 1.5 weeks of evenings. Risk is concentrated in steps 0-1.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Native bar desyncs from site state | High | `trackId`-keyed rendering, 200 ms poll, desync detector, resync |
| Site selectors change | High | Registry with fallbacks, self-check, diagnostics, safe mode |
| Accidental reload kills playback | High | In-page navigation only, enforced in one helper |
| Queue not reachable while closed | Medium | Mounted-but-invisible fallback, harvest-by-open last resort |
| Comments blocking breaks the track page | Medium | Toggle, cosmetic-only fallback |
| Breakage from SoundCloud A/B tests | Medium | Two accounts to test against, safe mode |

---

## Legality / distribution notes

Not legal advice — a practical assessment for a personal tool.

**What this app does:** it embeds a public website in a browser window and hides parts of the UI.
It does not copy SoundCloud code or media, does not use their private APIs, does not take API keys,
does not strip DRM (there is none), and does not download or redistribute audio.

**Low risk:**
- Wrapping a public site in your own browser. Browsers exist; this is one with opinions.
- Local CSS/JS that hides elements. Nothing is redistributed.
- Personal, unpublished use. The realistic worst case is an account-level ToS complaint.

**The actual risk areas, in order:**
1. **Trademark / passing off.** A name or icon that invites confusion is the clearest problem if
   published. SimpleCloud with an original cloud mark, no orange/green SoundCloud palette, no
   SoundCloud typeface, no logo, plus the "unofficial, not affiliated" line, keeps this at arm's
   length. Evocative is fine; imitative is not.
2. **Terms of Service.** Almost certainly prohibits circumventing ads and likely prohibits
   modifying how the service is presented. That is a contract issue: account suspension or a
   takedown request, not a criminal matter. Nothing here is "stealing" content.
3. **Filtering.** Legal in the EU: German courts (Axel Springer v. Eyeo) upheld ad blocking. It is
   the same category as a hosts file or a firewall rule — a user deciding what their machine talks
   to. It can still breach the site's ToS. Shipping it as an optional, user-downloaded add-on with
   a visible toggle keeps the app's default behaviour plain and the framing accurate.
4. **Bundling.** Never ship SoundCloud's CSS, fonts, icons or any copied markup. Selectors that
   match their DOM are not copyrighted material. If the skin prototype is a userscript, it is still
   only selectors and our own CSS.

**If it is ever published:** neutral name (SimpleCloud), original logo, disclaimer, open source
(MIT) with the filtering library and lists attributed separately, filtering as an opt-in download
rather than default behaviour, no bundling of their assets, and expect that they can break the skin
at any time.

**Bottom line:** personal use = very low practical risk. Distribution = trademark and ToS exposure,
not copyright infringement. No API keys, no scraping, no DRM bypass means this is not the
"illegal" category.

---

## Open items

1. Verify the DOM for the three confirmed Home blocks on the signed-in account:
   Per te (Daily Drops + Weekly Wave), Altro di ciò che ti piace, and Mixato per <you>.
2. Verify long queues and upcoming-row freshness while closed; populated rows were confirmed to stay mounted in a 13-track playlist.
3. A separate comments request was observed; verify that cancelling it is safe.
4. Resolve playlist-context track navigation when it changes the route without showing a waveform.
5. Whether hover-only access to extra controls feels right in daily use; fallback is a persistent
   small glyph set.

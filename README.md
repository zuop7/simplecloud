<img width="300" height="300" alt="small-Cute Blushing Cloud Icon" src="https://github.com/user-attachments/assets/08f3b96a-448c-4b01-b2d6-3fa0a07c90ac" />


# SimpleCloud

An unofficial Windows desktop shell for SoundCloud. It loads the real
soundcloud.com in its own window and reshapes it: a native player bar, three
blocks on Home instead of the whole feed, search history, a compact queue, and a
small listening window that shows nothing but the waveform.

SimpleCloud does not fetch, decode or play audio itself. Every control is
forwarded to SoundCloud's own player, so the site keeps working exactly as it
does in a browser.

**SoundCloud might reset your password when you first log in**

**SimpleCloud is not affiliated with, endorsed by or supported by SoundCloud**


<img width="1190" height="314" alt="Annotation 2026-11-25 220810" src="https://github.com/user-attachments/assets/e1bf5a2e-0729-4d09-a7cc-1eaf85ba9f7e" />

<img width="1201" height="828" alt="Capture" src="https://github.com/user-attachments/assets/5d44c6d9-37c3-4247-9c0b-378930df3a41" />



## Download

[**Latest release**](https://github.com/zuop7/simplecloud/releases/latest) —
choose the portable Windows x64 `.exe`. No installer or Node.js; nothing to
configure: double-click and sign in.

The build is unsigned, so Windows SmartScreen will warn you the first time.
A portable build that extracts itself at launch is a common false positive.

**Requirements:** Windows 10 or 11, 64-bit. A SoundCloud account for anything
beyond browsing. **Continue with Google** is not supported inside the app — sign
in with your email and password. 

## What it does

**Browser mode.** SimpleCloud's own 52 px header replaces SoundCloud's nav:
Home, Feed, Library, Favourites, Profile, search, an always-on-top pin and the
listening-mode button. The bar along the bottom shows the current track with
previous, play/pause, next, shuffle, repeat, seek and like. The volume slider and
mute button control SoundCloud's own level. Use **Next up** for the queue.

**Listening mode** (`Ctrl+Shift+L`). The headphones button detaches the live
player into a 1180×300 window without reloading SoundCloud. Click the headphones
again or close the compact window to dock it. The player bar stays hidden until you hover the bottom
edge or press `F6`, then it overlays the hero instead of shrinking it, so no
footer or second bar ever appears. `Esc` hides it again, **Next up** grows the
window downward, and the window follows whichever track is playing.

**A quieter Home.** Only three blocks survive: your personalized shelf (Daily
Drops and Weekly Wave), *More of what you like*, and *Mixed for you*. The Likes
shortcut, campaign banners, app promos and footer are removed. Both Home layouts
are handled — the current iframe-based one and the older one — and an explicit
**Reject all** consent button is clicked automatically when SoundCloud shows one.

**Search history.** Queries you submit and tracks you open from a results page go
into one most-recent-first list of ten, capped at 235 px tall. The panel pushes
the page down rather than covering it. Rows can be removed individually or
cleared, and it is stored only on your machine.

**Queue.** SoundCloud's own queue stays mounted but hidden; SimpleCloud draws a
344 px drawer instead. Rows are click-to-play and removable, `Delete` removes the
focused row, `Escape` closes it. Opening it shrinks the page instead of covering
it, and the narrowed layout gains no horizontal scrollbar.

**Hide waveform comments** (Settings, off by default). Removes the avatar markers
and their pop-ups from the waveform without reloading or blocking requests. In
listening mode it also hides the hero's comment and action row and recenters the
waveform. The comment thread, composer and count stay visible in browser mode.

**Network filtering** (Settings → Network filtering, off by default). Opt-in
blocking of ads and trackers using EasyList and EasyPrivacy. The lists are
downloaded only when you ask for it, stored locally, never bundled and never
fetched automatically. Filtering is network-only, applies to future requests
without interrupting playback, and cannot catch ads embedded in an audio stream.

**Diagnostics** (`Ctrl+Shift+D`) shows the current mode and which player controls
the bridge can see, without listing track names or search history. If something
breaks after a SoundCloud update, `npm start -- --safe-mode` opens the untouched
site in the same local session to confirm whether the skin is at fault.

## Keyboard

| Key | Action |
|---|---|
| `Ctrl+Shift+L` | Toggle listening mode |
| `Ctrl+F` | Search (also returns to browser mode) |
| `F6` / `Esc` | Show / hide and focus the listening bar |
| `Ctrl+Shift+D` | Diagnostics |
| `Alt` | Application menu |
| `Alt+F4` | Dock listening mode or close the app in browser mode |

## Privacy

No telemetry, no analytics and no accounts of its own. The app contacts
soundcloud.com and its image CDN, plus easylist.to only when you enable network
filtering. Everything below lives in the app's user-data folder
(`%APPDATA%\simplecloud`) and is never sent anywhere:

- `session` — your SoundCloud sign-in, stored by Electron's persistent session
- `search-history.json` — the ten recent queries and tracks
- `window.json` — window bounds, maximized state and the pin
- `hide-comments.json` — the comment preference
- `network-filter.json` — the downloaded filter lists, only if you enabled them

Deleting that folder removes the sign-in and the preferences.

## Build from source

Node.js 22 or newer, then from this folder:

```powershell
npm ci
npm start
```

The portable executable is built with:

```powershell
npm run build:win
```

Output: `dist/SimpleCloud-<version>-x64.exe`. `npm test` runs the parser and
store tests against fixtures; `npm run probe` drives an isolated Electron profile
through the shell, the queue drawer, search, the Home filter and both window
modes.

## Status

`0.2.0` development build. Expect breakage when SoundCloud
changes its markup, since the shell depends on specific selectors documented in
[`selectors.md`](selectors.md). The rounded listening
window is drawn with a Win32 window region because Windows 10 has no native
rounded corners.

**Windows only so far, Macos in the future**

## License

Proprietary, all rights reserved. You may download and run official builds for
personal use; you may not redistribute, modify or reuse the source without
written permission. See [`LICENSE`](LICENSE). SoundCloud is a trademark of
SoundCloud Global Limited & Co. KG.

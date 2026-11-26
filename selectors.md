# SimpleCloud — milestone 0 recon

Checked the live SoundCloud desktop site in OpenCode Chromium: first signed out in English (US), then signed in in Italian. No Electron code or network rules were added. Selectors below describe the observed site, not a stable API.

## Routes and retained content

| Surface | Observed | Still to verify |
|---|---|---|
| Home | `/discover`; `[role="main"]`. Signed in, the personalized blocks live inside a same-origin SDUI iframe (`iframe[src*="/n/embeds/home-sdui"]`, MUI markup), not in the top document. The top document adds a `.l-main` column plus a `.l-sidebar-right` rail and a `.velvetCakeModule` events banner. | Selectors are implemented; verify the filter and the two-block server variant in a signed-in Electron session. |
| Feed | `/feed` works signed in: `.stream`, `.stream__header`, `.stream__list`, `.streamSidebar`. It redirects to `/signin` when signed out. `/you/feed` returned not found. | Stories have no special handling in v1. |
| Library and Favourites | Signed-in Library `/you/library` exposes tabs via `a.g-tabs-link`, including `Preferiti` → `/you/likes`; Home's Likes shortcut also links there. The dedicated Likes root was `.l-collection .collection__likesSection`, with `.collectionSection__list` and `.playableTile` cards. Both routes redirect to `/signin` when signed out. | Preserve the collection filters and list when applying cleanup. |
| Profile | Signed-in `header[role="banner"] a.header__userNavUsernameButton[href]` exposes the account's real profile path. A public profile exposed `.profileHeader`, `.profileHeaderInfo__userName`, `a.g-tabs-link`, `.infoStats__statLink` and `.spotlight`. `/you` redirected to `/signin` when signed out. | Use the observed account link, not a hardcoded user slug or `/you`. |
| Search | `/search?q=…`, `form.headerSearch input[type="search"]`, results heading `.searchTitle__text` under `.l-search`. Observed result title `a.soundTitle__title[href]`, plus distinct artist and avatar links. | Identify result-specific anchors by type; record history only for clicks that actually open a result in Search, not Play, Like, filters, or other inline actions. |

Keep the site header mounted for its navigation and search handlers, even if the shell hides it. Don't remove site-owned nodes.

## Home (Discover)

- Signed in, the three personalized blocks are inside `iframe[src*="/n/embeds/home-sdui"]` on `soundcloud.com`, so the parent document can read `contentDocument` (no `sandbox` attribute). The iframe auto-resizes its own height when sections are hidden: 4372 px for all 14 sections, 1403 px for the three kept ones.
- Each block is a `<section>` whose first heading is `h2.MuiTypography-root.MuiTypography-h3`. Class suffixes (`mui-1lxzpqr`) are build-specific; match the `section` + heading structure instead.
- Observed signed-in Italian headings, in page order: **Altro di ciò che ti piace**, Tracce trendy per genere, **Mixato per zcp**, Piace alle persone che segui, Te ne innamorerai 🔥, Le tue scoperte, Le novità degli artisti che segui, I preferiti di, **Per te**, Album per te, Nuova crew consigliata per te, Scopri nuove tracce con le stazioni, Realizzato da SoundCloud, Artisti da tenere d'occhio.
- `Per te` contains the Daily Drops / Weekly Wave banners. `Album per te` and `Nuova crew, consigliata per te` must not match the `Per te` prefix.
- When a heading is missing or duplicated, prefer the paired Daily Drops and Weekly Wave cards, identified by their SoundCloud `new-for-you::` and `weekly::` playlist links or their accessible names. Diagnostics on Home reports whether the cards are present and visible; it does not create playlists SoundCloud did not send.
- The top document's `.l-sidebar-right` (360 px) duplicates nav, likes, history and promos. On Discover it is hidden and `.l-main` is set to `width:100%; box-sizing:border-box` inside the 960 px container; the SDUI iframe grows from 584 px to 944 px. Both are restored on other routes.
- OneTrust's hidden preference dialog contains `<section>` elements outside `[role="main"]`. The top-document scan is scoped to `[role="main"]`, otherwise those consent sections are mistaken for the page's blocks and the filter stops running.
- Not every SoundCloud Home uses the SDUI frame. The bridge scans both known same-origin frame types (`home-sdui` and `iframe.webiIframe`, including nested frames) as well as the legacy `.mixedSelectionModule` rows. It keeps one of each allowed heading, preferring the framed copies. It also hides the standalone Likes shortcut and “Grab the keys and crank the radio” campaign by their labels, including artwork alt text or campaign copy when there is no heading.
- SoundCloud's `.l-container`, `.l-content` and `.l-fluid-fixed` are fixed at 960 px. While the native queue drawer is open the view is 344 px narrower (840 px at the default window), so injected CSS sets those three to `width:100%` under `@media (max-width: 959px)`. The probe asserts `scrollWidth <= innerWidth` and no horizontal scrollbar.
- If an allowed heading has not loaded, the filter leaves unknown sections alone but still removes the known Likes and campaign cards.

## Player bridge and track hero

| Surface | Observed selectors and notes |
|---|---|
| Miniplayer root | `.playControls .playControls__inner[role="contentinfo"]`; its accessible label was `miniplayer`. Scope controls here to avoid matching page-level Play/Like buttons. |
| Transport | `button.playControls__prev`, `button.playControls__play`, `button.playControls__next`, `button.shuffleControl`, `button.repeatControl`. The idle player uses `.disabled` and `tabindex="-1"` on unavailable controls; checking only the HTML `disabled` attribute is insufficient. Shuffle on adds `.m-shuffling`; repeat cycles `.m-none` → `.m-one` → `.m-all`. Neither uses `aria-pressed`. Play/pause is read from the Italian `Riproduci` / `Metti in pausa` label. |
| Active metadata | `.playbackSoundBadge__titleLink` exposes `title` and the current track `href`; its `textContent` includes a screen-reader duplicate. `.playbackSoundBadge__lightLink` is the artist; `.playbackSoundBadge__avatar .sc-artwork[style]` carries artwork styling. Playlist track links can have `?in=…`; normalize the pathname for track identity but retain the original link for navigation. `.playbackSoundBadge__like` is Like; `.playbackSoundBadge__follow` is the adjacent Follow button deliberately omitted in SimpleCloud. The Italian play button changed from `Riproduci` to `Metti in pausa` while playing. |
| Time and seek | `.playbackTimeline__timePassed` and `.playbackTimeline__duration` supply the displayed times; the inline width of `.playbackTimeline__progressBar` supplies fractional progress. Send seek drags to `.playbackTimeline__progressWrapper`, the full rail, with move and release events for its document-level drag handler. |
| Track hero | `.fullListenHero.fullHero`, `h1.soundTitle__title`, `.fullHero__artwork`, `.fullHero__info`, `.fullHero__waveform`, `.fullListenHero .sc-button-play[role="button"]`. Waveform uses layered canvases. `.listenEngagement` is separate from the hero; keep `.listenEngagement__actions` if you want Like and other track actions. A playlist selection showing the number of tracks is expected; only the individual track hero should show the waveform. |
| Site navigation | A real Search result anchor rendered the public track hero without changing `performance.timeOrigin`. During signed-in playback, clicking Library kept the same document and progress advanced from `0:19` to `0:20`; Feed navigation likewise did not reload. Manual Next on a playlist updated the player track link, not the page route. Clicking the new track's miniplayer link changed the path without a reload or stopping playback, but that playlist-context route did **not** render a waveform in the observed session. Route change alone is not enough to declare the hero ready. |

For milestone 1, resolve the active track from the **playing bar**, not the current page URL or queue's active class. Read the short time value from the visible child, not both it and the `.sc-visuallyhidden` text. Check track metadata and progress on manual Next and a confirmed natural end-of-track advance; don't publish a mixed snapshot if fields update at different times. If a track hero fails to resolve, don't show a stale waveform as current; test a no-reload route that actually renders that track.

## Queue

- Toggle: `a.playbackSoundBadge__showQueue` (title `A seguire` in Italian). The observed anchor had no `href` and used `aria-role`, so a role-only lookup misses it. The queue lives inside `.playControls__inner`, so the bridge's scoped reads see it. The panel is `.queue__panel`; controls are `button.queue__clear` and `button.queue__hide`. SimpleCloud never clicks the stock toggle; it hides the panel and renders its own drawer.
- Rows: `.queue__itemsContainer .queue__itemWrapper .queueItemView`. Read artist from `.queueItemView__username`, track title/link from `.queueItemView__title a[href]`, and duration from `.queueItemView__duration` (plain `2:22`). Ignore the `.queue__fallback` autoplay placeholder. `.queueItemView__playButton`, `button.queueItemView__remove`, and `button.queueItemView__more` exist; the shell uses the first two and leaves More alone.
- **Populated rows stayed mounted when closed.** A 13-track playlist kept all 13 track rows on close, across navigation and on reopen. But after Next with the drawer closed, `.m-active` still marked the previous song while the miniplayer already reported the new one; after opening and allowing the UI to settle, the new row had `.m-playing.m-active`. The shell therefore highlights by matching `trackId` against the miniplayer, never `.m-active`.
- The shell queue remains **click-only**. Dense two-line rows: artist above, song title below with duration aligned right. No thumbnails or side gutters.

## Comments and playback stalls

- The toggle only hides timed markers and their pop-ups. On legacy track pages these are `.fullHero__waveform canvas.waveformCommentsNode`, `.commentPopover` and `.commentPlaceholder`. The crossfade frame has a separate marker `ol` beside the waveform slider; the active marker's `aria-labelledby` links to a tooltip outside the hero. The toggle preserves the waveform, seeking, thread, composer and comment count. It does not block comment requests.
- The site itself issued a separate successful `GET https://api-v2.soundcloud.com/tracks/<id>/comments` when the track page opened. This was observed passively; SimpleCloud should not call it. Resource suppression remains untested. Before enabling it, confirm that cancelling only the comments fetch doesn't cause retries or break the hero, waveform, seeking, track actions or playback. Fall back to cosmetic-only if it does.
- The reported improvement with generic filtering is from the user, not reproduced in this run. Compare filtered and unfiltered playback on a signed-in free account across real transitions. Log whether progress resumes naturally and distinguish buffering and pauses from a stall before adding automatic recovery.

## Consent, profile and search cleanup

- Consent is OneTrust. A hidden preference center (`#onetrust-pc-sdk`, `[role="dialog"]`) is always mounted; the visible banner is only present until consent is stored. SimpleCloud clicks only an explicit reject label (`Reject all`, `Rifiuta tutto`, `Rifiuta tutti i cookie`, …) or `#onetrust-reject-all-handler`, at most 40 times. No accept button is ever clicked.
- Profile: `.spotlight` and its `spotlight*` upsell children are separate from `.profileHeader` / `.profileHeaderInfo__userName`; the observed `.spotlight` contained no avatar or header. The shell hides `[role="main"] [class*="spotlight"]` unless it contains the profile header.
- Search: `/search?q=…` has `.l-search`, `.searchTitle__text`, `a.soundTitle__title[href]`; no related-search rail was present. Promos use `firstFansPromotionBanner__*`, `.m-upsell-styling` and `.searchOptions__footer`; the shell hides those and the site footer.
- Search results mix user and track rows inside `.searchList__item`; the results list is `.searchList` with `.lazyLoadingList__list`, and an empty query gives `.searchList__empty`. Track rows are `.sound.searchItem__trackItem` with `.soundTitle__title` (text and link), `.soundTitle__usernameText` (artist), and artwork as a CSS background on `.sound__artwork .sc-artwork[style]` (no `<img>`). Playlists are `.playlist` rows whose links have three path segments and must not be recorded as tracks.
- The site header search is `form.headerSearch input[type="search"]`; submitting it stays in the same document. A synthetic `<a href="/artist/track">` appended to `body` and clicked is also routed in place by the SPA (verified on `/discover`), so remembered results can reopen without a document load. The main process still blocks any full navigation during a scripted action.

## Listening mode

- The main SoundCloud view stays mounted in the browser window. The separate Listening preview is covered at the bottom by a 48 px player only while hovered, pinned, or keyboard-revealed.
- SoundCloud's own bar is `.playControls`. It stays mounted, invisible and pointer-disabled, so the bridge can still measure its seek rail and operate its controls.
- `html.sc-listen` hides the preview's navigation, footer, and non-hero content. The main page does not receive this class.
- Newer accounts get the song hero from SoundCloud's crossfade player: a same-origin `iframe.webiIframe` whose src is `soundcloud.com/n/<artist>/<track>?…embedded=crossfade…`. In listening mode the bridge marks it `sc-listen-frame`, pins it to the view and injects a style into the frame: `main` flexes to the full frame height, the first `section` (the hero) is `100vh` with `padding-block: 2vh`, the artwork square (`section > div > div > :last-child`) shrinks to the frame height, and the frame's scroll container (the body div holding `main`) gets `.sc-listen-scroll` with `overflow: hidden`. That is what stops the hero clipping and the frame's footer scrollbar.
- The companion preview loads the current track when opened and follows track changes. The preview cannot play media; its play/seek gestures are forwarded to the main player. It tints the waveform up to the main player's current position and interpolates confirmed playback advances.
- The 200 px listening queue is grown downward with the window, so the site view keeps its height.

## Remaining checks

1. Verify the three-block Home filter and the sidebar widening in the Electron app with a signed-in session, including a two-block server variant.
2. Verify waveform seek and find a no-reload follow path that renders the hero for playlist tracks. Check natural track advance, longer queues, and changes to upcoming rows.
3. Exercise the native queue's play/remove/clear actions and the stall watchdog against real playback in Electron.
4. Open a search result from the results page in the Electron app and confirm it lands in the history, then relaunch and reopen it from the panel without a document load.
5. Verify comment suppression and the optional generic filtering/stall comparison in the Electron prototype. No filter settings were changed here.

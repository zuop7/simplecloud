// Kept in one file because sandboxed Electron preloads cannot require local modules.
const pollMs = 200;
const channel = 'simplecloud:player-state';
const playerSelector = '.playControls .playControls__inner[role="contentinfo"]';
const controlSelectors = {
  previous: 'button.playControls__prev',
  play: 'button.playControls__play',
  next: 'button.playControls__next',
  shuffle: 'button.shuffleControl',
  repeat: 'button.repeatControl',
  like: 'button.playbackSoundBadge__like',
  seek: '.playbackTimeline__progressWrapper'
};
const routes = { home: '/discover', feed: '/feed', library: '/you/library', likes: '/you/likes' };
const homeModules = [
  /^(?:per te|for you)$/,
  /^(?:altro di cio che ti piace|more of what you like)$/,
  /^(?:mixato per|mixed for)\s+\S/
];
const homeExtra = /grab the keys and crank the radio|celebrate the return to the streets|^(?:your likes|i tuoi (?:mi piace|preferiti)|le tue (?:tracce preferite|preferenze)|ti piace)[.!]?$/;
const homeFrames = 'iframe[src*="/n/embeds/home-sdui"], iframe.webiIframe';
const rejectAll = /^(?:reject(?:\s+all)?|rifiuta(?:\s+(?:tutto|tutti|i\s+cookie|tutti\s+i\s+cookie))?)(?:\s+cookies)?$/i;

function trackLink(href, baseUrl) {
  if (!href) return null;
  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== 'https:' || !['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname)
      || url.port || url.username || url.password) return null;
    const trackId = url.pathname.replace(/\/+$/, '');
    if (!/^\/[^/]+\/[^/]+$/.test(trackId)) return null;
    const context = url.searchParams.get('in');
    const query = context ? `?${new URLSearchParams({ in: context })}` : '';
    return { trackId, trackUrl: `${url.origin}${trackId}${query}` };
  } catch {
    return null;
  }
}

function readTime(element) {
  const visibleChild = [...(element?.children ?? [])].find(e => !e.matches('.sc-visuallyhidden'));
  const text = (visibleChild ?? element)?.textContent.trim() ?? '';
  if (!/^\d+(?::[0-5]\d){1,2}$/.test(text)) return null;
  return text.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

function seconds(text) {
  const value = text?.trim() ?? '';
  if (!/^\d+(?::[0-5]\d){1,2}$/.test(value)) return null;
  return value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

function playingState(button) {
  if (!button) return null;
  if (button.matches('.playing, .m-playing')) return true;
  const label = button.getAttribute('aria-label') || button.title || '';
  if (/^(?:pause\b|metti in pausa\b|pausa\b)/i.test(label)) return true;
  if (/^(?:play\b|riproduci\b)/i.test(label)) return false;
  return null;
}

function toggleState(button) {
  if (!button) return null;
  const pressed = button.getAttribute('aria-pressed');
  if (pressed === 'true' || pressed === 'false') return pressed === 'true';
  return button.matches('.m-active, .m-shuffling, .m-one, .m-all, .sc-button-selected, .selected');
}

function repeatState(button) {
  if (!button) return null;
  if (button.matches('.m-one')) return 'one';
  if (button.matches('.m-all')) return 'all';
  return toggleState(button) ? 'all' : 'off';
}

function enabled(element) {
  return Boolean(element && !element.matches(':disabled, .disabled, [aria-disabled="true"]'));
}

function readQueue(root, baseUrl) {
  const rows = [...(root?.querySelectorAll('.queue__itemsContainer .queueItemView') ?? [])];
  return rows.flatMap(row => {
    const link = row.querySelector('.queueItemView__title a[href]');
    const track = trackLink(link?.getAttribute('href'), baseUrl);
    const title = link?.textContent.trim();
    if (!track || !title) return [];
    return [{
      ...track,
      title,
      artist: row.querySelector('.queueItemView__username')?.textContent.trim() || '',
      duration: seconds(row.querySelector('.queueItemView__duration')?.textContent)
    }];
  });
}

function volumeSlider(root) {
  return root?.querySelector('.volume__sliderWrapper[role="slider"]');
}

function readVolume(root) {
  const slider = volumeSlider(root);
  const control = slider?.closest('.volume');
  if (!control) return {};
  const muted = control.classList.contains('muted');
  const value = slider.getAttribute('aria-valuenow')?.trim();
  const level = control.getAttribute('data-level')?.trim();
  const volume = muted ? 0 : value ? Number(value) : level ? Number(level) / 10 : NaN;
  return Number.isFinite(volume) && volume >= 0 && volume <= 1 ? { volume, muted } : {};
}

function readProgress(root) {
  const width = root.querySelector('.playbackTimeline__progressBar')?.style.width;
  if (!width?.endsWith('%')) return {};
  const progress = Number.parseFloat(width) / 100;
  return progress >= 0 && progress <= 1 ? { progress } : {};
}

function readPlayer(root, baseUrl) {
  if (!root) return null;
  const query = selector => root.querySelector(selector);
  const titleLink = query('.playbackSoundBadge__titleLink');
  const queue = readQueue(root, baseUrl);
  const volume = readVolume(root);
  if (!titleLink) return { status: 'idle', queue, ...volume };
  const link = trackLink(titleLink.getAttribute('href'), baseUrl);
  const title = titleLink.title?.trim();
  const artistLink = query('.playbackSoundBadge__lightLink');
  const artist = (artistLink?.title || artistLink?.textContent)?.trim();
  if (!link || !title || !artist) return null;

  const artwork = query('.playbackSoundBadge__avatar .sc-artwork[style]');
  const image = artwork?.style.backgroundImage.match(/^url\(["']?(https:\/\/[^"')]+)["']?\)$/)?.[1];
  return {
    status: 'track',
    ...link,
    title,
    artist,
    artworkUrl: image ?? null,
    duration: readTime(query('.playbackTimeline__duration')),
    position: readTime(query('.playbackTimeline__timePassed')),
    ...readProgress(root),
    isPlaying: playingState(query(controlSelectors.play)),
    shuffle: toggleState(query(controlSelectors.shuffle)),
    repeat: repeatState(query(controlSelectors.repeat)),
    liked: toggleState(query(controlSelectors.like)),
    ...volume,
    queue,
    controls: Object.fromEntries(Object.entries(controlSelectors)
      .map(([action, selector]) => [action, enabled(query(selector))]))
  };
}

function setVolume(slider, value) {
  const rail = slider?.querySelector('.volume__sliderBackground');
  if (!rail || !Number.isFinite(value) || value < 0 || value > 1) return false;
  const send = (target, type) => {
    const rect = rail.getBoundingClientRect();
    if (rect.height <= 0) return false;
    target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, buttons: type === 'mouseup' ? 0 : 1,
      clientX: rect.left + rect.width / 2,
      // The SoundCloud grip travels below the painted end of the rail.
      clientY: rect.bottom + (value === 0 ? 8 : 4) - rect.height * value
    }));
    return true;
  };
  if (!send(rail, 'mousedown')) return false;
  // SoundCloud expands the control during mousedown, moving the rail.
  send(document, 'mousemove');
  send(document, 'mouseup');
  return true;
}

// Let the site's track identity settle across two polls, then publish every
// change. Position, queue and transport flags may change between observations.
function createPublisher(send) {
  let candidate;
  let previous;
  return (state) => {
    if (!state) {
      candidate = undefined;
      return;
    }
    const key = JSON.stringify([state.status, state.trackId, state.title, state.artist,
      state.artworkUrl, state.duration]);
    if (key !== candidate) {
      candidate = key;
      return;
    }
    const serialized = JSON.stringify(state);
    if (previous !== serialized) {
      previous = serialized;
      send(state);
    }
  };
}

function normalise(text) {
  return (text ?? '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function isAllowedHomeModule(title) {
  return homeModuleIndex(title) !== -1;
}

function homeModuleIndex(title) {
  return homeModules.findIndex(pattern => pattern.test(normalise(title)));
}

function isRejectAll(label) {
  return rejectAll.test((label ?? '').trim());
}

function profileLink() {
  return document.querySelector('header[role="banner"] a.header__userNavUsernameButton[href]');
}

function section() {
  const path = location.pathname;
  for (const [name, href] of Object.entries(routes)) {
    if (path === href) return name;
  }
  if (path === '/search' || path.startsWith('/search/')) return 'search';
  const profile = profileLink()?.getAttribute('href');
  return profile && (path === profile || path.startsWith(`${profile}/`)) ? 'profile' : null;
}

// Give existing site handlers the event, but never let an anchor/form default
// from our command trigger a top-level browser load.
function inPageEvent(type, trigger) {
  const blockDefault = event => event.preventDefault();
  window.addEventListener(type, blockDefault);
  try { trigger(); } finally { window.removeEventListener(type, blockDefault); }
}

// Navigate with the site's own router, using an existing link when possible and
// a synthetic anchor otherwise. The header account button is excluded: clicking
// it on a profile page opens the account menu instead of the profile root.
function routeInPlace(value, preferred) {
  let target;
  try { target = new URL(value, location.href); } catch { return false; }
  if (target.origin !== location.origin) return false;
  const routable = anchor => anchor?.hasAttribute('href') && !anchor.hasAttribute('download')
    && (!anchor.target || anchor.target === '_self') && !anchor.matches('a.header__userNavUsernameButton');
  const matches = anchor => {
    if (!routable(anchor)) return false;
    try {
      const url = new URL(anchor.getAttribute('href'), location.href);
      return url.origin === target.origin && url.pathname === target.pathname
        && url.search === target.search && url.hash === target.hash;
    } catch {
      return false;
    }
  };
  const existing = routable(preferred) ? preferred : [...document.querySelectorAll('a[href]')].find(matches);
  const anchor = existing ?? document.createElement('a');
  if (!existing) {
    anchor.href = `${target.pathname}${target.search}${target.hash}`;
    anchor.hidden = true;
    document.body.append(anchor);
  }
  inPageEvent('click', () => anchor.click());
  if (!existing) anchor.remove();
  return true;
}

function switchSection(name) {
  if (name === 'profile') {
    const path = profileLink()?.getAttribute('href');
    if (!path) return false;
    if (location.pathname === path) return true;
    return routeInPlace(path);
  }
  if (section() === name) return true;
  const path = routes[name];
  if (!path) return false;
  if (routeInPlace(path)) return true;
  return false;
}

function queueRow(trackId) {
  const rows = [...document.querySelectorAll('.queue__itemsContainer .queueItemView')];
  return rows.find(row => trackLink(row.querySelector('.queueItemView__title a[href]')?.getAttribute('href'),
    location.href)?.trackId === trackId);
}

// Reopen a remembered result without a document load.
function openTrack(value, report) {
  let target;
  try { target = new URL(value); } catch { return false; }
  if (target.origin !== location.origin) return false;
  if (!routeInPlace(target.href)) return false;
  setTimeout(() => {
    if (location.pathname.replace(/\/$/, '') !== target.pathname.replace(/\/$/, '')) {
      report('That track didn\'t open in place. Open it from the results page instead.');
    }
  }, 1500);
  return true;
}

let browserPage, cancelScrollRestore, listeningTrack, listeningTitle, listeningSince;
function setListeningMode(on, trackId, title) {
  const root = document.documentElement;
  if (trackId !== listeningTrack) listeningSince = performance.now();
  listeningTrack = on ? trackId : null;
  listeningTitle = on ? normalise(title) : '';
  if (on && root.classList.contains('sc-listen')) { fitListenFrame(); return; }
  if (on === root.classList.contains('sc-listen')) return;
  cancelScrollRestore?.();
  if (on) {
    browserPage = { url: location.href, x: window.scrollX, y: window.scrollY };
    root.classList.add('sc-listen');
    window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    fitListenFrame();
    return;
  }
  root.classList.remove('sc-listen');
  unfitListenFrame();
  listenPlaceholder?.remove();
  listenPlaceholder = undefined;
  const page = browserPage;
  browserPage = undefined;
  if (!page) return;
  if (location.href !== page.url && !routeInPlace(page.url)) return;
  const deadline = performance.now() + 2500;
  const restore = () => {
    if (location.href === page.url) {
      window.scrollTo({ left: page.x, top: page.y, behavior: 'instant' });
      if (Math.abs(window.scrollY - page.y) < 2) return true;
    }
    return performance.now() >= deadline;
  };
  if (restore()) return;
  const timer = setInterval(() => { if (restore()) cancel(); }, 50);
  const cancel = cancelScrollRestore = () => {
    clearInterval(timer);
    cancelScrollRestore = undefined;
    window.removeEventListener('wheel', cancel, true);
    window.removeEventListener('pointerdown', cancel, true);
    window.removeEventListener('keydown', cancel, true);
  };
  window.addEventListener('wheel', cancel, { capture: true, passive: true });
  window.addEventListener('pointerdown', cancel, true);
  window.addEventListener('keydown', cancel, true);
}

function runAction(name, value, report) {
  if (name === 'navigate') {
    if (switchSection(value)) return;
    if (value === 'likes' && switchSection('library')) {
      const expires = Date.now() + 3000;
      const timer = setInterval(() => {
        if (location.pathname !== '/you/library' && Date.now() < expires) return;
        if (switchSection('likes')) { clearInterval(timer); return; }
        if (Date.now() >= expires) {
          clearInterval(timer);
          report('Favourites isn\'t available. Sign in through SoundCloud and try again.');
        }
      }, 150);
      return;
    }
    report('That page isn\'t available yet. Sign in through SoundCloud or try again.');
    return;
  }
  if (name === 'search') {
    const input = document.querySelector('form.headerSearch input[type="search"]');
    if (!input?.form) { report('Search isn\'t ready. Try again when SoundCloud loads.'); return; }
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    inPageEvent('submit', () => input.form.requestSubmit());
    return;
  }
  if (name === 'openUrl') {
    if (!openTrack(value, report)) report('That track isn\'t available.');
    return;
  }
  if (name === 'followTrack') {
    const track = trackLink(value, location.href);
    if (!track) return;
    const target = new URL(track.trackUrl);
    const badge = document.querySelector(`${playerSelector} .playbackSoundBadge__titleLink`);
    const badgeTrack = trackLink(badge?.getAttribute('href'), location.href);
    const preferred = badgeTrack?.trackId === track.trackId && new URL(badgeTrack.trackUrl).origin === location.origin
      ? badge : undefined;
    routeInPlace(`${target.pathname}${target.search}`, preferred);
    return;
  }
  if (name === 'hideComments') {
    const root = document.documentElement;
    root.classList.toggle('sc-hide-comments', value === true);
    syncFrameWaveformComments(value === true);
    if (root.classList.contains('sc-listen')) fitListenFrame();
    return;
  }
  if (name === 'listenMode') {
    setListeningMode(value.enabled, value.trackId, value.title);
    return;
  }
  if (name === 'queueJump' || name === 'queueRemove') {
    const row = queueRow(value?.trackId);
    if (!row) { report('That queue row is no longer there.'); return; }
    const control = name === 'queueJump'
      ? row.querySelector('.queueItemView__playButton')
      : row.querySelector('button.queueItemView__remove');
    if (!control) { report('That queue action isn\'t available.'); return; }
    control.click();
    return;
  }
  if (name === 'queueClear') {
    const clear = document.querySelector('.queue__panel button.queue__clear');
    if (!clear) { report('The queue is empty.'); return; }
    clear.click();
    return;
  }
  if (name === 'recover') {
    document.querySelector('audio')?.play().catch(() => report('Playback stalled. Reload if it does not resume.'));
    return;
  }

  const root = document.querySelector(playerSelector);
  if (name === 'volume' || name === 'mute') {
    if (name === 'volume' && setVolume(volumeSlider(root), value)) return;
    const mute = root?.querySelector('.volume .volume__button');
    if (name === 'mute' && enabled(mute)) { mute.click(); return; }
    report('SoundCloud volume is not available yet.');
    return;
  }
  const control = root?.querySelector(controlSelectors[name]);
  if (!enabled(control)) { report('That player control isn\'t available.'); return; }
  if (name !== 'seek') { control.click(); return; }
  const link = root.querySelector('.playbackSoundBadge__titleLink');
  const track = trackLink(link?.getAttribute('href'), location.href);
  const rect = control.getBoundingClientRect();
  if (track?.trackId !== value.trackId || rect.width <= 0 || !Number.isFinite(value.ratio)
    || value.ratio < 0 || value.ratio > 1) {
    report('The track changed or isn\'t seekable yet.');
    return;
  }
  const x = rect.left + rect.width * value.ratio;
  // SoundCloud starts a document-level drag on the rail. Its painted fill is
  // only as wide as the amount already played, and a click alone cannot seek.
  for (const type of ['mousedown', 'mousemove', 'mouseup']) {
    const target = type === 'mousemove' ? document : control;
    target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, clientX: x, clientY: rect.top + rect.height / 2,
      buttons: type === 'mouseup' ? 0 : 1
    }));
  }
}

// Consent dialogs are the biggest chunk of clutter on first load. Only an
// explicit reject-all button is clicked, and only a bounded number of times.
function consentBudget() {
  let attempts = 0;
  return () => {
    if (attempts++ >= 40) return true;
    if (document.cookie.includes('OptanonAlertBoxClosed')) return true;
    const candidates = [
      document.getElementById('onetrust-reject-all-handler'),
      ...document.querySelectorAll('[role="dialog"] button, [role="dialog"] [role="button"], [id*="onetrust"] button, [class*="consent"] button, [class*="cookie"] button')
    ];
    const button = candidates.find(candidate => candidate && candidate.getClientRects().length
      && (isRejectAll(candidate.textContent) || isRejectAll(candidate.getAttribute('aria-label'))));
    if (!button) return false;
    button.click();
    return true;
  };
}

// Track our own changes so SPA navigation restores the original inline styles.
const hiddenModules = new Map();
const hiddenChrome = new WeakSet();
const homeHeadings = 'h1, h2, h3, [role="heading"]';
const homeShelfHeadings = 'h1, h2, [role="heading"]:not([aria-level="3"]), .mixedSelectionModule__titleText';
const homeBlocks = 'li[data-test-id="selection"], .mixedSelectionModule, section';

function homeHeading(block) {
  return block.querySelector('.mixedSelectionModule__titleText') ?? block.querySelector(homeHeadings);
}

function homeHeadingIndex(heading) {
  const full = homeModuleIndex(heading.textContent);
  if (full !== -1) return full;
  // A shelf title can sit next to its "View all" control in the same heading.
  if (!heading.querySelector('a, button, [role="button"]')) return -1;
  const copy = heading.cloneNode(true);
  for (const action of copy.querySelectorAll('a, button, [role="button"]')) action.remove();
  return homeModuleIndex(copy.textContent);
}

function forYouCardKind(href, label) {
  if (href) {
    try {
      const url = new URL(href, 'https://soundcloud.com');
      if (['https://soundcloud.com', 'https://www.soundcloud.com'].includes(url.origin)) {
        const path = decodeURIComponent(url.pathname);
        if (/^\/(?:n\/)?discover\/sets\/new-for-you::[^/]+\/?$/.test(path)) return 1;
        if (/^\/(?:n\/)?discover\/sets\/weekly::[^/]+\/?$/.test(path)) return 2;
      }
    } catch { /* The link may not be a web URL. */ }
  }
  const name = normalise(label);
  if (/^daily drops\b/.test(name)) return 1;
  if (/^weekly wave\b/.test(name)) return 2;
  return 0;
}

function homeForYouCards(scope, named, indexes) {
  const ancestors = new Map();
  const markers = [];
  let cards = 0;
  for (const node of scope.querySelectorAll('a[href], img[alt], button, [role="link"], [role="button"]')) {
    if (node.closest('[role="dialog"], #onetrust-consent-sdk')) continue;
    const kind = forYouCardKind(node.getAttribute('href'),
      node.getAttribute('alt') || node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent);
    if (!kind) continue;
    markers.push([node, kind]);
    cards |= kind;
    for (let parent = node; parent && parent !== scope; parent = parent.parentElement) {
      ancestors.set(parent, (ancestors.get(parent) ?? 0) | kind);
    }
  }
  // Prefer an existing titled shelf containing both cards. Without a semantic
  // heading, keep the smallest common card wrapper, not a whole Home column.
  for (const [block, index] of named) {
    if (index === 0 && ancestors.get(block) === 3) return { cards, block, markers };
  }
  const pairs = [...ancestors].filter(([block, value]) =>
    value === 3 && ![...indexes].some(([heading, index]) => index > 0 && block.contains(heading)));
  const block = pairs.find(([candidate]) =>
    !pairs.some(([inner]) => inner !== candidate && candidate.contains(inner)))?.[0];
  return { cards, block, markers };
}

function homeContent(doc) {
  const scope = doc.querySelector('main, [role="main"]') ?? doc.body;
  const frames = [...scope.querySelectorAll(homeFrames)];
  const blocks = [...scope.querySelectorAll(homeBlocks)].filter(block => {
    if (block.closest('[role="dialog"], #onetrust-consent-sdk') || block.querySelector(homeFrames)) return false;
    const row = block.closest('li[data-test-id="selection"]');
    if (row && row !== block) return false;
    if (block.matches('section') && block.querySelector(homeBlocks)) return false;
    return Boolean(homeHeading(block)) || block.matches('li[data-test-id="selection"], .mixedSelectionModule');
  });
  const named = new Map();
  const headings = [...scope.querySelectorAll(homeShelfHeadings)]
    .filter(heading => !heading.closest('[role="dialog"], #onetrust-consent-sdk'));
  const indexes = new Map(headings.map(heading => [heading, homeHeadingIndex(heading)]));
  for (const [heading, index] of indexes) {
    if (index === -1) continue;
    const row = heading.closest('li[data-test-id="selection"]');
    const wrapper = row ?? heading.closest(homeBlocks);
    if (wrapper && wrapper !== scope && scope.contains(wrapper) && !wrapper.querySelector(homeFrames)
      && !headings.some(other => wrapper.contains(other) && indexes.get(other) !== -1 && indexes.get(other) !== index)) {
      named.set(wrapper, index);
      continue;
    }
    // Some For You variants use an unlabelled div around the heading and cards.
    // Grow past the heading wrapper without crossing into the next shelf.
    let shelf = heading.parentElement;
    if (shelf === scope) continue;
    while (shelf.parentElement !== scope && !shelf.parentElement.querySelector(homeFrames)
      && !headings.some(other => !shelf.contains(other) && shelf.parentElement.contains(other))
      && !shelf.querySelector('a[href] img, article, section')) {
      shelf = shelf.parentElement;
    }
    named.set(shelf, index);
  }
  const forYou = homeForYouCards(scope, named, indexes);
  return { scope, frames, blocks: [...new Set([...blocks, ...named.keys()])], named, forYou };
}

function collectHomeDocs(doc, seen = new Set()) {
  if (!doc?.body || seen.has(doc)) return [];
  seen.add(doc);
  // The crossfade frame is sometimes outside the top document's <main>.
  const content = homeContent(doc);
  const frameDocs = [...new Set([...content.frames, ...doc.querySelectorAll(homeFrames)])]
    .filter(frame => frame.getClientRects().length && doc.defaultView.getComputedStyle(frame).visibility !== 'hidden')
    .flatMap(frame => collectHomeDocs(frame.contentDocument, seen));
  return [...frameDocs, content];
}

function filterHomeBlocks(active) {
  const hide = new Set();
  let forYou, cards = 0, markers = [];
  if (active) {
    const docs = collectHomeDocs(document);
    const keep = new Map();
    for (const doc of docs) {
      cards |= doc.forYou.cards;
      markers.push(...doc.forYou.markers);
      if (doc.forYou.block && !keep.has(0)) keep.set(0, doc.forYou.block);
    }
    for (const { blocks, named } of docs) {
      for (const [block, index] of named) {
        if (!keep.has(index)) keep.set(index, block);
      }
      for (const block of blocks) {
        const index = homeModuleIndex(homeHeading(block)?.textContent);
        if (index !== -1 && !keep.has(index)) keep.set(index, block);
      }
    }
    const kept = [...keep.values()];
    forYou = keep.get(0);
    for (const { scope, blocks } of docs) {
      for (const block of blocks) {
        if (keep.size && !kept.some(element => block.contains(element) || element.contains(block))) hide.add(block);
      }
      // Likes and campaign banners can be separate cards, or image headings
      // without an h2. Suppress them even if Home hasn't populated yet.
      const candidates = scope.querySelectorAll(`${homeHeadings}, img[alt], a[href*="/you/likes"], p`);
      for (const node of candidates) {
        if (node.closest('[role="dialog"], #onetrust-consent-sdk')) continue;
        const label = normalise(node.getAttribute('alt') ?? node.getAttribute('aria-label') ?? node.textContent);
        if (!homeExtra.test(label) && !node.matches('a[href*="/you/likes"]')) continue;
        const block = blocks.find(element => element.contains(node));
        if (block && !kept.some(element => block.contains(element))) {
          hide.add(block);
        } else {
          const card = node.closest('a[href*="/you/likes"]') ?? node.closest('aside, article, li, section');
          const canHide = element => element && element !== scope && scope.contains(element)
            && !element.querySelector(homeFrames) && !kept.some(keptBlock => element.contains(keptBlock));
          let target = canHide(card) ? card : node.parentElement;
          // Some artwork-led promos have only nested divs. Find the first
          // wrapper that contains their artwork links as well as their copy.
          if (!card && /crank the radio|return to the streets/.test(label)) {
            while (canHide(target.parentElement) && !target.querySelector('a[href]')) target = target.parentElement;
          }
          if (canHide(target)) hide.add(target);
        }
      }
    }
  }
  for (const [element, [display, priority]] of hiddenModules) {
    if (hide.has(element)) continue;
    if (display) element.style.setProperty('display', display, priority);
    else element.style.removeProperty('display');
    hiddenModules.delete(element);
  }
  for (const element of hide) {
    if (!hiddenModules.has(element)) {
      hiddenModules.set(element, [element.style.getPropertyValue('display'), element.style.getPropertyPriority('display')]);
    }
    if (element.style.getPropertyValue('display') !== 'none' || element.style.getPropertyPriority('display') !== 'important') {
      element.style.setProperty('display', 'none', 'important');
    }
  }
  const visible = element => element.getClientRects().length
    && element.ownerDocument.defaultView.getComputedStyle(element).visibility === 'visible';
  const shownCards = forYou ? markers.reduce((mask, [node, kind]) =>
    forYou.contains(node) && visible(node) ? mask | kind : mask, 0) : 0;
  const status = !active ? null : forYou
    ? (shownCards === 3 ? 'cards' : (!visible(forYou) || cards === 3 ? 'hidden' : 'heading'))
    : (cards ? 'partial' : 'absent');
  const root = document.documentElement;
  if (status && root.dataset.scForYou !== status) root.dataset.scForYou = status;
  else if (!status && root.hasAttribute('data-sc-for-you')) root.removeAttribute('data-sc-for-you');
}

function declutter() {
  const main = document.querySelector('.l-main');
  const sidebar = document.querySelector('.l-sidebar-right');
  const home = ['/', '/discover'].includes(location.pathname.replace(/\/$/, '') || '/');
  filterHomeBlocks(home);
  if (!home) {
    if (sidebar && hiddenChrome.has(sidebar)) {
      sidebar.style.removeProperty('display');
      hiddenChrome.delete(sidebar);
    }
    if (main?.style.getPropertyValue('width')) {
      main.style.removeProperty('width');
      main.style.removeProperty('box-sizing');
    }
    return;
  }
  if (sidebar && !hiddenChrome.has(sidebar)) {
    sidebar.style.setProperty('display', 'none', 'important');
    hiddenChrome.add(sidebar);
  }
  if (main && main.style.getPropertyValue('width') !== '100%') {
    main.style.setProperty('width', '100%', 'important');
    main.style.setProperty('box-sizing', 'border-box', 'important');
  }
}

const frameWaveMarkers = [
  'main section div[role="slider"][aria-valuenow] ~ div > div > ol',
  'main section .MuiSlider-root ~ div ol',
  'main section .MuiSlider-root ol',
  'main section :has(> .MuiSlider-root) > ol'
].join(', ');
const frameWaveComments = new Map();

function hideFrameWaveformComments(doc) {
  const style = doc.createElement('style');
  style.textContent = `${frameWaveMarkers}, .sc-waveform-comment-tooltip { display: none !important; }`;
  doc.head.append(style);

  // Webi renders the marker row next to the seek surface, but portals its
  // tooltip outside the hero. The active avatar links to it by ID.
  let activeTooltips = new Set();
  const updateTooltips = () => {
    const next = new Set();
    for (const list of doc.querySelectorAll(frameWaveMarkers)) {
      for (const marker of list.querySelectorAll('li[aria-labelledby]')) {
        for (const id of marker.getAttribute('aria-labelledby').trim().split(/\s+/)) {
          const tooltip = doc.getElementById(id)?.closest('.MuiTooltip-popper, [role="tooltip"]');
          if (tooltip) next.add(tooltip);
        }
      }
    }
    for (const tooltip of activeTooltips) {
      if (!next.has(tooltip)) tooltip.classList.remove('sc-waveform-comment-tooltip');
    }
    for (const tooltip of next) tooltip.classList.add('sc-waveform-comment-tooltip');
    activeTooltips = next;
  };
  const observer = new MutationObserver(updateTooltips);
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-labelledby', 'id'] });
  updateTooltips();
  return () => {
    observer.disconnect();
    style.remove();
    for (const tooltip of activeTooltips) tooltip.classList.remove('sc-waveform-comment-tooltip');
  };
}

function syncFrameWaveformComments(enabled) {
  const docs = enabled
    ? new Set([...document.querySelectorAll('iframe.webiIframe')].map(frame => frame.contentDocument).filter(doc => doc?.head && doc.body))
    : new Set();
  for (const [doc, restore] of frameWaveComments) {
    if (docs.has(doc)) continue;
    restore();
    frameWaveComments.delete(doc);
  }
  for (const doc of docs) {
    if (!frameWaveComments.has(doc)) frameWaveComments.set(doc, hideFrameWaveformComments(doc));
  }
}

// Newer accounts get the song hero in SoundCloud's same-origin crossfade iframe.
// In listening mode the frame becomes the whole view and the hero is fitted to
// the frame height, so it neither scrolls nor clips at the bottom.
const listenFrameCss = `
  html, body { overflow: hidden !important; }
  .sc-listen-scroll { height: 100vh !important; overflow: hidden !important; }
  main { width: 100% !important; max-width: none !important; margin-inline: 0 !important; height: 100vh !important; flex: 1 0 auto !important; overflow: hidden !important; }
  main .sc-listen-hero {
    width: 100% !important;
    max-width: none !important;
    margin-inline: 0 !important;
    height: 100vh !important;
    padding-block: 2vh !important;
    box-sizing: border-box !important;
    border-radius: 0 !important;
    user-select: none;
  }
  main .sc-listen-hero > div { height: 100% !important; min-height: 0 !important; }
  main .sc-listen-hero > div > div > :last-child { width: auto !important; height: 100% !important; }
  .sc-listen-hero-footer { display: none !important; }
  .sc-listen-track-content {
    display: grid !important;
    grid-template: none / minmax(0, 1fr) !important;
    grid-auto-rows: max-content !important;
    align-content: start !important;
    row-gap: 12px !important;
    translate: 0 var(--sc-listen-content-offset, 0px) !important;
  }
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
`;

const listenWaveform = 'main section :is(.MuiSlider-root, div[role="slider"][aria-valuenow])';
const trackHeading = 'h1, h2, [role="heading"]:is([aria-level="1"], [aria-level="2"])';
const listenContentOffset = '--sc-listen-content-offset';
const listenContentLift = 8;
const legacyListenContent = '.fullHero__title, .fullHero__info, .fullHero__waveform';
let listenPlaceholder, fittedFrame, fittedDoc, fittedHero, legacyHero;

function updateListenHeroLayout(doc, slider) {
  let hero, column, footer;
  if (slider && document.documentElement.classList.contains('sc-hide-comments')) {
    hero = slider.closest('section');
    // The left column contains the title, waveform and action row as siblings.
    // Require the title before the waveform so we never mistake artwork or
    // the separate discussion below the hero for the action row.
    for (let branch = slider.parentElement; branch && branch !== hero; branch = branch.parentElement) {
      const siblings = [...branch.parentElement.children];
      const hasTitle = siblings.slice(0, siblings.indexOf(branch))
        .some(element => element.matches(trackHeading) || element.querySelector(trackHeading));
      if (!hasTitle) continue;
      column = branch.parentElement;
      const last = branch.nextElementSibling;
      if (last && !last.nextElementSibling && last.querySelector('button, textarea, input, [role="button"]')) footer = last;
      break;
    }
  }
  for (const [className, element] of [['sc-listen-hero-footer', footer], ['sc-listen-track-content', column]]) {
    for (const old of doc.querySelectorAll(`.${className}`)) {
      if (old === element) continue;
      old.classList.remove(className);
      if (className === 'sc-listen-track-content') old.style.removeProperty(listenContentOffset);
    }
    element?.classList.add(className);
  }
  if (column) moveListenContentDown(hero, column, column.children);
}

function moveListenContentDown(hero, offsetOwner, elements) {
  const boxes = Array.from(elements, element => element.getBoundingClientRect()).filter(box => box.height > 0);
  if (!boxes.length) return;
  const bounds = hero.getBoundingClientRect();
  const previous = offsetOwner.style.getPropertyValue(listenContentOffset);
  const oldOffset = Number.parseFloat(previous) || 0;
  const top = Math.min(...boxes.map(box => box.top)) - oldOffset;
  const bottom = Math.max(...boxes.map(box => box.bottom)) - oldOffset;
  const spaceAbove = top - bounds.top;
  const spaceBelow = bounds.bottom - bottom;
  // Leave a little more breathing room below the group for the overlay player.
  const offset = Math.max(0, Math.min(spaceBelow, (spaceBelow - spaceAbove) / 2 - listenContentLift));
  const value = `${Math.round(offset * 4) / 4}px`;
  if (previous !== value) offsetOwner.style.setProperty(listenContentOffset, value);
}

function fitListenFrame() {
  const onTrack = listeningTrack && listeningPath(location.href) === listeningTrack;
  let frame, doc, slider;
  if (listeningTrack) {
    for (const candidate of document.querySelectorAll('iframe.webiIframe, iframe[src]')) {
      const content = candidate.contentDocument;
      if (!content?.body) continue;
      const loadedPath = listeningPath(content.URL);
      const sourcePath = listeningPath(candidate.src);
      // A real frame document can lag behind its src when tracks change.
      const exact = loadedPath === listeningTrack
        || (candidate.hasAttribute('srcdoc') && sourcePath === listeningTrack);
      if (!exact && (!onTrack || !candidate.classList.contains('webiIframe'))) continue;
      const waveform = findListenWaveform(content, exact);
      if (!waveform) continue;
      frame = candidate;
      doc = content;
      slider = waveform;
      break;
    }
  }
  const hero = slider?.closest('section');
  const legacy = onTrack && !hero
    ? document.querySelector('.fullHero:has(.fullHero__waveform)') ?? findListenWaveform(document, false)?.closest('section')
    : undefined;
  if (frame !== fittedFrame || doc !== fittedDoc || hero !== fittedHero || legacy !== legacyHero) unfitListenFrame();
  if (!hero && !legacy) {
    if (!listenPlaceholder) {
      listenPlaceholder = document.createElement('div');
      listenPlaceholder.className = 'sc-listen-placeholder';
      listenPlaceholder.setAttribute('role', 'status');
      document.body.append(listenPlaceholder);
    }
    const message = !listeningTrack ? 'Play a track to see its waveform'
      : performance.now() - listeningSince < 6000 ? 'Waiting for the track waveform…' : 'Waveform unavailable for this track';
    if (listenPlaceholder.textContent !== message) listenPlaceholder.textContent = message;
    return;
  }
  listenPlaceholder?.remove();
  listenPlaceholder = undefined;
  if (legacy) {
    legacyHero = legacy;
    legacy.classList.add('sc-listen-legacy');
    if (document.documentElement.classList.contains('sc-hide-comments')) {
      moveListenContentDown(legacy, legacy, legacy.querySelectorAll(legacyListenContent));
    } else legacy.style.removeProperty(listenContentOffset);
    fitListenPreviewProgress(legacy.querySelector('.fullHero__waveform'));
    return;
  }
  fittedFrame = frame;
  fittedDoc = doc;
  fittedHero = hero;
  hero.classList.add('sc-listen-hero');
  frame.classList.add('sc-listen-frame');
  bindListenDrag(doc);
  bindListenPreview(doc);
  if (!doc.getElementById('sc-listen-frame')) {
    const style = doc.createElement('style');
    style.id = 'sc-listen-frame';
    style.textContent = listenFrameCss;
    (doc.head ?? doc.documentElement).append(style);
  }
  updateListenHeroLayout(doc, slider);
  const scroller = [...doc.querySelectorAll('body > div')].find(element => element.querySelector('main'));
  if (scroller) {
    scroller.classList.add('sc-listen-scroll');
    if (scroller.scrollTop) scroller.scrollTop = 0;
  }
  fitListenPreviewProgress(slider);
}

function listeningPath(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin !== location.origin) return null;
    return url.pathname.replace(/^\/n(?=\/[^/]+\/[^/]+\/?$)/, '').replace(/\/$/, '');
  } catch {
    return null;
  }
}

function findListenWaveform(doc, exact) {
  for (const waveform of doc.querySelectorAll(listenWaveform)) {
    if (exact) return waveform;
    const headings = waveform.closest('section')?.querySelectorAll(trackHeading) ?? [];
    if (listeningTitle && [...headings].some(heading => normalise(heading.textContent) === listeningTitle)) return waveform;
  }
}

let sendListenPreviewAction, previewPosition, previewWaveform, previewLayer, previewNative;
const previewDocuments = new WeakSet();
const previewPlayButton = '.playButton, button[aria-label^="play" i], button[aria-label^="pause" i]';

function bindListenPreview(doc) {
  if (!sendListenPreviewAction || previewDocuments.has(doc)) return;
  previewDocuments.add(doc);
  const restrictMedia = () => {
    if (!doc.head) return false;
    const policy = doc.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "media-src 'none'";
    doc.head.prepend(policy);
    return true;
  };
  if (!restrictMedia()) {
    const observer = new MutationObserver(() => {
      if (restrictMedia()) observer.disconnect();
    });
    observer.observe(doc, { childList: true, subtree: true });
  }
  const intercept = event => {
    const hero = doc === fittedDoc ? fittedHero : legacyHero;
    if (event.button !== 0 || !hero?.contains(event.target)) return;
    const seeking = previewWaveform?.contains(event.target);
    const playing = event.target.closest?.(previewPlayButton);
    if (event.type !== 'click') {
      // The native waveform can act on press, before we forward the click.
      if (seeking || playing) event.stopImmediatePropagation();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.isTrusted) return;
    if (seeking) {
      const bounds = previewWaveform.getBoundingClientRect();
      if (bounds.width > 0) {
        const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
        sendListenPreviewAction('seek', listeningTrack, ratio);
      }
    } else if (playing) {
      sendListenPreviewAction('play', listeningTrack);
    }
  };
  for (const type of ['pointerdown', 'mousedown', 'click']) {
    doc.defaultView.addEventListener(type, intercept, true);
  }
}

function setListenPreviewPosition({ trackId, position, duration, progress, isPlaying }) {
  const ratio = duration > 0 && Number.isFinite(position)
    ? Math.min(1, Math.max(0, progress ?? position / duration)) : NaN;
  const previous = previewPosition;
  if (previous && previous.trackId === trackId && previous.ratio === ratio && previous.isPlaying === isPlaying) return;
  const now = performance.now();
  const elapsed = now - (previous?.at ?? now);
  const advance = (ratio - previous?.ratio) * duration;
  // Interpolate confirmed advances only. Pause, buffering and seeks must not
  // let the preview run ahead of the main player.
  const steady = previous?.isPlaying && previous.trackId === trackId && isPlaying
    && advance > 0 && advance <= 1.15 && elapsed < 1500;
  previewPosition = { trackId, ratio, isPlaying, at: now, motion: steady ? Math.max(pollMs, elapsed) : 0 };
  paintListenPreviewProgress();
}

function makeListenPreviewLayer(waveform, art, scene) {
  const doc = waveform.ownerDocument;
  const element = doc.createElement('div');
  element.setAttribute('aria-hidden', 'true');
  element.className = art ? 'sc-listen-preview-played' : 'sc-listen-preview-progress';
  element.style.cssText = 'position:fixed;pointer-events:none;visibility:visible!important;z-index:3';
  let copy;
  if (art) {
    copy = art.localName === 'canvas' ? doc.createElement('canvas') : art.cloneNode(true);
    copy.removeAttribute('id');
    copy.style.position = 'absolute';
    copy.style.left = '0';
    copy.style.top = '0';
    if (art.localName === 'svg') {
      // Recolour the cloned bars directly. A CSS filter can thin the 1 px
      // strokes and leave the white original showing through between them.
      copy.style.filter = 'none';
      copy.style.color = '#f50';
      copy.setAttribute('shape-rendering', 'geometricPrecision');
      for (const node of copy.querySelectorAll('*')) {
        const stroke = node.getAttribute('stroke');
        const fill = node.getAttribute('fill');
        // Inline styles win over the site's classes as well as attributes, so
        // bars styled from CSS and bars styled inline are both recoloured.
        if (fill !== 'none' && fill !== 'transparent') node.style.fill = '#f50';
        if (stroke && stroke !== 'none') node.style.stroke = '#f50';
      }
    }
    element.append(copy);
  } else {
    element.style.cssText += ';width:1px;background:#fff';
  }
  if (scene && copy) {
    // Put the played colour above the waveform and below the comment canvases.
    // Anchor it to the art's own box inside the scene so a fractional scene
    // offset cannot double the bars into a chopped pattern.
    if (getComputedStyle(scene).position === 'static') scene.style.position = 'relative';
    element.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
    art.after(element);
  } else {
    doc.body.append(element);
  }
  return { element, art, copy, width: 0 };
}

function findNativeProgress(waveform) {
  // The crossfade hero already ships a played/unplayed pair of bar groups in
  // its own SVG. Drive that clip instead of cloning the bars, so SoundCloud's
  // bars and comment layer stay exactly as the site drew them.
  const svg = waveform.matches?.('svg') ? waveform : waveform.querySelector?.('svg');
  const clip = svg?.querySelector('clipPath[id$="-played"] rect');
  if (!clip) return;
  const played = [...svg.querySelectorAll('g[clip-path]')]
    .find(group => group.getAttribute('clip-path')?.includes('-played'));
  if (played) played.style.fill = 'var(--special-color, #f50)';
  const viewBox = svg.viewBox?.baseVal;
  const length = viewBox?.width > 0 ? viewBox.width : waveform.getBoundingClientRect().width;
  return { clip, length };
}

function paintNativeProgress(ratio, motion) {
  const native = previewNative;
  if (!native) return;
  const target = Math.max(0, Math.min(1, ratio)) * native.length;
  if (native.target === target) return;
  native.target = target;
  cancelAnimationFrame(native.frame);
  native.frame = 0;
  const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : motion || 0;
  const from = native.value;
  if (!duration || Math.abs(target - from) < 1) {
    native.value = target;
    native.clip.setAttribute('width', String(target));
    return;
  }
  const start = performance.now();
  const step = now => {
    const t = Math.min(1, (now - start) / duration);
    native.value = from + (target - from) * t;
    native.clip.setAttribute('width', String(native.value));
    if (t < 1) native.frame = requestAnimationFrame(step);
    else { native.frame = 0; native.value = target; }
  };
  native.frame = requestAnimationFrame(step);
}

function fitListenPreviewProgress(waveform) {
  if (!sendListenPreviewAction) return;
  if (waveform !== previewWaveform) {
    previewLayer?.element.remove();
    previewLayer = undefined;
    cancelAnimationFrame(previewNative?.frame);
    previewNative = undefined;
    previewWaveform = waveform;
  }
  if (!waveform) return;
  const native = findNativeProgress(waveform);
  if (native) {
    previewLayer?.element.remove();
    previewLayer = undefined;
    if (previewNative?.clip !== native.clip) {
      cancelAnimationFrame(previewNative?.frame);
      previewNative = { ...native, value: Number(native.clip.getAttribute('width')) || 0, target: null, frame: 0 };
    } else if (!previewNative.frame) {
      const current = Number(native.clip.getAttribute('width')) || 0;
      if (Math.abs(current - previewNative.value) > 1) {
        previewNative.value = current;
        previewNative.target = null;
      }
    }
    paintListenPreviewProgress();
    return;
  }
  cancelAnimationFrame(previewNative?.frame);
  previewNative = undefined;
  const bounds = waveform.getBoundingClientRect();
  const scene = waveform.querySelector('.waveform__scene');
  // Crossfade renders the seek slider and waveform art in the same group.
  // Ignore small SVGs such as controls and comment icons.
  const art = scene
    ? scene.querySelector('canvas.sceneLayer:not(.waveformCommentsNode)')
    : [...waveform.parentElement.querySelectorAll('canvas, svg')].find(node => {
      const rect = node.getBoundingClientRect();
      return bounds.width > 0 && rect.width >= bounds.width * .9 && rect.height > 0;
    });
  if (!previewLayer?.element.isConnected || previewLayer.art !== art) {
    previewLayer?.element.remove();
    previewLayer = makeListenPreviewLayer(waveform, art, scene);
  }
  const { element, copy } = previewLayer;
  const artBounds = art?.getBoundingClientRect() ?? bounds;
  if (art && scene) {
    const sceneBounds = scene.getBoundingClientRect();
    element.style.left = `${artBounds.left - sceneBounds.left}px`;
    element.style.top = `${artBounds.top - sceneBounds.top}px`;
    element.style.width = `${artBounds.width}px`;
    element.style.height = `${artBounds.height}px`;
  } else if (art) {
    element.style.left = `${artBounds.left}px`;
    element.style.top = `${artBounds.top}px`;
    element.style.width = `${artBounds.width}px`;
    element.style.height = `${artBounds.height}px`;
  } else {
    element.style.left = `${bounds.left}px`;
    element.style.top = `${bounds.top}px`;
    element.style.width = '1px';
    element.style.height = `${bounds.height}px`;
  }
  if (copy) {
    copy.style.left = '0';
    copy.style.top = '0';
    copy.style.width = '100%';
    copy.style.height = '100%';
    if (art.localName === 'canvas' && art.width && art.height) {
      if (copy.width !== art.width) copy.width = art.width;
      if (copy.height !== art.height) copy.height = art.height;
      const ctx = copy.getContext('2d');
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(art, 0, 0);
      // On the newer hero the bars are about one device pixel wide. Draw the
      // mask half a pixel to either side so the played colour fills the gaps
      // instead of reading as a second, chopped waveform.
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(art, -0.5, 0);
      ctx.drawImage(art, 0.5, 0);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = '#f50';
      ctx.fillRect(0, 0, copy.width, copy.height);
    }
  }
  previewLayer.width = bounds.width;
  paintListenPreviewProgress();
}

function paintListenPreviewProgress() {
  const { trackId, ratio, motion } = previewPosition ?? {};
  if (previewNative) {
    paintNativeProgress(trackId === listeningTrack && Number.isFinite(ratio) ? ratio : 0, motion);
    return;
  }
  if (!previewLayer) return;
  const { element, copy, width } = previewLayer;
  element.hidden = trackId !== listeningTrack || !Number.isFinite(ratio);
  if (element.hidden) return;
  const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : motion;
  if (copy) {
    element.style.transition = duration ? `clip-path ${duration}ms linear` : 'none';
    element.style.clipPath = `inset(0 ${(1 - ratio) * 100}% 0 0)`;
  } else {
    element.style.transition = duration ? `transform ${duration}ms linear` : 'none';
    element.style.transform = `translateX(${width * ratio}px)`;
  }
}

const dragDocuments = new WeakSet();
let sendListenDrag;
function bindListenDrag(doc) {
  if (dragDocuments.has(doc)) return;
  dragDocuments.add(doc);
  let pointer;
  let pendingMove = false;
  const finish = event => {
    if (event.pointerId !== pointer) return;
    pointer = undefined;
    sendListenDrag('end');
  };
  doc.addEventListener('pointerdown', event => {
    if (!event.isTrusted || !event.isPrimary || event.button !== 0 || pointer !== undefined
      || !document.documentElement.classList.contains('sc-listen')) return;
    const target = event.target;
    if (target.closest?.('a, button, input, textarea, select, label, [contenteditable], [role="button"], [role="slider"], .MuiSlider-root, .fullHero__waveform')) return;
    target.setPointerCapture(event.pointerId);
    pointer = event.pointerId;
    event.preventDefault();
    sendListenDrag('start');
  }, true);
  doc.addEventListener('pointermove', event => {
    if (!event.isTrusted || event.pointerId !== pointer) return;
    if (!(event.buttons & 1)) { finish(event); return; }
    if (pendingMove) return;
    pendingMove = true;
    doc.defaultView.requestAnimationFrame(() => {
      pendingMove = false;
      if (event.pointerId === pointer) sendListenDrag('move');
    });
  }, true);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) doc.addEventListener(name, finish, true);
}

function unfitListenFrame() {
  previewLayer?.element.remove();
  cancelAnimationFrame(previewNative?.frame);
  previewNative = undefined;
  previewLayer = previewWaveform = undefined;
  legacyHero?.classList.remove('sc-listen-legacy');
  legacyHero?.style.removeProperty(listenContentOffset);
  fittedFrame?.classList.remove('sc-listen-frame');
  fittedHero?.classList.remove('sc-listen-hero');
  if (fittedDoc) {
    fittedDoc.getElementById('sc-listen-frame')?.remove();
    fittedDoc.querySelector('.sc-listen-scroll')?.classList.remove('sc-listen-scroll');
    updateListenHeroLayout(fittedDoc, null);
  }
  legacyHero = fittedFrame = fittedDoc = fittedHero = undefined;
}


if (process.type === 'renderer') {
  const { ipcRenderer } = require('electron');
  if (process.isMainFrame && location.protocol === 'https:'
    && ['soundcloud.com', 'www.soundcloud.com'].includes(location.hostname)) {
    const preview = process.argv.includes('--simplecloud-listen-preview');
    sendListenDrag = phase => ipcRenderer.send('simplecloud:listen-drag', phase);
    bindListenDrag(document);
    if (preview) {
      sendListenPreviewAction = (...args) => ipcRenderer.send('simplecloud:listen-preview-action', ...args);
      bindListenPreview(document);
    }
    let lastSection;
    const publish = createPublisher(state => ipcRenderer.send(channel, state));
    const tickConsent = consentBudget();
    const consentTimer = !preview && setInterval(() => {
      if (tickConsent()) clearInterval(consentTimer);
    }, 600);
    const timer = setInterval(() => {
      if (!preview) {
        const route = section();
        if (route !== lastSection) ipcRenderer.send('simplecloud:site-section', lastSection = route);
        publish(readPlayer(document.querySelector(playerSelector), location.href));
      }
      if (listeningTrack && !fittedFrame && !legacyHero) fitListenFrame();
    }, pollMs);
    const declutterTimer = setInterval(() => {
      if (!preview) declutter();
      if (document.documentElement.classList.contains('sc-hide-comments')) syncFrameWaveformComments(true);
      if (document.documentElement.classList.contains('sc-listen')) fitListenFrame();
    }, 700);
    ipcRenderer.on('simplecloud:site-action', (_event, name, value) => {
      if (preview) {
        if (name === 'listenPreviewPosition') {
          setListenPreviewPosition(value);
          return;
        }
        if (name !== 'listenMode' && name !== 'hideComments') return;
      }
      runAction(name, value, message => ipcRenderer.send('simplecloud:site-error', message));
      if (name === 'listenMode' && Number.isSafeInteger(value.transition)) {
        ipcRenderer.send('simplecloud:listen-skin', value.transition);
      }
    });
    // A result counts as opened when its link is actually followed from the
    // results page. Play buttons and modified clicks are ignored.
    document.addEventListener('click', event => {
      if (preview || !event.isTrusted || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (location.pathname !== '/search' && !location.pathname.startsWith('/search/')) return;
      const anchor = event.target?.closest?.('a[href]');
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
      if (event.target.closest('button, .sc-button, .playButton')) return;
      const track = trackLink(anchor.getAttribute('href'), location.href);
      if (!track) return;
      const item = anchor.closest('.searchList__item') ?? anchor.closest('.sound');
      const title = item?.querySelector('.soundTitle__title')?.textContent.trim() || anchor.textContent.trim();
      if (!title) return;
      const artwork = item?.querySelector('.sound__artwork .sc-artwork[style]');
      const image = artwork?.style.backgroundImage.match(/url\(["']?(https:\/\/[^"')]+)["']?\)/)?.[1] ?? null;
      ipcRenderer.send('simplecloud:site-search-open', {
        trackId: track.trackId,
        trackUrl: `${location.origin}${track.trackId}`,
        title,
        artist: item?.querySelector('.soundTitle__usernameText')?.textContent.trim() ?? '',
        artworkUrl: image
      });
    }, true);
    window.addEventListener('pagehide', event => {
      if (!event.persisted) {
        clearInterval(timer);
        clearInterval(consentTimer);
        clearInterval(declutterTimer);
      }
    });
  }
} else {
  module.exports = { trackLink, readTime, readPlayer, readQueue, createPublisher, isAllowedHomeModule,
    forYouCardKind, isRejectAll, toggleState, repeatState };
}

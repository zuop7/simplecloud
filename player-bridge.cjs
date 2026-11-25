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
  seek: '.playbackTimeline__progressBar'
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

function readPlayer(root, baseUrl) {
  if (!root) return null;
  const query = selector => root.querySelector(selector);
  const titleLink = query('.playbackSoundBadge__titleLink');
  const queue = readQueue(root, baseUrl);
  if (!titleLink) return { status: 'idle', queue };
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
    isPlaying: playingState(query(controlSelectors.play)),
    shuffle: toggleState(query(controlSelectors.shuffle)),
    repeat: toggleState(query(controlSelectors.repeat)),
    liked: toggleState(query(controlSelectors.like)),
    queue,
    controls: Object.fromEntries(Object.entries(controlSelectors)
      .map(([action, selector]) => [action, enabled(query(selector))]))
  };
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
function routeInPlace(value) {
  let target;
  try { target = new URL(value, location.href); } catch { return false; }
  if (target.origin !== location.origin) return false;
  const matches = anchor => {
    if (anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return false;
    if (anchor.matches('a.header__userNavUsernameButton')) return false;
    try {
      const url = new URL(anchor.getAttribute('href'), location.href);
      return url.origin === target.origin && url.pathname === target.pathname && url.search === target.search;
    } catch {
      return false;
    }
  };
  const existing = [...document.querySelectorAll('a[href]')].find(matches);
  const anchor = existing ?? document.createElement('a');
  if (!existing) {
    anchor.href = `${target.pathname}${target.search}`;
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
  if (name === 'hideComments') {
    const root = document.documentElement;
    root.classList.toggle('sc-hide-comments', value === true);
    syncFrameWaveformComments(value === true);
    if (root.classList.contains('sc-listen')) fitListenFrame();
    return;
  }
  if (name === 'listenMode') {
    const on = value === true;
    document.documentElement.classList.toggle('sc-listen', on);
    if (on) {
      window.scrollTo(0, 0);
      fitListenFrame();
    } else {
      unfitListenFrame();
    }
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
  const control = root?.querySelector(controlSelectors[name]);
  if (!enabled(control)) { report('That player control isn\'t available.'); return; }
  if (name !== 'seek') { control.click(); return; }
  const link = root.querySelector('.playbackSoundBadge__titleLink');
  const track = trackLink(link?.getAttribute('href'), location.href);
  const rect = control.getBoundingClientRect();
  if (track?.trackId !== value.trackId || rect.width <= 0) {
    report('The track changed or isn\'t seekable yet.');
    return;
  }
  const x = rect.left + rect.width * value.ratio;
  for (const type of ['mousedown', 'mouseup', 'click']) {
    control.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, clientX: x, clientY: rect.top + rect.height / 2,
      buttons: type === 'mousedown' ? 1 : 0
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
  main section:first-of-type {
    width: 100% !important;
    max-width: none !important;
    margin-inline: 0 !important;
    height: 100vh !important;
    padding-block: 2vh !important;
    box-sizing: border-box !important;
    border-radius: 0 !important;
    user-select: none;
  }
  main section:first-of-type > div { height: 100% !important; min-height: 0 !important; }
  main section:first-of-type > div > div > :last-child { width: auto !important; height: 100% !important; }
  .sc-listen-hero-footer { display: none !important; }
  .sc-listen-waveform-column {
    display: grid !important;
    grid-template: minmax(min-content, 1fr) auto minmax(0, 1fr) / minmax(0, 1fr) !important;
    align-content: stretch !important;
  }
  .sc-listen-centered-waveform {
    grid-row: 2 !important;
    position: relative !important;
    top: var(--sc-listen-waveform-offset, 0px) !important;
  }
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
`;

const listenWaveform = 'main section :is(.MuiSlider-root, div[role="slider"][aria-valuenow])';
const waveformOffset = '--sc-listen-waveform-offset';

function updateListenHeroFooter(doc, slider) {
  let hero, waveform, footer, titleRow;
  if (slider && document.documentElement.classList.contains('sc-hide-comments')) {
    hero = slider.closest('section');
    const title = 'h1, [role="heading"][aria-level="1"]';
    // The left column contains the title, waveform and action row as siblings.
    // Require the title before the waveform so we never mistake artwork or
    // the separate discussion below the hero for the action row.
    for (let branch = slider.parentElement; branch && branch !== hero; branch = branch.parentElement) {
      const last = branch.nextElementSibling;
      if (!last || last.nextElementSibling || !last.querySelector('button, textarea, input, [role="button"]')) continue;
      const siblings = [...branch.parentElement.children];
      titleRow = siblings.slice(0, siblings.indexOf(branch))
        .find(element => element.matches(title) || element.querySelector(title));
      if (!titleRow) continue;
      waveform = branch;
      footer = last;
      break;
    }
  }
  for (const [className, element] of [
    ['sc-listen-hero-footer', footer],
    ['sc-listen-waveform-column', waveform?.parentElement],
    ['sc-listen-centered-waveform', waveform]
  ]) {
    for (const old of doc.querySelectorAll(`.${className}`)) {
      if (old === element) continue;
      old.classList.remove(className);
      if (className === 'sc-listen-centered-waveform') old.style.removeProperty(waveformOffset);
    }
    element?.classList.add(className);
  }
  if (!waveform) return;
  const bounds = hero.getBoundingClientRect();
  const wave = waveform.getBoundingClientRect();
  const oldOffset = waveform.style.getPropertyValue(waveformOffset);
  const naturalTop = wave.top - (Number.parseFloat(oldOffset) || 0);
  const minTop = titleRow.getBoundingClientRect().bottom + 4;
  const maxTop = bounds.bottom - wave.height;
  // Size the grid as before, but align the wave against the hero, not a
  // potentially shorter title/waveform column. In tight windows avoid the title.
  let offset = 0;
  if (wave.height > 0 && maxTop >= minTop) {
    const centeredTop = bounds.top + (bounds.height - wave.height) / 2;
    const top = Math.min(maxTop, Math.max(minTop, centeredTop));
    offset = Math.round((top - naturalTop) * 4) / 4;
  }
  const value = `${offset}px`;
  if (oldOffset !== value) waveform.style.setProperty(waveformOffset, value);
}

function fitListenFrame() {
  const frame = [...document.querySelectorAll('iframe.webiIframe')]
    .find(element => element.contentDocument?.querySelector(listenWaveform));
  if (!frame) { unfitListenFrame(); return; }
  const doc = frame.contentDocument;
  frame.classList.add('sc-listen-frame');
  bindListenDrag(doc);
  if (!doc.getElementById('sc-listen-frame')) {
    const style = doc.createElement('style');
    style.id = 'sc-listen-frame';
    style.textContent = listenFrameCss;
    (doc.head ?? doc.documentElement).append(style);
  }
  updateListenHeroFooter(doc, doc.querySelector(listenWaveform));
  const scroller = [...doc.querySelectorAll('body > div')].find(element => element.querySelector('main'));
  if (scroller) {
    scroller.classList.add('sc-listen-scroll');
    if (scroller.scrollTop) scroller.scrollTop = 0;
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
  for (const frame of document.querySelectorAll('iframe.sc-listen-frame')) {
    frame.classList.remove('sc-listen-frame');
    const doc = frame.contentDocument;
    doc?.getElementById('sc-listen-frame')?.remove();
    if (doc) updateListenHeroFooter(doc, null);
  }
}


if (process.type === 'renderer') {
  const { ipcRenderer } = require('electron');
  if (process.isMainFrame && location.protocol === 'https:'
    && ['soundcloud.com', 'www.soundcloud.com'].includes(location.hostname)) {
    sendListenDrag = phase => ipcRenderer.send('simplecloud:listen-drag', phase);
    bindListenDrag(document);
    let lastSection;
    const publish = createPublisher(state => ipcRenderer.send(channel, state));
    const tickConsent = consentBudget();
    const consentTimer = setInterval(() => {
      if (tickConsent()) clearInterval(consentTimer);
    }, 600);
    const timer = setInterval(() => {
      const route = section();
      if (route !== lastSection) ipcRenderer.send('simplecloud:site-section', lastSection = route);
      publish(readPlayer(document.querySelector(playerSelector), location.href));
    }, pollMs);
    const declutterTimer = setInterval(() => {
      declutter();
      if (document.documentElement.classList.contains('sc-hide-comments')) syncFrameWaveformComments(true);
      if (document.documentElement.classList.contains('sc-listen')) fitListenFrame();
    }, 700);
    ipcRenderer.on('simplecloud:site-action', (_event, name, value) => {
      runAction(name, value, message => ipcRenderer.send('simplecloud:site-error', message));
    });
    // A result counts as opened when its link is actually followed from the
    // results page. Play buttons and modified clicks are ignored.
    document.addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
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
  module.exports = { trackLink, readTime, readPlayer, readQueue, createPublisher, isAllowedHomeModule, forYouCardKind, isRejectAll, toggleState };
}

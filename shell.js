const bridge = window.simpleCloud;
const byId = id => document.getElementById(id);
const playerButtons = [...document.querySelectorAll('[data-action]')];
const nav = [...document.querySelectorAll('[data-route]')];
const form = document.querySelector('.search');
const search = form.querySelector('input');
const historyPanel = byId('search-history');
const historyList = byId('search-history-list');
const seek = byId('seek');
const mute = byId('mute');
const play = document.querySelector('[data-action="play"]');
const repeat = document.querySelector('[data-action="repeat"]');
const artist = byId('artist');
const trackTitle = byId('track-title');
const cover = document.createElement('img');
cover.alt = '';
cover.referrerPolicy = 'no-referrer';
cover.hidden = true;
document.querySelector('.cover').append(cover);
const pin = byId('pin');
const modeButton = byId('mode');
const playerBar = document.querySelector('.player');
const queuePanel = document.querySelector('.queue');
const queueList = byId('queue-list');
const queueEmpty = document.querySelector('.queue-empty');
const queueMeta = byId('queue-meta');
const queueButton = document.querySelector('[data-action="queue"]');
let player, drag, pending, statusTimer, queueOpen = false, queueSignature = '', queueItems = [];
let historyEntries = [], historyFiltered = [], historyOpen = false, historyActive = -1;
let listening = false;

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '–:––';
  const tail = String(seconds % 60).padStart(2, '0');
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}:${tail}` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${tail}`;
}

function updateSeek() {
  const known = player?.duration > 0 && Number.isFinite(player.position) && player.controls?.seek;
  seek.disabled = !known;
  const position = drag?.position ?? pending?.position ?? player?.position;
  seek.max = known ? player.duration : 1;
  seek.value = known ? Math.min(player.duration, position) : 0;
  byId('elapsed').textContent = formatTime(position);
  byId('duration').textContent = formatTime(player?.duration);
  seek.setAttribute('aria-valuetext', known ? `${formatTime(position)} of ${formatTime(player.duration)}` : 'Unavailable');
}

function renderVolume(state) {
  const available = Number.isFinite(state?.volume);
  mute.disabled = !available;
  const muted = state?.muted === true || state?.volume === 0;
  const label = muted ? 'Unmute' : 'Mute';
  mute.title = `${label} · Arrow Up for volume`;
  mute.setAttribute('aria-label', label);
  mute.querySelector('use').setAttribute('href', muted ? '#i-muted' : '#i-volume');
}

function renderPageLink(link, label, url) {
  link.textContent = label;
  link.title = label;
  if (url) link.setAttribute('href', url);
  else link.removeAttribute('href');
}

function render({ state, route, pinned, mode, keepListenBar, queueOpen: showQueue }) {
  const next = state?.status === 'track' ? state : null;
  if (player?.trackId !== next?.trackId) drag = pending = undefined;
  player = next;
  if (pending && Math.abs(player.position - pending.position) <= 2) pending = undefined;
  for (const button of playerButtons) {
    const action = button.dataset.action;
    if (action === 'queue' || action === 'pin' || action === 'keepBar') button.disabled = false;
    else button.disabled = !player?.controls?.[action];
    if (action === 'pin') button.setAttribute('aria-pressed', String(pinned));
    else if (action === 'keepBar') button.setAttribute('aria-pressed', String(keepListenBar));
    else if (action === 'repeat') button.setAttribute('aria-pressed', String(['one', 'all'].includes(player?.repeat)));
    else if (button.hasAttribute('aria-pressed')) {
      button.setAttribute('aria-pressed', String(player?.[action === 'like' ? 'liked' : action] === true));
    }
  }
  const repeatState = player?.repeat === 'one' ? 'One track' : player?.repeat === 'all' ? 'All tracks' : 'Off';
  repeat.title = `Repeat: ${repeatState}`;
  repeat.setAttribute('aria-description', repeatState);
  repeat.querySelector('use').setAttribute('href', player?.repeat === 'one' ? '#i-repeat-one' : '#i-repeat');
  const playLabel = player?.isPlaying ? 'Pause' : 'Play';
  play.setAttribute('aria-label', playLabel);
  play.title = playLabel;
  play.querySelector('use').setAttribute('href', player?.isPlaying ? '#i-pause' : '#i-play');
  artist.hidden = !player;
  renderPageLink(artist, player?.artist ?? '', player?.artistUrl);
  renderPageLink(trackTitle, player?.title ?? 'Nothing playing', player?.trackUrl);
  const artwork = player?.artworkUrl;
  if (artwork && cover.getAttribute('src') !== artwork) {
    cover.hidden = true;
    cover.src = artwork;
  } else if (!artwork) {
    cover.hidden = true;
    cover.removeAttribute('src');
  }
  for (const button of nav) {
    if (button.dataset.route === route) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  pin.setAttribute('aria-pressed', String(pinned));
  applyMode(mode);
  queueItems = state?.queue ?? [];
  if (queueOpen !== showQueue) setQueue(showQueue);
  renderQueue(queueItems);
  updateSeek();
  renderVolume(state);
}

function applyMode(value) {
  const next = value === 'listen';
  if (next === listening) return;
  listening = next;
  document.body.classList.toggle('listen', next);
}

function totalTime(queue) {  const sum = queue.reduce((total, item) => total + (Number.isFinite(item.duration) ? item.duration : 0), 0);
  return sum ? formatTime(sum) : '';
}

function renderQueue(queue) {
  if (!queueOpen) return;
  const signature = JSON.stringify([player?.trackId,
    queue.map(item => [item.trackId, item.title, item.artist, item.duration])]);
  if (signature === queueSignature) return;
  queueSignature = signature;
  const items = queue.map(item => {
    const li = document.createElement('li');
    li.dataset.trackId = item.trackId;
    if (item.trackId === player?.trackId) li.setAttribute('aria-current', 'true');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'queue-item';
    button.title = `${item.artist} — ${item.title}`;
    const artist = document.createElement('span');
    artist.className = 'queue-artist';
    artist.textContent = item.artist || 'Unknown artist';
    const title = document.createElement('span');
    title.className = 'queue-title';
    title.textContent = item.title;
    button.append(artist, title);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'queue-remove';
    remove.textContent = '×';
    remove.title = 'Remove from queue';
    remove.setAttribute('aria-label', `Remove ${item.title}`);
    const duration = document.createElement('span');
    duration.className = 'queue-time';
    duration.textContent = formatTime(item.duration);
    li.append(button, duration, remove);
    return li;
  });
  queueList.replaceChildren(...items);
  queueEmpty.hidden = items.length > 0;
  queueList.hidden = items.length === 0;
  const total = totalTime(queue);
  queueMeta.textContent = items.length
    ? `${items.length} ${items.length === 1 ? 'track' : 'tracks'}${total ? ` · ${total}` : ''}`
    : '';
}

function svgIcon(id) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  const use = document.createElementNS(namespace, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function renderHistory() {
  const needle = search.value.trim().toLowerCase();
  historyFiltered = historyEntries.filter(entry => {
    if (!needle) return true;
    const haystack = entry.type === 'query' ? entry.query : `${entry.title} ${entry.artist}`;
    return haystack.toLowerCase().includes(needle);
  });
  if (!historyFiltered.length) return false;
  if (historyActive >= historyFiltered.length) historyActive = historyFiltered.length - 1;
  historyList.replaceChildren(...historyFiltered.map((entry, index) => {
    const li = document.createElement('li');
    li.id = `search-history-${index}`;
    li.dataset.key = entry.key;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(index === historyActive));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-item';
    button.tabIndex = -1;
    const icon = document.createElement('span');
    icon.className = 'history-icon';
    if (entry.type === 'track' && entry.artworkUrl) {
      const image = document.createElement('img');
      image.src = entry.artworkUrl;
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => image.remove());
      icon.append(image);
    } else {
      icon.append(svgIcon(entry.type === 'query' ? 'i-search' : 'i-note'));
    }
    const label = document.createElement('span');
    label.className = 'history-label';
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = entry.type === 'query' ? entry.query : entry.title;
    label.append(title);
    if (entry.type === 'track') {
      const artist = document.createElement('span');
      artist.className = 'history-artist';
      artist.textContent = entry.artist || 'Unknown artist';
      label.append(artist);
    }
    button.append(icon, label);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'history-remove';
    remove.tabIndex = -1;
    remove.textContent = '×';
    remove.title = 'Remove from history';
    remove.setAttribute('aria-label', `Remove ${entry.type === 'query' ? `“${entry.query}”` : entry.title} from history`);
    li.append(button, remove);
    return li;
  }));
  const selected = historyList.children[historyActive];
  if (selected) search.setAttribute('aria-activedescendant', selected.id);
  else search.removeAttribute('aria-activedescendant');
  selected?.scrollIntoView({ block: 'nearest' });
  return true;
}

function measureHistory() {
  const headerBottom = Math.round(document.querySelector('.header').getBoundingClientRect().bottom);
  const top = Math.round(document.querySelector('.site-slot').getBoundingClientRect().top);
  document.documentElement.style.setProperty('--search-height', `${top - headerBottom}px`);
  bridge?.action('searchPanel', top);
}

function openHistory() {
  if (!historyEntries.length) return;
  historyOpen = true;
  historyActive = -1;
  historyPanel.hidden = false;
  search.setAttribute('aria-expanded', 'true');
  if (!renderHistory()) { closeHistory(); return; }
  measureHistory();
}

function closeHistory() {
  if (!historyOpen) return;
  historyOpen = false;
  historyActive = -1;
  historyPanel.hidden = true;
  search.setAttribute('aria-expanded', 'false');
  search.removeAttribute('aria-activedescendant');
  measureHistory();
}

function refreshHistory() {
  if (!historyOpen) return;
  if (!historyEntries.length || !renderHistory()) closeHistory();
  else measureHistory();
}

function selectHistory(index) {
  if (!historyFiltered.length) return;
  historyActive = (index + historyFiltered.length) % historyFiltered.length;
  [...historyList.children].forEach((item, position) => {
    item.setAttribute('aria-selected', String(position === historyActive));
  });
  const selected = historyList.children[historyActive];
  search.setAttribute('aria-activedescendant', selected.id);
  selected.scrollIntoView({ block: 'nearest' });
}

function submitSearch(value = search.value) {
  const query = value.trim();
  if (!query) return;
  closeHistory();
  bridge.action('search', query);
  search.blur();
}

function activateHistory(index = historyActive) {
  const entry = historyFiltered[index];
  if (!entry) return;
  if (entry.type === 'query') {
    search.value = entry.query;
    submitSearch(entry.query);
    return;
  }
  closeHistory();
  search.value = '';
  bridge.action('openUrl', entry.trackUrl);
  search.blur();
}

function setQueue(open) {
  queueOpen = open;
  queuePanel.hidden = !open;
  document.body.classList.toggle('queue-open', open);
  queueButton.setAttribute('aria-expanded', String(open));
}

for (const button of nav) button.addEventListener('click', () => bridge.action('navigate', button.dataset.route));
for (const [link, kind] of [[artist, 'artist'], [trackTitle, 'track']]) {
  link.addEventListener('click', event => {
    event.preventDefault();
    const url = link.getAttribute('href');
    if (url) bridge.action('openPlayerPage', { kind, url });
  });
}
for (const button of playerButtons) {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (action === 'queue') bridge.action('queuePanel');
    else bridge.action(action);
  });
}
modeButton.addEventListener('click', () => bridge.action('mode'));
for (const button of document.querySelectorAll('[data-window]')) {
  button.addEventListener('click', () => bridge.action(button.dataset.window));
}
byId('queue-close').addEventListener('click', () => bridge.action('queuePanel', false));
byId('queue-clear').addEventListener('click', () => bridge.action('queueClear'));
queueList.addEventListener('click', event => {
  const row = event.target.closest('li');
  if (!row?.dataset.trackId) return;
  if (event.target.closest('.queue-remove')) bridge.action('queueRemove', { trackId: row.dataset.trackId });
  else bridge.action('queueJump', { trackId: row.dataset.trackId });
});
queuePanel.addEventListener('keydown', event => {
  if (event.key === 'Escape') { bridge.action('queuePanel', false); queueButton.focus(); return; }
  const row = event.target.closest('li');
  if (!row) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const rows = [...queueList.children];
    const index = rows.indexOf(row);
    const target = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    target?.querySelector('.queue-item')?.focus();
  } else if (event.key === 'Delete' && row.dataset.trackId) {
    event.preventDefault();
    bridge.action('queueRemove', { trackId: row.dataset.trackId });
  }
});
pin.addEventListener('click', () => bridge.action('pin'));
cover.addEventListener('load', () => { cover.hidden = false; });
cover.addEventListener('error', () => { cover.hidden = true; });
form.addEventListener('submit', event => {
  event.preventDefault();
  if (historyOpen && historyActive >= 0) activateHistory();
  else submitSearch();
});
search.addEventListener('focus', openHistory);
search.addEventListener('input', () => {
  if (historyEntries.length) openHistory();
  else closeHistory();
});
search.addEventListener('blur', () => {
  setTimeout(() => { if (document.activeElement !== search) closeHistory(); }, 0);
});
search.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!historyOpen) openHistory();
    if (!historyFiltered.length) return;
    event.preventDefault();
    selectHistory(historyActive + (event.key === 'ArrowDown' ? 1 : -1));
  } else if (event.key === 'Escape') {
    if (historyOpen) {
      event.preventDefault();
      closeHistory();
    } else {
      search.blur();
      bridge.action('focusSite');
    }
  }
});
historyList.addEventListener('mousedown', event => {
  if (event.target.closest('button')) event.preventDefault();
});
historyList.addEventListener('click', event => {
  const row = event.target.closest('li');
  if (!row) return;
  if (event.target.closest('.history-remove')) bridge.action('searchHistoryRemove', row.dataset.key);
  else activateHistory(historyFiltered.findIndex(entry => entry.key === row.dataset.key));
});
byId('search-history-clear').addEventListener('click', () => bridge.action('searchHistoryClear'));
window.addEventListener('resize', measureHistory);
seek.addEventListener('input', () => {
  if (!player) return;
  drag = { trackId: player.trackId, position: seek.valueAsNumber };
  updateSeek();
});
seek.addEventListener('change', () => {
  if (!drag || !player || drag.trackId !== player.trackId) return;
  pending = drag;
  drag = undefined;
  const expected = pending;
  bridge.action('seek', { trackId: pending.trackId, ratio: pending.position / player.duration });
  setTimeout(() => {
    if (pending === expected) {
      pending = undefined;
      updateSeek();
    }
  }, 1800);
});
seek.addEventListener('pointercancel', () => { drag = undefined; updateSeek(); });
function showVolume(focus = false) {
  if (mute.disabled) return;
  const { x, y, width, height } = mute.getBoundingClientRect();
  bridge.action('volumePopup', { x, y, width, height, focus });
}
mute.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') showVolume(); });
mute.addEventListener('click', () => bridge.action('mute'));
document.addEventListener('keydown', event => {
  if (event.key === 'ArrowUp' && event.target === mute) {
    event.preventDefault();
    showVolume(true);
  }
  if (event.key === 'Escape' && mute.getAttribute('aria-expanded') === 'true') bridge.action('volumeDismiss');
});

if (bridge) {
  bridge.onState(render);
  bridge.onHistory(entries => {
    historyEntries = Array.isArray(entries) ? entries : [];
    refreshHistory();
  });
  bridge.onFocusSearch(() => {
    search.focus();
    search.select();
    openHistory();
  });
  bridge.onFocusPlayer(() => {
    playerBar.querySelector('.play:not(:disabled), [data-action="keepBar"]').focus();
  });
  bridge.onBlurSearch(closeHistory);
  bridge.onVolumeOpened(() => mute.setAttribute('aria-expanded', 'true'));
  bridge.onVolumeClosed(focus => {
    mute.setAttribute('aria-expanded', 'false');
    if (focus) mute.focus();
  });
  bridge.onError(message => {
    const status = byId('status');
    status.textContent = message;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.textContent = ''; }, 4200);
  });
  bridge.ready();
}

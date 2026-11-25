const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, Menu, MenuItem, WebContentsView, dialog, screen, shell: desktopShell } = require('electron');
const searchHistory = require('./search-history.cjs');
const { createNetworkFilter, sources: filterSources } = require('./network-filter.cjs');

const home = 'https://soundcloud.com/discover';
const accountSettings = 'https://soundcloud.com/settings';
const probe = process.argv.includes('--probe');
const safeMode = process.argv.includes('--safe-mode');
if (probe) {
  const probeData = path.join(os.tmpdir(), 'simplecloud-probe');
  fs.mkdirSync(probeData, { recursive: true });
  app.setPath('userData', probeData);
}
const shellPath = path.join(__dirname, 'shell.html');
const shellUrl = pathToFileURL(shellPath).href;
const appIcon = path.join(__dirname, 'assets', 'cloud.png');
const siteChrome = fs.readFileSync(path.join(__dirname, 'site-chrome.css'), 'utf8');
const shellBackground = '#202124'; // Matches --bg in shell.css.
const headerHeight = 52;
const playerHeight = 60;
const minWidth = 800;
const minHeight = 460;
const webPreferences = { nodeIntegration: false, contextIsolation: true, sandbox: true };
const routeNames = new Set(['home', 'feed', 'library', 'likes', 'profile', 'search']);
const transport = new Set(['previous', 'play', 'next', 'shuffle', 'repeat', 'like']);
const queueWidth = 344;
const queueHeight = 200;
const listenWidth = 1180;
const listenHeight = 300;
const listenBarHeight = 48;
const listenHoverEdge = 16;
const listenRevealDelay = 120;
const listenHideDelay = 500;
const minListenWidth = 640;
const minListenHeight = 240;

function permittedPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port
      && (url.hostname === 'soundcloud.com' || url.hostname.endsWith('.soundcloud.com'));
  } catch {
    return false;
  }
}

function isPlayerPage(value) {
  return permittedPage(value) && ['soundcloud.com', 'www.soundcloud.com'].includes(new URL(value).hostname);
}

function restrictNavigation(contents, allow = permittedPage) {
  for (const eventName of ['will-navigate', 'will-redirect']) {
    contents.on(eventName, (event, legacyUrl) => {
      if (event.isMainFrame === false) return;
      if (!allow(event.url ?? legacyUrl)) event.preventDefault();
    });
  }
  contents.on('will-attach-webview', event => event.preventDefault());
}

function readGeometry(file) {
  try {
    const { x, y, width, height, maximized, pinned } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (![x, y, width, height].every(Number.isInteger) || width < minWidth || height < minHeight) return {};
    const display = screen.getDisplayMatching({ x, y, width, height }).workArea;
    const w = Math.min(width, Math.max(display.width, minWidth));
    const h = Math.min(height, Math.max(display.height, minHeight));
    return {
      x: Math.max(display.x, Math.min(x, display.x + display.width - w)),
      y: Math.max(display.y, Math.min(y, display.y + display.height - h)),
      width: w, height: h, maximized: maximized === true, pinned: pinned === true
    };
  } catch {
    return {};
  }
}

function restrictSite(contents) {
  restrictNavigation(contents);
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.setWindowOpenHandler(({ url }) => permittedPage(url)
    ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { ...webPreferences, preload: undefined } } }
    : { action: 'deny' });
  contents.on('did-create-window', child => {
    restrictNavigation(child.webContents);
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

function openSafeMode() {
  // Same local session, but no SimpleCloud preload, stylesheet or player controls.
  const window = new BrowserWindow({
    title: 'SimpleCloud — Safe mode', icon: appIcon, width: 1200, height: 850, show: !probe,
    autoHideMenuBar: true, webPreferences: { ...webPreferences, partition: probe ? 'simplecloud-probe' : 'persist:soundcloud' }
  });
  const contents = window.webContents;
  restrictSite(contents);
  const timeout = probe && setTimeout(() => app.exit(1), 30_000);
  contents.loadURL(home).then(async () => {
    if (!probe) return;
    const vanilla = await contents.executeJavaScript(`new Promise(resolve => {
      const check = () => {
        if (!document.querySelector('header[role="banner"]')) return;
        observer.disconnect();
        resolve(location.pathname.replace(/\\/$/, '') === '/discover'
          && !document.documentElement.matches('.sc-hide-comments, .sc-listen'));
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true });
      check();
    })`);
    if (!vanilla || contents.getLastWebPreferences().preload) throw new Error('Safe mode did not load the unmodified site.');
    clearTimeout(timeout);
    console.log('[probe] Safe mode: SoundCloud loaded without a SimpleCloud preload.');
    app.exit(0);
  }).catch(error => {
    if (probe) { console.error('[probe]', error.message); app.exit(1); }
    else dialog.showErrorBox('SoundCloud could not load', 'Check your connection and restart SimpleCloud.');
  });
}

function openShell() {
  const geometryFile = path.join(app.getPath('userData'), 'window.json');
  const historyFile = path.join(app.getPath('userData'), 'search-history.json');
  let history = searchHistory.load(historyFile);
  const commentsFile = path.join(app.getPath('userData'), 'hide-comments.json');
  let hideComments = false;
  if (!probe) {
    try { hideComments = JSON.parse(fs.readFileSync(commentsFile, 'utf8')) === true; } catch { /* default off */ }
  }
  const { maximized, pinned: savedPin, ...bounds } = probe ? {} : readGeometry(geometryFile);
  const window = new BrowserWindow({
    title: 'SimpleCloud', icon: appIcon, width: 1200, height: 850, ...bounds,
    minWidth, minHeight, frame: false, roundedCorners: true,
    ...(process.platform === 'win32' && { accentColor: false }),
    autoHideMenuBar: true, show: false, backgroundColor: shellBackground
  });
  const shellView = new WebContentsView({
    webPreferences: { ...webPreferences, preload: path.join(__dirname, 'shell-preload.cjs') }
  });
  const shell = shellView.webContents;
  shellView.setBackgroundColor(shellBackground);
  window.contentView.addChildView(shellView);
  restrictNavigation(shell, value => value === shellUrl);
  shell.setWindowOpenHandler(() => ({ action: 'deny' }));

  const view = new WebContentsView({
    webPreferences: {
      ...webPreferences,
      preload: path.join(__dirname, 'player-bridge.cjs'),
      partition: probe ? 'simplecloud-probe' : 'persist:soundcloud'
    }
  });
  const site = view.webContents;
  const filters = probe ? null : createNetworkFilter(site.session, app.getPath('userData'));
  let listeningCorners;
  if (process.platform === 'win32') {
    try {
      listeningCorners = require('./windows-corners.cjs').createListeningCorners(window, screen);
    } catch (error) {
      console.warn('[shell] Could not initialize Windows corners:', error.message);
    }
  }
  view.setBackgroundColor(shellBackground);
  window.contentView.addChildView(view);
  let queueOpen = false;
  let siteTop = headerHeight;
  let mode = 'browser';
  let browserView;
  let dragOrigin;
  let settingsMenu;
  let listenHover = false;
  let hoverChangedAt;
  let listenKeyboard = false;
  let hoverTimer;
  let cornersApplied = false;
  const showListenBar = () => {
    const visible = mode !== 'listen' || queueOpen || listenHover || listenKeyboard;
    if (!visible && shell.isFocused() && window.isFocused()) site.focus();
    shellView.setVisible(visible);
  };
  const updateListenBar = (point, now = performance.now()) => {
    const { x, y, width, height } = window.getContentBounds();
    const bottom = y + height - (queueOpen ? queueHeight : 0);
    const depth = listenHover ? listenBarHeight + 6 : listenHoverEdge;
    const next = !dragOrigin && point.x >= x && point.x < x + width
      && point.y >= bottom - depth && point.y < bottom;
    if (next === listenHover) {
      hoverChangedAt = undefined;
      return;
    }
    hoverChangedAt ??= now;
    if (now - hoverChangedAt < (next ? listenRevealDelay : listenHideDelay)) return;
    hoverChangedAt = undefined;
    listenHover = next;
    showListenBar();
  };
  window.on('blur', () => {
    dragOrigin = undefined;
    listenKeyboard = listenHover = false;
    hoverChangedAt = undefined;
    showListenBar();
  });
  const layout = () => {
    const [width, height] = window.getContentSize();
    if (mode === 'listen') {
      const heroHeight = height - (queueOpen ? queueHeight : 0);
      view.setBounds({ x: 0, y: 0, width, height: heroHeight });
      shellView.setBounds({ x: 0, y: heroHeight - listenBarHeight, width, height: height - heroHeight + listenBarHeight });
      showListenBar();
      cornersApplied = listeningCorners?.apply() ?? false;
      return;
    }
    shellView.setBounds({ x: 0, y: 0, width, height });
    showListenBar();
    const viewWidth = Math.max(0, width - (queueOpen ? queueWidth : 0));
    view.setBounds({ x: 0, y: siteTop, width: viewWidth, height: Math.max(0, height - siteTop - playerHeight) });
  };
  layout();
  window.on('resize', layout);
  window.on('move', () => {
    if (mode === 'listen') cornersApplied = listeningCorners?.apply() ?? false;
  });
  if (savedPin) window.setAlwaysOnTop(true);
  if (!probe) {
    shell.once('did-finish-load', () => {
      if (maximized) window.maximize();
      window.show();
      shell.focus();
    });
    window.on('close', () => {
      try {
        const saved = mode === 'listen' && browserView ? browserView : {
          bounds: window.getNormalBounds(), maximized: window.isMaximized()
        };
        fs.writeFileSync(geometryFile, JSON.stringify({
          ...saved.bounds, maximized: saved.maximized, pinned: window.isAlwaysOnTop()
        }));
      } catch (error) {
        console.warn('[shell] Could not save window position:', error.message);
      }
    });
  }
  window.on('closed', () => {
    clearInterval(hoverTimer);
    if (!shell.isDestroyed()) shell.close();
    if (!site.isDestroyed()) site.close();
  });

  // Site and shell are separate renderers. The site cannot invoke shell actions.
  restrictSite(site);
  const applyCommentPreference = () => {
    if (!site.isDestroyed() && isPlayerPage(site.getURL())) {
      site.send('simplecloud:site-action', 'hideComments', hideComments);
    }
  };
  const focusSearch = (event, input) => {
    if (input.type !== 'keyDown' || input.key?.toLowerCase() !== 'f') return;
    if (!input.control || input.alt || input.shift || input.meta) return;
    event.preventDefault();
    if (mode === 'listen') leaveListen();
    shell.focus();
    shell.send('simplecloud:focus-search');
  };
  const toggleListen = (event, input) => {
    if (input.type !== 'keyDown' || input.key?.toLowerCase() !== 'l') return;
    if (!input.control || !input.shift || input.alt || input.meta) return;
    event.preventDefault();
    if (mode === 'listen') leaveListen();
    else enterListen();
  };
  shell.on('before-input-event', focusSearch);
  site.on('before-input-event', focusSearch);
  shell.on('before-input-event', toggleListen);
  site.on('before-input-event', toggleListen);
  const focusListenBar = (event, input) => {
    if (mode !== 'listen' || input.type !== 'keyDown' || input.control || input.shift || input.alt || input.meta) return;
    if (input.key !== 'F6' && !(input.key === 'Escape' && listenKeyboard)) return;
    event.preventDefault();
    listenKeyboard = !listenKeyboard;
    showListenBar();
    if (listenKeyboard) {
      shell.focus();
      shell.send('simplecloud:focus-player');
    } else {
      site.focus();
    }
  };
  shell.on('before-input-event', focusListenBar);
  site.on('before-input-event', focusListenBar);
  site.on('focus', () => {
    if (ready && !shell.isDestroyed()) shell.send('simplecloud:blur-search');
  });
  site.on('dom-ready', () => {
    if (isPlayerPage(site.getURL())) {
      site.insertCSS(siteChrome).catch(error => console.warn('[shell] Could not apply site chrome:', error.message));
      applyCommentPreference();
      if (mode === 'listen') site.send('simplecloud:site-action', 'listenMode', true);
    }
  });

  let state, serialized, route, ready, scriptNavigation;
  const broadcast = () => {
    if (ready && !shell.isDestroyed()) {
      shell.send('simplecloud:shell-state', { state, route, pinned: window.isAlwaysOnTop(), mode });
    }
  };
  const report = message => {
    if (probe) console.error('[probe]', message);
    if (ready && !shell.isDestroyed()) shell.send('simplecloud:shell-error', message);
  };
  const setHistory = value => {
    history = value;
    searchHistory.save(historyFile, history);
    if (ready && !shell.isDestroyed()) shell.send('simplecloud:search-history', history);
  };
  const followPlayback = () => {
    if (mode !== 'listen' || state?.status !== 'track' || scriptNavigation?.until > Date.now()) return;
    try {
      const current = new URL(site.getURL());
      if (current.pathname.replace(/\/$/, '') === new URL(state.trackUrl).pathname.replace(/\/$/, '')) return;
    } catch {
      return;
    }
    scriptNavigation = { target: null, until: Date.now() + 3500 };
    site.send('simplecloud:site-action', 'openUrl', state.trackUrl);
  };
  const enterListen = () => {
    if (mode === 'listen') return;
    browserView = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
    if (window.isMaximized()) window.unmaximize();
    queueOpen = false;
    mode = 'listen';
    listenHover = listenKeyboard = false;
    hoverChangedAt = undefined;
    window.contentView.addChildView(shellView);
    if (!probe) {
      hoverTimer = setInterval(() => {
        if (window.isFocused() || (window.isAlwaysOnTop() && !window.isMinimized())) {
          updateListenBar(screen.getCursorScreenPoint());
        }
      }, 40);
    }
    shell.send('simplecloud:blur-search');
    window.setMinimumSize(minListenWidth, minListenHeight);
    const area = screen.getDisplayMatching(browserView.bounds).workArea;
    window.setContentSize(Math.min(listenWidth, area.width), Math.min(listenHeight, area.height));
    const bounds = window.getBounds();
    window.setPosition(
      Math.max(area.x, Math.min(browserView.bounds.x, area.x + area.width - bounds.width)),
      Math.max(area.y, Math.min(browserView.bounds.y, area.y + area.height - bounds.height))
    );
    broadcast();
    layout();
    site.focus();
    site.send('simplecloud:site-action', 'listenMode', true);
    followPlayback();
  };
  const leaveListen = () => {
    if (mode !== 'listen' || !browserView) return;
    dragOrigin = undefined;
    clearInterval(hoverTimer);
    mode = 'browser';
    if (listeningCorners && !listeningCorners.clear()) console.warn('[shell] Could not clear the listening window shape.');
    window.contentView.addChildView(view);
    queueOpen = false;
    shell.send('simplecloud:blur-search');
    window.setMinimumSize(minWidth, minHeight);
    window.setBounds(browserView.bounds);
    if (browserView.maximized) window.maximize();
    browserView = undefined;
    broadcast();
    layout();
    site.send('simplecloud:site-action', 'listenMode', false);
  };
  const from = (event, allow) => event.senderFrame && !event.senderFrame.parent && allow(event.senderFrame.url);
  site.ipc.on('simplecloud:listen-drag', (event, phase) => {
    if (mode !== 'listen' || !window.isFocused() || !from(event, isPlayerPage)) return;
    if (phase === 'end') {
      dragOrigin = undefined;
    } else if (phase === 'start') {
      const { x, y } = screen.getCursorScreenPoint();
      const bounds = window.getBounds();
      if (x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height) return;
      dragOrigin = { x: x - bounds.x, y: y - bounds.y };
    } else if (phase === 'move' && dragOrigin) {
      const { x, y } = screen.getCursorScreenPoint();
      window.setPosition(x - dragOrigin.x, y - dragOrigin.y);
    }
  });
  shell.ipc.on('simplecloud:shell-ready', event => {
    if (!from(event, value => value === shellUrl)) return;
    ready = true;
    shell.send('simplecloud:search-history', history);
    broadcast();
    checkProbe();
  });
  shell.ipc.on('simplecloud:shell-action', (event, name, value) => {
    if (!from(event, url => url === shellUrl)) return;
    if (mode === 'browser') {
      if (name === 'minimize') { window.minimize(); return; }
      if (name === 'maximize') {
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        return;
      }
      if (name === 'close') { window.close(); return; }
      if (name === 'settings') { settingsMenu?.popup({ window }); return; }
    }
    if (name === 'pin') {
      window.setAlwaysOnTop(!window.isAlwaysOnTop());
      broadcast();
      return;
    }
    if (name === 'queuePanel') {
      const open = value === true;
      if (mode === 'listen' && open !== queueOpen) {
        const [width, height] = window.getContentSize();
        if (open) {
          window.setMinimumSize(minListenWidth, minListenHeight + queueHeight);
          queueOpen = true;
          window.setContentSize(width, height + queueHeight);
        } else {
          window.setMinimumSize(minListenWidth, minListenHeight);
          queueOpen = false;
          window.setContentSize(width, height - queueHeight);
        }
      } else {
        queueOpen = open;
      }
      layout();
      return;
    }
    if (name === 'mode') {
      if (mode === 'listen') leaveListen();
      else enterListen();
      return;
    }
    if (name === 'searchPanel') {
      siteTop = Number.isFinite(value)
        ? Math.min(Math.max(headerHeight, Math.round(value)), headerHeight + 420)
        : headerHeight;
      layout();
      return;
    }
    if (name === 'searchHistoryRemove' && typeof value === 'string') {
      setHistory(searchHistory.removeEntry(history, value));
      return;
    }
    if (name === 'searchHistoryClear') {
      setHistory([]);
      return;
    }
    if (name === 'focusSite') { site.focus(); return; }
    if (!isPlayerPage(site.getURL())) { report('Wait for SoundCloud to finish loading.'); return; }
    if (name === 'navigate' && (!routeNames.has(value) || value === 'search')) return;
    if (name === 'search' && (typeof value !== 'string' || !value.trim() || value.length > 200)) return;
    if (name === 'openUrl' && (typeof value !== 'string' || !permittedPage(value)
      || !/^\/[^/]+\/[^/]+$/.test(new URL(value).pathname))) return;
    if (name === 'seek' && (typeof value?.trackId !== 'string' || value.trackId !== state?.trackId
      || !Number.isFinite(value.ratio) || value.ratio < 0 || value.ratio > 1)) return;
    if ((name === 'queueJump' || name === 'queueRemove') && typeof value?.trackId !== 'string') return;
    if (!transport.has(name) && !['seek', 'navigate', 'search', 'openUrl', 'queueJump', 'queueRemove', 'queueClear', 'recover'].includes(name)) return;
    if (name === 'navigate' || name === 'search') {
      scriptNavigation = { target: name === 'search' ? 'search' : value, until: Date.now() + 3500 };
      if (name === 'search') setHistory(searchHistory.addEntry(history, searchHistory.queryEntry(value)));
    }
    if (name === 'openUrl') {
      scriptNavigation = { target: null, until: Date.now() + 3500 };
      const entry = history.find(item => item.key === `t:${new URL(value).pathname}`);
      if (entry) setHistory(searchHistory.addEntry(history, entry));
    }
    site.send('simplecloud:site-action', name, value);
    if (name === 'search' || name === 'openUrl') site.focus();
  });
  site.on('will-navigate', event => {
    if (scriptNavigation?.until > Date.now()) {
      event.preventDefault();
      scriptNavigation = undefined;
      report('SoundCloud didn’t open that page in place. Playback was left alone.');
    }
  });
  site.on('did-start-navigation', details => {
    if (!details.isMainFrame || details.isSameDocument) return;
    state = serialized = route = undefined;
    broadcast();
  });
  site.ipc.on('simplecloud:site-section', (event, value) => {
    if (!from(event, isPlayerPage) || (value !== null && !routeNames.has(value))) return;
    if (value === scriptNavigation?.target) scriptNavigation = undefined;
    route = value;
    broadcast();
  });
  site.ipc.on('simplecloud:site-search-open', (event, value) => {
    if (!from(event, isPlayerPage)) return;
    const entry = searchHistory.trackEntry(value);
    if (entry) setHistory(searchHistory.addEntry(history, entry));
  });
  site.ipc.on('simplecloud:site-error', (event, value) => {
    if (from(event, isPlayerPage) && typeof value === 'string' && value.length <= 200) report(value);
  });
  let stall = { position: null, since: 0, tries: 0, warned: false };
  const watchdog = value => {
    const now = Date.now();
    if (value.status !== 'track' || !value.isPlaying) { stall = { position: null, since: 0, tries: 0, warned: false }; return; }
    if (value.position !== stall.position) { stall = { position: value.position, since: now, tries: 0, warned: false }; return; }
    if (now - stall.since < 3500) return;
    stall.since = now;
    if (stall.tries < 2) { stall.tries++; site.send('simplecloud:site-action', 'recover'); return; }
    if (!stall.warned) {
      stall.warned = true;
      report('Playback looks stuck. Press Play, or reopen the page if it stays silent.');
    }
  };
  site.ipc.on('simplecloud:player-state', (event, value) => {
    if (!from(event, isPlayerPage) || !['idle', 'track'].includes(value?.status)) return;
    const json = JSON.stringify(value);
    if (json.length > 16384 || json === serialized) return;
    serialized = json;
    state = value;
    if (probe) console.log('[bridge]', value.status);
    followPlayback();
    watchdog(value);
    broadcast();
    checkProbe();
  });

  if (!probe) {
    const menu = Menu.getApplicationMenu() ?? new Menu();
    const refreshFilters = () => {
      const { installed, enabled, busy } = filters.status();
      settings.submenu.getMenuItemById('filters-enabled').checked = enabled;
      settings.submenu.getMenuItemById('filters-enabled').enabled = installed && !busy;
      settings.submenu.getMenuItemById('filters-download').enabled = !installed && !busy;
      settings.submenu.getMenuItemById('filters-update').enabled = installed && !busy;
      settings.submenu.getMenuItemById('filters-remove').enabled = installed && !busy;
    };
    const changeFilters = async operation => {
      try {
        const pending = operation();
        refreshFilters();
        await pending;
      } catch (error) {
        if (!window.isDestroyed()) await dialog.showMessageBox(window, {
          type: 'error', title: 'Network filtering', message: 'Could not change network filtering.',
          detail: error.message
        });
      } finally {
        refreshFilters();
      }
    };
    const settings = new MenuItem({
      label: '&Settings',
      submenu: [
        {
          label: 'Hide waveform comments', type: 'checkbox', checked: hideComments,
          click: item => {
            try {
              fs.writeFileSync(commentsFile, JSON.stringify(item.checked));
              hideComments = item.checked;
              applyCommentPreference();
            } catch {
              item.checked = hideComments;
              dialog.showErrorBox('Could not save settings', 'Comment visibility was not changed.');
            }
          }
        },
        {
          label: 'Network filtering (optional)',
          submenu: [
            { id: 'filters-enabled', label: 'Block ads and trackers', type: 'checkbox',
              click: item => void changeFilters(() => filters.setEnabled(item.checked)) },
            { id: 'filters-download', label: 'Download and enable EasyList + EasyPrivacy',
              click: () => void changeFilters(() => filters.download()) },
            { id: 'filters-update', label: 'Update filter lists',
              click: () => void changeFilters(() => filters.download()) },
            { id: 'filters-remove', label: 'Remove filter lists',
              click: () => void changeFilters(() => filters.remove()) },
            { type: 'separator' },
            {
              label: 'About network filtering',
              click: () => void dialog.showMessageBox(window, {
                title: 'Network filtering',
                message: 'Optional ad and tracker blocking for SoundCloud',
                detail: `EasyList and EasyPrivacy are downloaded only when you ask. Filtering applies to future requests without reloading playback. It may not catch ads delivered as part of an audio stream.\n\n${filterSources.join('\n')}`
              })
            }
          ]
        },
        {
          label: 'Diagnostics', accelerator: 'Ctrl+Shift+D',
          click: async () => {
            const forYouLabels = {
              cards: 'Daily Drops and Weekly Wave are on the page',
              heading: 'shelf found; not both playlist cards',
              hidden: 'shelf or cards found in the page markup but not visible',
              partial: 'playlist card found; no complete shelf',
              absent: 'not present in the Home content SimpleCloud received'
            };
            const forYou = isPlayerPage(site.getURL())
              ? await site.executeJavaScript('document.documentElement.dataset.scForYou').catch(() => undefined)
              : undefined;
            if (window.isDestroyed()) return;
            void dialog.showMessageBox(window, {
              title: 'SimpleCloud diagnostics',
              message: 'SoundCloud connection',
              detail: [
                `Mode: ${mode === 'listen' ? 'Listening' : 'Browser'}`,
                `Site: ${isPlayerPage(site.getURL()) ? 'SoundCloud' : 'Not on a player page'}`,
                `Player bridge: ${state?.status === 'track' ? 'Track detected' : state ? 'Connected, idle' : 'Waiting for player'}`,
                `Controls detected: ${Object.entries(state?.controls ?? {}).filter(([, enabled]) => enabled === true).map(([name]) => name).join(', ') || 'None yet'}`,
                `Hide waveform comments: ${hideComments ? 'On' : 'Off'}`,
                `Network filtering: ${filters.status().enabled ? `On (${filters.status().blocked} blocked this run)` : 'Off'}`,
                ...(Object.hasOwn(forYouLabels, forYou) ? [`Per te / For You: ${forYouLabels[forYou]}`] : [])
              ].join('\n')
            });
          }
        }
      ]
    });
    settingsMenu = settings.submenu;
    refreshFilters();
    menu.append(settings);
    Menu.setApplicationMenu(menu);
  }

  let probing = false;
  const probeTimeout = probe && setTimeout(() => {
    console.error('[probe] Timed out waiting for the shell and in-page SoundCloud navigation.');
    app.exit(1);
  }, 30_000);

  async function checkListeningMode() {
    const before = window.getContentSize();
    await site.executeJavaScript(`(() => {
      const frame = document.createElement('iframe');
      frame.id = 'simplecloud-listening-fixture';
      frame.className = 'webiIframe';
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px;height:260px';
      document.body.prepend(frame);
      frame.contentDocument.body.innerHTML = '<main><section id="hero"><div><div style="display:flex">'
        + '<div id="column" style="display:flex;flex:1;flex-direction:column;justify-content:space-between;height:240px">'
        + '<div><h1>Track</h1></div><div id="wave" style="height:100px"><div class="MuiSlider-root"></div></div>'
        + '<div id="hero-actions"><button>Write a comment</button></div></div><div>Artwork</div>'
        + '</div></div></section><section id="discussion">Comments</section></main>';
    })()`);
    const checkHeroActions = async hidden => {
      const result = await site.executeJavaScript(`(() => {
        const doc = document.getElementById('simplecloud-listening-fixture').contentDocument;
        const style = id => doc.defaultView.getComputedStyle(doc.getElementById(id));
        const rect = id => doc.getElementById(id).getBoundingClientRect();
        const middle = box => box.top + box.height / 2;
        return {
          hidden: style('hero-actions').display === 'none',
          centered: style('column').display === 'grid' && style('wave').gridRowStart === '2',
          centerError: rect('wave').height > 0 ? Math.abs(middle(rect('hero')) - middle(rect('wave'))) : null,
          offset: doc.getElementById('wave').style.getPropertyValue('--sc-listen-waveform-offset'),
          discussion: style('discussion').display !== 'none'
        };
      })()`);
      if (result.hidden !== hidden || result.centered !== hidden || !result.discussion
        || (hidden ? result.centerError === null || result.centerError > 1 : result.offset !== '')) {
        throw new Error(`Listening-only hero row did not toggle correctly: ${JSON.stringify(result)}`);
      }
    };
    hideComments = true;
    applyCommentPreference();
    await checkHeroActions(false);
    await shell.executeJavaScript(`document.getElementById('mode').click()`);
    await new Promise(resolve => setTimeout(resolve, 600));
    const started = await shell.executeJavaScript(`(() => ({
      listen: document.body.classList.contains('listen'),
      header: getComputedStyle(document.querySelector('.header')).display,
      scrolls: document.documentElement.scrollHeight > innerHeight || document.body.scrollHeight > innerHeight,
      strip: Math.round(document.querySelector('.player').getBoundingClientRect().height)
    }))()`);
    const base = window.getContentSize();
    const listenBounds = view.getBounds();
    if (!started.listen || started.header !== 'none' || started.scrolls || shellView.getVisible() || started.strip !== listenBarHeight
      || listenBounds.y !== 0 || listenBounds.height !== base[1]) {
      throw new Error(`Listening layout is wrong: ${JSON.stringify({ started, listenBounds, base })}`);
    }
    if (process.platform === 'win32' && !cornersApplied) throw new Error('The Windows listening corner mask was not applied.');
    if (!await site.executeJavaScript(`document.documentElement.classList.contains('sc-listen')`)) {
      throw new Error('SoundCloud did not switch its own chrome for listening mode.');
    }
    const siteBar = await site.executeJavaScript(`(() => {
      const bar = document.querySelector('.playControls');
      return bar ? getComputedStyle(bar).opacity : 'missing';
    })()`);
    if (siteBar !== '0' && siteBar !== 'missing') {
      throw new Error(`SoundCloud's own player bar still paints (${siteBar}).`);
    }
    const heroFrame = await site.executeJavaScript(`(() => {
      const frame = [...document.querySelectorAll('iframe[class*="webiIframe"]')]
        .find(element => element.contentDocument?.querySelector('main section .MuiSlider-root'));
      if (!frame) return null;
      return {
        fitted: frame.classList.contains('sc-listen-frame'),
        style: Boolean(frame.contentDocument.getElementById('sc-listen-frame'))
      };
    })()`);
    if (heroFrame && (!heroFrame.fitted || !heroFrame.style)) {
      throw new Error(`The crossfade hero frame was not fitted: ${JSON.stringify(heroFrame)}`);
    }
    await checkHeroActions(true);
    hideComments = false;
    applyCommentPreference();
    await checkHeroActions(false);
    hideComments = true;
    applyCommentPreference();
    await checkHeroActions(true);
    const content = window.getContentBounds();
    const edge = { x: content.x + 40, y: content.y + content.height - 2 };
    const hero = { x: content.x + 40, y: content.y + 40 };
    updateListenBar(edge, 0);
    updateListenBar(edge, listenRevealDelay - 1);
    if (shellView.getVisible()) throw new Error('The bar appeared before the reveal delay.');
    updateListenBar(edge, listenRevealDelay);
    updateListenBar({ x: edge.x, y: content.y + content.height - listenBarHeight + 2 }, listenRevealDelay + 20);
    if (!shellView.getVisible() || shellView.getBounds().y !== base[1] - listenBarHeight
      || view.getBounds().height !== base[1]) {
      throw new Error('Hover did not overlay the listening bar without resizing the hero.');
    }
    const leftAt = listenRevealDelay + 40;
    updateListenBar(hero, leftAt);
    updateListenBar(hero, leftAt + listenHideDelay - 1);
    if (!shellView.getVisible()) throw new Error('The bar did not linger on pointer exit.');
    updateListenBar(hero, leftAt + listenHideDelay);
    if (shellView.getVisible() || view.getBounds().height !== base[1]) {
      throw new Error('Leaving the bar did not reveal the entire hero.');
    }
    await site.sendInputEvent({ type: 'keyDown', keyCode: 'F6' });
    if (!shellView.getVisible()) throw new Error('F6 did not reveal the listening bar.');
    await shell.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    if (shellView.getVisible()) throw new Error('Escape did not hide the keyboard-revealed bar.');
    await shell.executeJavaScript(`document.querySelector('[data-action="queue"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 500));
    const grown = window.getContentSize();
    const drawer = await shell.executeJavaScript(`(() => {
      const box = document.querySelector('.queue').getBoundingClientRect();
      return { height: Math.round(box.height), bottom: Math.round(innerHeight - box.bottom),
        open: !document.querySelector('.queue').hidden };
    })()`);
    if (!drawer.open || drawer.height !== queueHeight || drawer.bottom !== 0
      || grown[1] !== base[1] + queueHeight
       || view.getBounds().height !== grown[1] - queueHeight) {
      throw new Error(`Listening queue is wrong: ${JSON.stringify({ drawer, grown, base, view: view.getBounds() })}`);
    }
    await shell.executeJavaScript(`document.getElementById('queue-close').click()`);
    await new Promise(resolve => setTimeout(resolve, 450));
    if (window.getContentSize()[1] !== base[1]) throw new Error('Listening queue did not release the window.');
    await shell.executeJavaScript(`document.querySelector('[data-action="mode"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 700));
    const restored = await shell.executeJavaScript(`(() => ({
      listen: document.body.classList.contains('listen'),
      drag: getComputedStyle(document.querySelector('.header')).getPropertyValue('app-region'),
      noDrag: getComputedStyle(document.querySelector('.header .search')).getPropertyValue('app-region'),
      settingsIcon: document.querySelector('[data-window="settings"] svg').viewBox.baseVal.width,
      top: Math.round(document.querySelector('.site-slot').getBoundingClientRect().top)
    }))()`);
    const size = window.getContentSize();
    if (restored.listen || restored.drag !== 'drag' || restored.noDrag !== 'no-drag' || restored.settingsIcon !== 24
      || restored.top !== headerHeight || view.getBounds().y !== headerHeight
      || size[0] !== before[0] || size[1] !== before[1]) {
      throw new Error(`Browser layout was not restored: ${JSON.stringify({ restored, size, before })}`);
    }
    if (await site.executeJavaScript(`document.documentElement.classList.contains('sc-listen')`)) {
      throw new Error('SoundCloud kept the listening chrome after leaving.');
    }
    await checkHeroActions(false);
    hideComments = false;
    applyCommentPreference();
    await site.executeJavaScript(`document.getElementById('simplecloud-listening-fixture').remove()`);
    await site.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control', 'shift'] });
    await site.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: ['control', 'shift'] });
    await new Promise(resolve => setTimeout(resolve, 500));
    if (!await shell.executeJavaScript(`document.body.classList.contains('listen')`)) {
      throw new Error('Ctrl+Shift+L did not enter listening mode.');
    }
    await site.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control', 'shift'] });
    await site.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: ['control', 'shift'] });
    await new Promise(resolve => setTimeout(resolve, 700));
    if (await shell.executeJavaScript(`document.body.classList.contains('listen')`)
      || view.getBounds().y !== headerHeight || window.getContentSize()[1] !== before[1]) {
      throw new Error('Ctrl+Shift+L did not restore browser mode.');
    }
    console.log('[probe] Listening mode:', JSON.stringify({ browser: before, listening: base, grown, restored: size }));
  }

  async function checkProbe() {
    if (!probe || probing || !ready || !state) return;
    probing = true;
    try {
      await site.executeJavaScript(`(() => {
        const frame = document.createElement('iframe');
        frame.id = 'simplecloud-comments-fixture';
        frame.className = 'webiIframe';
        frame.hidden = true;
        document.body.append(frame);
        frame.contentDocument.body.innerHTML = '<main><section><div><div role="slider" aria-valuenow="0"></div>'
          + '<div><div><ol id="markers"><li aria-labelledby="timed-tooltip">Avatar</li></ol></div></div></div>'
          + '<textarea id="composer"></textarea></section><section id="discussion">Comments</section></main>'
          + '<div id="other-tooltip" role="tooltip">Not a timed comment</div>';
      })()`);
      const checkComments = async hidden => {
        hideComments = hidden;
        applyCommentPreference();
        const result = await site.executeJavaScript(`(async () => {
          const waveform = document.createElement('div');
          waveform.className = 'fullHero__waveform';
          const base = document.createElement('canvas');
          const markers = document.createElement('canvas');
          markers.className = 'waveformCommentsNode';
          const popover = document.createElement('div');
          popover.className = 'commentPopover';
          const composer = document.createElement('div');
          composer.className = 'listenEngagement__commentForm';
          const count = document.createElement('a');
          count.className = 'sc-ministats-comments';
          waveform.append(base, markers);
          waveform.append(popover);
          document.body.append(waveform, composer, count);
          const doc = document.getElementById('simplecloud-comments-fixture').contentDocument;
          if (!doc.getElementById('timed-tooltip')) {
            const tooltip = doc.createElement('div');
            tooltip.id = 'timed-tooltip';
            tooltip.setAttribute('role', 'tooltip');
            doc.body.append(tooltip);
          }
          await Promise.resolve();
          try {
            const shown = (win, node) => win.getComputedStyle(node).display !== 'none';
            const framed = id => shown(doc.defaultView, doc.getElementById(id));
            return {
              markers: shown(window, markers), popover: shown(window, popover),
              base: shown(window, base), composer: shown(window, composer), count: shown(window, count),
              framedMarkers: framed('markers'), timedTooltip: framed('timed-tooltip'),
              otherTooltip: framed('other-tooltip'), framedComposer: framed('composer'),
              discussion: framed('discussion'), seek: shown(doc.defaultView, doc.querySelector('[role="slider"]'))
            };
          } finally { waveform.remove(); composer.remove(); count.remove(); }
        })()`);
        if ([result.markers, result.popover, result.framedMarkers, result.timedTooltip].some(visible => visible === hidden)
          || [result.base, result.composer, result.count, result.otherTooltip, result.framedComposer, result.discussion, result.seek].some(visible => !visible)) {
          throw new Error(`Comment toggle did not isolate the waveform markers: ${JSON.stringify(result)}`);
        }
      };
      try {
        await checkComments(true);
        await checkComments(false);
      } finally {
        await site.executeJavaScript(`document.getElementById('simplecloud-comments-fixture').remove()`);
      }
      console.log('[probe] Waveform comment markers and popovers hide and restore; regular comments and seeking stay visible.');
      const slot = await shell.executeJavaScript(`(() => {
        const box = document.querySelector('.site-slot').getBoundingClientRect();
        return { top: box.top, bottom: innerHeight - box.bottom, width: box.width, loaded: !!window.simpleCloud };
      })()`);
      if (!slot.loaded || slot.top !== headerHeight || slot.bottom !== playerHeight || slot.width !== view.getBounds().width) {
        throw new Error('Local chrome and SoundCloud view do not line up.');
      }
      await shell.executeJavaScript(`document.querySelector('[data-action="queue"]').click()`);
      await new Promise(resolve => setTimeout(resolve, 450));
      const drawer = await shell.executeJavaScript(`(() => {
        const panel = document.querySelector('.queue');
        const box = panel.getBoundingClientRect();
        return { open: !panel.hidden, width: box.width, right: box.right, viewport: innerWidth };
      })()`);
      if (!drawer.open || drawer.width !== queueWidth || drawer.right !== drawer.viewport
        || view.getBounds().width !== window.getContentSize()[0] - queueWidth) {
        throw new Error('Queue drawer and SoundCloud view do not line up.');
      }
      if (process.env.SIMPLECLOUD_PROBE_SCREENSHOT) {
        const image = await shell.capturePage();
        fs.writeFileSync(process.env.SIMPLECLOUD_PROBE_SCREENSHOT, image.toPNG());
      }
      const siteWidth = await site.executeJavaScript(`(() => ({
        inner: innerWidth,
        scroll: document.documentElement.scrollWidth,
        clientHeight: document.documentElement.clientHeight,
        innerHeight
      }))()`);
      if (siteWidth.scroll > siteWidth.inner || siteWidth.clientHeight !== siteWidth.innerHeight) {
        throw new Error('SoundCloud overflows horizontally with the queue open.');
      }
      console.log('[probe] Site width with drawer:', JSON.stringify(siteWidth));
      await shell.executeJavaScript(`document.querySelector('#queue-close').click()`);
      await new Promise(resolve => setTimeout(resolve, 150));
      if (view.getBounds().width !== window.getContentSize()[0]) {
        throw new Error('SoundCloud view did not return to full width.');
      }
      console.log('[probe] Shell view and queue drawer aligned. Submitting a search.');
      let searched = false;
      site.on('did-navigate-in-page', (_event, url, isMainFrame) => {
        if (!isMainFrame) return;
        const target = new URL(url);
        if (!searched && target.pathname === '/search' && target.searchParams.get('q')?.trim() === 'simplecloud') {
          searched = true;
          setTimeout(async () => {
            try {
              await site.sendInputEvent({ type: 'keyDown', keyCode: 'f', modifiers: ['control'] });
              await site.sendInputEvent({ type: 'keyUp', keyCode: 'f', modifiers: ['control'] });
              await new Promise(resolve => setTimeout(resolve, 300));
              const panel = await shell.executeJavaScript(`(() => {
                const input = document.querySelector('.search input');
                const slot = document.querySelector('.site-slot').getBoundingClientRect();
                return {
                  focused: document.activeElement === input,
                  open: !document.getElementById('search-history').hidden,
                  rows: document.querySelectorAll('#search-history-list li').length,
                  first: document.querySelector('#search-history-list li')?.textContent ?? '',
                  top: Math.round(slot.top)
                };
              })()`);
              if (!panel.focused || !panel.open || panel.rows < 1
                || !panel.first.toLowerCase().includes('simplecloud') || panel.top !== view.getBounds().y) {
                throw new Error(`Search history panel is misaligned: ${JSON.stringify({ ...panel, view: view.getBounds() })}`);
              }
              console.log('[probe] Search history panel:', JSON.stringify(panel));
              await shell.executeJavaScript(`document.querySelector('.search input').blur()`);
              await new Promise(resolve => setTimeout(resolve, 250));
              if (view.getBounds().y !== headerHeight) throw new Error('Search panel did not release the site view.');
              await shell.executeJavaScript(`document.querySelector('[data-route="home"]').click()`);
            } catch (error) {
              console.error('[probe]', error.message);
              app.exit(1);
            }
          }, 400);
        } else if (searched && target.pathname === '/discover') {
          setTimeout(async () => {
            try {
              const modules = await site.executeJavaScript(`(() => {
                const main = document.querySelector('[role="main"]');
                return [...(main?.querySelectorAll('[class*="Module"]') ?? [])]
                  .filter(element => !element.parentElement?.closest('[class*="Module"]'))
                  .map(element => ({
                    heading: (element.querySelector('h1, h2, h3')?.textContent ?? '').trim().slice(0, 60),
                    links: element.querySelectorAll('a[href]').length,
                     visible: Boolean(element.getClientRects().length)
                  }));
              })()`);
              console.log('[probe] Discover modules:', JSON.stringify(modules));
            } catch (error) {
              console.warn('[probe] Could not inspect Discover modules:', error.message);
            }
            try {
              const home = await site.executeJavaScript(`(async () => {
                const frame = document.createElement('iframe');
                frame.className = 'webiIframe';
                frame.style.cssText = 'position:fixed;left:-10000px;top:0;display:block;width:400px;height:200px';
                document.body.append(frame);
                try {
                  const doc = frame.contentDocument;
                  doc.body.innerHTML = '<main><a id="likes" href="/you/likes">Your likes</a>'
                    + '<div id="campaign"><div><p>Celebrate the return to the streets</p></div><a href="/charts/top">GTA soundtrack</a></div>'
                    + '<section id="empty-for"><h2>Per te</h2></section>'
                    + '<section id="for"><div>Per te</div>'
                    + '<section id="drops"><h3>Nuove uscite</h3><a href="/discover/sets/new-for-you::fixture">Apri</a></section>'
                    + '<section id="wave"><h3>Il meglio di SoundCloud</h3><a href="/n/discover/sets/weekly%3A%3Afixture">Apri</a></section></section>'
                    + '<section id="more"><h2>Altro di ciò che ti piace</h2></section>'
                    + '<section id="mixed"><h2>Mixato per SimpleCloud</h2></section><section id="trending"><h2>Trending by genre</h2></section></main>';
                  await new Promise(resolve => setTimeout(resolve, 850));
                  return {
                    ...Object.fromEntries(['likes', 'campaign', 'empty-for', 'for', 'drops', 'wave', 'more', 'mixed', 'trending'].map(id => [
                      id, doc.getElementById(id).style.display
                    ])),
                    forYouStatus: document.documentElement.dataset.scForYou
                  };
                } finally { frame.remove(); }
              })()`);
              if (home.likes !== 'none' || home.campaign !== 'none' || home.trending !== 'none' || home['empty-for'] !== 'none'
                || home.for || home.drops || home.wave || home.more || home.mixed || home.forYouStatus !== 'cards') {
                throw new Error(`Home did not keep only the three allowed blocks: ${JSON.stringify(home)}`);
              }
              console.log('[probe] Home keeps the three recommendation sections and removes Likes and the GTA campaign.');
              await checkListeningMode();
            } catch (error) {
              console.error('[probe]', error.message);
              app.exit(1);
              return;
            }
            clearTimeout(probeTimeout);
            console.log('[probe] Shell layout, player IPC, search and listening mode OK.');
            app.exit(0);
          }, 1200);
        }
      });
      await shell.executeJavaScript(`(() => {
        const form = document.querySelector('.search');
        form.querySelector('input').value = 'simplecloud';
        form.requestSubmit();
      })()`);
    } catch (error) {
      console.error('[probe]', error.message);
      app.exit(1);
    }
  }

  Promise.all([shell.loadFile(shellPath), site.loadURL(home)]).catch(error => {
    console.error('[shell] Startup failed:', error.message);
    if (probe) app.exit(1);
    else report('SoundCloud could not load. Check your connection and reopen SimpleCloud.');
  });
}

app.whenReady().then(() => {
  if (!probe) {
    const menu = Menu.getApplicationMenu() ?? new Menu();
    menu.append(new MenuItem({
      label: '&Account',
      submenu: [{
        label: 'Open SoundCloud account settings in browser',
        click: () => {
          desktopShell.openExternal(accountSettings).catch(() => {
            dialog.showErrorBox('Could not open your browser', `Open ${accountSettings} in your browser instead.`);
          });
        }
      }]
    }));
    Menu.setApplicationMenu(menu);
  }
  if (safeMode) openSafeMode();
  else openShell();
});
app.on('window-all-closed', () => app.quit());

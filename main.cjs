const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BaseWindow, BrowserWindow, Menu, MenuItem, WebContentsView, dialog, screen, shell: desktopShell } = require('electron');
const searchHistory = require('./search-history.cjs');
const { createNetworkFilter, sources: filterSources } = require('./network-filter.cjs');
const { createVolumePopup } = require('./volume-popup.cjs');

const home = 'https://soundcloud.com/discover';
const accountSettings = 'https://soundcloud.com/settings';
const probe = process.argv.includes('--probe');
const safeMode = process.argv.includes('--safe-mode');
const showShell = !probe || Boolean(process.env.SIMPLECLOUD_PROBE_SCREENSHOT);
if (probe) {
  const probeData = path.join(os.tmpdir(), 'simplecloud-probe');
  fs.mkdirSync(probeData, { recursive: true });
  app.setPath('userData', probeData);
}
const shellPath = path.join(__dirname, 'shell.html');
const shellUrl = pathToFileURL(shellPath).href;
const listenDockPath = path.join(__dirname, 'listen-dock.html');
const listenDockUrl = pathToFileURL(listenDockPath).href;
const listenMessage = text => `data:text/html;charset=utf-8,${encodeURIComponent(
  `<title>SimpleCloud — Listening</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#202124;color:#bdbfc3;font:14px "Segoe UI",sans-serif}</style><body role="status">${text}</body>`
)}`;
const idleListenUrl = listenMessage('Play a track to see its waveform');
const appIcon = path.join(__dirname, 'assets', 'cloud.ico');
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
const listenDockSize = 36; // A 28 px button with room for its focus outline.
const listenDockInset = 8;
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
    const { x, y, width, height, maximized, pinned, listenPinned, keepListenBar } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (![x, y, width, height].every(Number.isInteger) || width < minWidth || height < minHeight) return {};
    const display = screen.getDisplayMatching({ x, y, width, height }).workArea;
    const w = Math.min(width, Math.max(display.width, minWidth));
    const h = Math.min(height, Math.max(display.height, minHeight));
    return {
      x: Math.max(display.x, Math.min(x, display.x + display.width - w)),
      y: Math.max(display.y, Math.min(y, display.y + display.height - h)),
      width: w, height: h, maximized: maximized === true, pinned: pinned === true,
      listenPinned: (listenPinned ?? pinned) === true, keepListenBar: keepListenBar === true
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
  const { maximized, pinned: savedPin, listenPinned, keepListenBar: savedBar, ...bounds } = probe ? {} : readGeometry(geometryFile);
  const window = new BrowserWindow({
    title: 'SimpleCloud', icon: appIcon, width: 1200, height: 850, ...bounds,
    minWidth, minHeight, frame: false, roundedCorners: true,
    ...(process.platform === 'win32' && { accentColor: false }),
    autoHideMenuBar: true, show: false, backgroundColor: shellBackground
  });
  // A separate window and passive waveform preview; playback stays in the main window.
  const listeningWindow = new BaseWindow({
    title: 'SimpleCloud — Listening', icon: appIcon, width: listenWidth, height: listenHeight,
    minWidth: minListenWidth, minHeight: minListenHeight, frame: false, roundedCorners: true,
    ...(process.platform === 'win32' && { accentColor: false }),
    maximizable: false, autoHideMenuBar: true, show: false, backgroundColor: shellBackground
  });
  const createShellView = () => {
    const shellView = new WebContentsView({
      webPreferences: { ...webPreferences, preload: path.join(__dirname, 'shell-preload.cjs') }
    });
    shellView.setBackgroundColor(shellBackground);
    restrictNavigation(shellView.webContents, value => value === shellUrl);
    shellView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return shellView;
  };
  // Keep each shell attached to its own native host. Moving a shell between
  // Windows hosts can leave its compositor surface blank while clicks still work.
  const shellView = createShellView();
  const shell = shellView.webContents;
  window.contentView.addChildView(shellView);
  const listenShellView = createShellView();
  const listenShell = listenShellView.webContents;
  listenShellView.setVisible(false);
  listeningWindow.contentView.addChildView(listenShellView);

  const listenDockView = new WebContentsView({
    webPreferences: { ...webPreferences, preload: path.join(__dirname, 'shell-preload.cjs') }
  });
  const listenDock = listenDockView.webContents;
  listenDockView.setBackgroundColor('#00000000');
  listenDockView.setVisible(false);
  listeningWindow.contentView.addChildView(listenDockView);
  restrictNavigation(listenDock, value => value === listenDockUrl);
  listenDock.setWindowOpenHandler(() => ({ action: 'deny' }));

  const sitePreferences = {
    ...webPreferences, preload: path.join(__dirname, 'player-bridge.cjs'),
    partition: probe ? 'simplecloud-probe' : 'persist:soundcloud'
  };
  const view = new WebContentsView({ webPreferences: sitePreferences });
  const site = view.webContents;
  const listenView = new WebContentsView({
    webPreferences: { ...sitePreferences, additionalArguments: ['--simplecloud-listen-preview'] }
  });
  const listenSite = listenView.webContents;
  listenSite.setAudioMuted(true);
  listenView.setBackgroundColor(shellBackground);
  listenView.setVisible(false);
  listeningWindow.contentView.addChildView(listenView, 0);
  const filters = probe ? null : createNetworkFilter(site.session, app.getPath('userData'));
  let listeningCorners;
  if (process.platform === 'win32') {
    try {
      listeningCorners = require('./windows-corners.cjs').createListeningCorners(listeningWindow, screen);
    } catch (error) {
      console.warn('[shell] Could not initialize Windows corners:', error.message);
    }
  }
  view.setBackgroundColor(shellBackground);
  window.contentView.addChildView(view);
  let queueOpen = false;
  let listenQueueOpen = false;
  let siteTop = headerHeight;
  let listeningOpen = false;
  let listeningPositioned = false;
  let quitting = false;
  const readyShells = new Set();
  const sendToShell = (contents, channel, ...args) => {
    if (readyShells.has(contents) && !contents.isDestroyed()) contents.send(channel, ...args);
  };
  const createPlayerVolume = contents => createVolumePopup(webPreferences, screen, {
    setVolume: value => {
      if (isPlayerPage(site.getURL())) site.send('simplecloud:site-action', 'volume', value);
    },
    onClose: focus => {
      if (focus && !contents.isDestroyed()) contents.focus();
      sendToShell(contents, 'simplecloud:volume-closed', focus);
      if (contents === listenShell && !listeningWindow.isDestroyed()) showListenBar();
    }
  });
  let dragOrigin;
  let settingsMenu;
  let listenHover = false;
  let listenDockHover = false;
  let hoverChangedAt;
  let listenFocus;
  let keepListenBar = savedBar === true;
  let hoverTimer;
  let cornersApplied = false;
  const volumePopup = createPlayerVolume(shell);
  const listenVolumePopup = createPlayerVolume(listenShell);
  const showListenBar = () => {
    const visible = listeningOpen
      && (keepListenBar || listenQueueOpen || listenHover || listenFocus === 'player' || listenVolumePopup.visible());
    if (!visible && listenShell.isFocused() && listeningWindow.isFocused()) listenSite.focus();
    listenShellView.setVisible(visible);
  };
  const showListenDock = () => {
    const visible = listeningOpen && (listenDockHover || listenFocus === 'dock');
    if (!visible && listenDock.isFocused() && listeningWindow.isFocused()) listenSite.focus();
    listenDockView.setVisible(visible);
  };
  const updateListenHover = (point, now = performance.now()) => {
    const { x, y, width, height } = listeningWindow.getContentBounds();
    const bottom = y + height - (listenQueueOpen ? queueHeight : 0);
    const insideHero = !dragOrigin && point.x >= x && point.x < x + width
      && point.y >= y && point.y < bottom;
    if (insideHero !== listenDockHover) {
      listenDockHover = insideHero;
      showListenDock();
    }
    const depth = listenHover ? listenBarHeight + 6 : listenHoverEdge;
    const next = insideHero && point.y >= bottom - depth;
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
  listeningWindow.on('blur', () => {
    if (!listeningOpen) return;
    listenVolumePopup.hide();
    dragOrigin = undefined;
    listenFocus = undefined;
    listenHover = listenDockHover = false;
    hoverChangedAt = undefined;
    showListenBar();
    showListenDock();
  });
  const layoutBrowser = () => {
    volumePopup.hide();
    const [width, height] = window.getContentSize();
    shellView.setBounds({ x: 0, y: 0, width, height });
    const viewWidth = Math.max(0, width - (queueOpen ? queueWidth : 0));
    view.setBounds({ x: 0, y: siteTop, width: viewWidth, height: Math.max(0, height - siteTop - playerHeight) });
  };
  const layoutListening = () => {
    listenVolumePopup.hide();
    const [width, height] = listeningWindow.getContentSize();
    const heroHeight = height - (listenQueueOpen ? queueHeight : 0);
    listenView.setBounds({ x: 0, y: 0, width, height: heroHeight });
    listenShellView.setBounds({ x: 0, y: heroHeight - listenBarHeight, width, height: height - heroHeight + listenBarHeight });
    listenDockView.setBounds({
      x: width - listenDockInset - listenDockSize, y: listenDockInset,
      width: listenDockSize, height: listenDockSize
    });
    cornersApplied = listeningCorners?.apply() ?? false;
  };
  layoutBrowser();
  window.on('resize', layoutBrowser);
  window.on('blur', () => volumePopup.hide());
  listeningWindow.on('resize', () => { if (listeningOpen) layoutListening(); });
  listeningWindow.on('move', () => {
    if (listeningOpen) cornersApplied = listeningCorners?.apply() ?? false;
  });
  if (savedPin) window.setAlwaysOnTop(true);
  if (listenPinned) listeningWindow.setAlwaysOnTop(true);
  if (showShell) {
    shell.once('did-finish-load', () => {
      if (maximized) window.maximize();
      window.show();
      shell.focus();
    });
  }
  if (!probe) {
    window.on('close', () => {
      try {
        fs.writeFileSync(geometryFile, JSON.stringify({
          ...window.getNormalBounds(), maximized: window.isMaximized(), pinned: window.isAlwaysOnTop(),
          listenPinned: !listeningWindow.isDestroyed() && listeningWindow.isAlwaysOnTop(), keepListenBar
        }));
      } catch (error) {
        console.warn('[shell] Could not save window position:', error.message);
      }
    });
  }
  const markQuitting = () => { quitting = true; };
  app.on('before-quit', markQuitting);
  listeningWindow.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    leaveListen();
  });
  window.on('closed', () => {
    app.off('before-quit', markQuitting);
    clearInterval(hoverTimer);
    volumePopup.destroy();
    listenVolumePopup.destroy();
    if (!listeningWindow.isDestroyed()) listeningWindow.destroy();
    if (!shell.isDestroyed()) shell.close();
    if (!listenShell.isDestroyed()) listenShell.close();
    if (!site.isDestroyed()) site.close();
    if (!listenSite.isDestroyed()) listenSite.close();
    if (!listenDock.isDestroyed()) listenDock.close();
  });

  // Site and shell are separate renderers. The site cannot invoke shell actions.
  restrictSite(site);
  restrictNavigation(listenSite, isPlayerPage);
  listenSite.on('will-navigate', event => event.preventDefault());
  listenSite.setWindowOpenHandler(() => ({ action: 'deny' }));
  const applyCommentPreference = () => {
    for (const contents of [site, listenSite]) {
      if (!contents.isDestroyed() && isPlayerPage(contents.getURL())) {
        contents.send('simplecloud:site-action', 'hideComments', hideComments);
      }
    }
  };
  const focusSearch = (event, input) => {
    if (input.type !== 'keyDown' || input.key?.toLowerCase() !== 'f') return;
    if (!input.control || input.alt || input.shift || input.meta) return;
    event.preventDefault();
    if (window.isMinimized()) window.restore();
    if (showShell) window.focus();
    shell.focus();
    shell.send('simplecloud:focus-search');
  };
  const toggleListen = (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || input.key?.toLowerCase() !== 'l') return;
    if (!input.control || !input.shift || input.alt || input.meta) return;
    event.preventDefault();
    if (listeningOpen) leaveListen();
    else enterListen();
  };
  const focusListenControls = (event, input) => {
    if (!listeningOpen || input.type !== 'keyDown' || input.isAutoRepeat || input.control || input.alt || input.meta) return;
    if (input.key !== 'F6' && !(input.key === 'Escape' && !input.shift && listenFocus)) return;
    event.preventDefault();
    const target = input.shift ? 'dock' : 'player';
    listenFocus = input.key === 'F6' && target !== listenFocus ? target : undefined;
    showListenBar();
    showListenDock();
    if (listenFocus === 'player') {
      listenShell.focus();
      sendToShell(listenShell, 'simplecloud:focus-player');
    } else if (listenFocus === 'dock') {
      listenDock.focus();
      listenDock.send('simplecloud:focus-listen-dock');
    } else {
      listenSite.focus();
    }
  };
  for (const contents of [shell, listenShell, site, listenSite, listenDock]) {
    contents.on('before-input-event', focusSearch);
    contents.on('before-input-event', toggleListen);
  }
  for (const contents of [listenShell, listenSite, listenDock]) {
    contents.on('before-input-event', focusListenControls);
  }
  site.on('focus', () => {
    sendToShell(shell, 'simplecloud:blur-search');
  });
  site.on('dom-ready', async () => {
    if (isPlayerPage(site.getURL())) {
      try { await site.insertCSS(siteChrome); }
      catch (error) { console.warn('[shell] Could not apply site chrome:', error.message); }
      if (site.isDestroyed()) return;
      applyCommentPreference();
    }
  });

  let state, serialized, route, scriptNavigation, previewUrl, previewReady = false;
  let listenTransition = 0;
  const broadcastListenPosition = () => {
    if (!previewReady || state?.status !== 'track') return;
    listenSite.send('simplecloud:site-action', 'listenPreviewPosition', {
      trackId: state.trackId, position: state.position, duration: state.duration,
      progress: state.progress, isPlaying: state.isPlaying
    });
  };
  const syncListenSkin = () => {
    if (!listeningOpen || !previewReady) return;
    listenSite.send('simplecloud:site-action', 'listenMode', {
      enabled: true, trackId: state?.trackId, title: state?.title, transition: ++listenTransition
    });
    broadcastListenPosition();
  };
  listenSite.on('dom-ready', async () => {
    const url = listenSite.getURL();
    if (!listeningOpen || !isPlayerPage(url)) return;
    const transition = listenTransition;
    try { await listenSite.insertCSS(siteChrome); }
    catch (error) { console.warn('[shell] Could not apply waveform preview chrome:', error.message); return; }
    if (!listeningOpen || transition !== listenTransition || url !== listenSite.getURL()) return;
    previewReady = true;
    applyCommentPreference();
    syncListenSkin();
  });
  const sendShellState = contents => {
    const listening = contents === listenShell;
    sendToShell(contents, 'simplecloud:shell-state', {
      state, route, pinned: (listening ? listeningWindow : window).isAlwaysOnTop(),
      mode: listening ? 'listen' : 'browser', keepListenBar, queueOpen: listening ? listenQueueOpen : queueOpen
    });
  };
  const broadcast = () => {
    sendShellState(shell);
    if (listeningOpen) sendShellState(listenShell);
    volumePopup.setLevel(state?.volume);
    listenVolumePopup.setLevel(state?.volume);
  };
  const report = (message, contents = shell) => {
    if (probe) console.error('[probe]', message);
    sendToShell(contents, 'simplecloud:shell-error', message);
  };
  const setHistory = value => {
    history = value;
    searchHistory.save(historyFile, history);
    sendToShell(shell, 'simplecloud:search-history', history);
  };
  const followPlayback = () => {
    if (!listeningOpen) return;
    const target = state?.status === 'track' && isPlayerPage(state.trackUrl) ? state.trackUrl : idleListenUrl;
    if (previewUrl === target) return;
    previewUrl = target;
    previewReady = false;
    const transition = ++listenTransition;
    listenView.setVisible(false);
    listenSite.loadURL(target).then(() => {
      if (listeningOpen && transition === listenTransition && target === idleListenUrl) listenView.setVisible(true);
    }).catch(() => {
      // A superseded load is normal when browsing quickly. Only a real failure
      // on the current transition may replace the preview with a message.
      if (!listeningOpen || transition !== listenTransition || listenSite.isDestroyed()) return;
      void listenSite.loadURL(listenMessage('Waveform unavailable for this track')).then(() => {
        if (listeningOpen && transition === listenTransition && !listenSite.isDestroyed()) listenView.setVisible(true);
      }).catch(() => {});
    });
  };
  const enterListen = () => {
    if (listeningOpen) {
      if (listeningWindow.isMinimized()) listeningWindow.restore();
      if (showShell) listeningWindow.focus();
      return;
    }
    if (!state || !isPlayerPage(site.getURL())) { report('Wait for SoundCloud to finish loading.'); return; }
    const browserBounds = window.getBounds();
    const position = listeningPositioned ? listeningWindow.getBounds() : browserBounds;
    const area = screen.getDisplayMatching(position).workArea;
    const [usualWidth, usualHeight] = listeningWindow.getContentSize();
    const extraHeight = listenQueueOpen ? queueHeight : 0;
    const width = Math.min(listeningPositioned ? usualWidth : listenWidth, area.width);
    const height = Math.min((listeningPositioned ? usualHeight : listenHeight) + extraHeight, area.height);
    const x = listeningPositioned ? position.x : position.x + Math.max(0, position.width - width);
    const y = listeningPositioned ? position.y : position.y + Math.max(0, position.height - height);
    listeningWindow.setMinimumSize(minListenWidth, minListenHeight + extraHeight);
    listeningWindow.setContentSize(width, height);
    const bounds = listeningWindow.getBounds();
    listeningWindow.setPosition(
      Math.max(area.x, Math.min(x, area.x + area.width - bounds.width)),
      Math.max(area.y, Math.min(y, area.y + area.height - bounds.height))
    );
    listeningPositioned = true;
    listeningOpen = true;
    // The companion still needs the main player's clock when its window is minimized.
    site.setBackgroundThrottling(false);
    listenHover = listenDockHover = false;
    listenFocus = undefined;
    hoverChangedAt = undefined;
    broadcast();
    layoutListening();
    if (showShell) listeningWindow.show();
    showListenBar();
    if (!probe) {
      hoverTimer = setInterval(() => {
        if (!listeningWindow.isMinimized()) {
          updateListenHover(screen.getCursorScreenPoint());
        }
      }, 40);
    }
    followPlayback();
  };
  const leaveListen = () => {
    if (!listeningOpen) return;
    dragOrigin = undefined;
    clearInterval(hoverTimer);
    listeningOpen = false;
    site.setBackgroundThrottling(true);
    listenVolumePopup.hide();
    previewUrl = undefined;
    previewReady = false;
    ++listenTransition;
    listenView.setVisible(false);
    showListenBar();
    showListenDock();
    listeningWindow.hide();
    void listenSite.loadURL('about:blank').catch(() => {});
    if (listenQueueOpen) {
      const [width, height] = listeningWindow.getContentSize();
      listeningWindow.setMinimumSize(minListenWidth, minListenHeight);
      listeningWindow.setContentSize(width, height - queueHeight);
    }
  };
  const from = (event, allow) => event.senderFrame && !event.senderFrame.parent && allow(event.senderFrame.url);
  listenDock.ipc.on('simplecloud:shell-action', (event, name) => {
    if (name === 'close' && listeningOpen && listenDockView.getVisible() && from(event, url => url === listenDockUrl)) {
      listeningWindow.close();
    }
  });
  listenSite.ipc.on('simplecloud:listen-skin', (event, transition) => {
    if (listeningOpen && from(event, isPlayerPage) && transition === listenTransition) {
      listenView.setVisible(true);
      if (listeningWindow.isFocused() && !listenFocus) listenSite.focus();
    }
  });
  listenSite.ipc.on('simplecloud:listen-preview-action', (event, name, trackId, ratio) => {
    if (!listeningOpen || !previewReady || !listenView.getVisible() || !from(event, isPlayerPage)
      || state?.status !== 'track' || trackId !== state.trackId || !isPlayerPage(site.getURL())) return;
    if (name === 'play' && state.controls?.play) site.send('simplecloud:site-action', 'play');
    if (name === 'seek' && state.controls?.seek && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) {
      site.send('simplecloud:site-action', 'seek', { trackId, ratio });
    }
  });
  listenSite.ipc.on('simplecloud:listen-drag', (event, phase) => {
    if (!listeningOpen || !listeningWindow.isFocused() || !from(event, isPlayerPage)) return;
    if (phase === 'end') {
      dragOrigin = undefined;
    } else if (phase === 'start') {
      const { x, y } = screen.getCursorScreenPoint();
      const bounds = listeningWindow.getBounds();
      if (x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height) return;
      dragOrigin = { x: x - bounds.x, y: y - bounds.y };
    } else if (phase === 'move' && dragOrigin) {
      const { x, y } = screen.getCursorScreenPoint();
      listeningWindow.setPosition(x - dragOrigin.x, y - dragOrigin.y);
    }
  });
  const onShellReady = event => {
    if (!from(event, value => value === shellUrl)) return;
    const contents = event.sender;
    readyShells.add(contents);
    if (contents === shell) sendToShell(shell, 'simplecloud:search-history', history);
    sendShellState(contents);
    checkProbe();
  };
  const onShellAction = (event, name, value) => {
    const contents = event.sender;
    const listening = contents === listenShell;
    if ((listening && !listeningOpen) || !from(event, url => url === shellUrl)) return;
    const host = listening ? listeningWindow : window;
    const chrome = listening ? listenShellView : shellView;
    const popup = listening ? listenVolumePopup : volumePopup;
    if (name === 'volumePopup') {
      if (Number.isFinite(state?.volume) && chrome.getVisible()
        && popup.show(host, chrome.getBounds(), value)) {
        sendToShell(contents, 'simplecloud:volume-opened');
      }
      return;
    }
    if (name === 'volumeDismiss') { popup.hide(); return; }
    if (!listening) {
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
      host.setAlwaysOnTop(!host.isAlwaysOnTop());
      broadcast();
      return;
    }
    if (name === 'keepBar' && listening) {
      keepListenBar = !keepListenBar;
      showListenBar();
      broadcast();
      return;
    }
    if (name === 'queuePanel') {
      const current = listening ? listenQueueOpen : queueOpen;
      const open = typeof value === 'boolean' ? value : !current;
      if (open === current) return;
      if (listening) {
        const [width, height] = listeningWindow.getContentSize();
        listenQueueOpen = open;
        listeningWindow.setMinimumSize(minListenWidth, minListenHeight + (open ? queueHeight : 0));
        listeningWindow.setContentSize(width, height + (open ? queueHeight : -queueHeight));
        layoutListening();
        showListenBar();
      } else {
        queueOpen = open;
        layoutBrowser();
      }
      broadcast();
      return;
    }
    if (name === 'mode' && !listening) { enterListen(); return; }
    if (name === 'searchPanel') {
      if (listening) return;
      siteTop = Number.isFinite(value)
        ? Math.min(Math.max(headerHeight, Math.round(value)), headerHeight + 420)
        : headerHeight;
      layoutBrowser();
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
    if (name === 'focusSite') { (listening ? listenSite : site).focus(); return; }
    if (!isPlayerPage(site.getURL())) { report('Wait for SoundCloud to finish loading.', contents); return; }
    if (name === 'navigate' && (!routeNames.has(value) || value === 'search')) return;
    if (name === 'search' && (typeof value !== 'string' || !value.trim() || value.length > 200)) return;
    if (name === 'openUrl' && (typeof value !== 'string' || !permittedPage(value)
      || !/^\/[^/]+\/[^/]+$/.test(new URL(value).pathname))) return;
    if (name === 'seek' && (typeof value?.trackId !== 'string' || value.trackId !== state?.trackId
      || !Number.isFinite(value.ratio) || value.ratio < 0 || value.ratio > 1)) return;
    if ((name === 'queueJump' || name === 'queueRemove') && typeof value?.trackId !== 'string') return;
    if (!transport.has(name) && !['seek', 'mute', 'navigate', 'search', 'openUrl', 'queueJump', 'queueRemove', 'queueClear', 'recover'].includes(name)) return;
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
  };
  for (const contents of [shell, listenShell]) {
    contents.ipc.on('simplecloud:shell-ready', onShellReady);
    contents.ipc.on('simplecloud:shell-action', onShellAction);
  }
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
    followPlayback();
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
    if (!from(event, isPlayerPage) || typeof value !== 'string' || value.length > 200) return;
    report(value);
    if (listeningOpen) sendToShell(listenShell, 'simplecloud:shell-error', value);
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
    broadcastListenPosition();
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
                `Listening window: ${listeningOpen ? 'Open' : 'Closed'}`,
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
    const browserBounds = window.getBounds();
    const browserUrl = site.getURL();
    const initialDocument = await site.executeJavaScript('performance.timeOrigin');
    const preservedScroll = await site.executeJavaScript(`(() => {
      const spacer = document.createElement('div');
      spacer.id = 'simplecloud-scroll-fixture';
      spacer.style.height = '2000px';
      document.body.append(spacer);
      window.scrollTo({ top: 160, behavior: 'instant' });
      return scrollY;
    })()`);
    if (preservedScroll !== 160) throw new Error('The browser scroll fixture is not scrollable.');
    await shell.executeJavaScript(`document.getElementById('mode').click()`);
    const idleDeadline = Date.now() + 1500;
    while (!listenView.getVisible() && Date.now() < idleDeadline) {
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    if (!listeningOpen || !listenView.getVisible() || listenSite.getURL() !== idleListenUrl) {
      throw new Error('Opening Listening did not display the idle waveform view.');
    }
    previewUrl = home;
    ++listenTransition;
    listenView.setVisible(false);
    await listenSite.loadURL(home);
    await listenSite.executeJavaScript(`(() => {
      const unrelated = document.createElement('iframe');
      unrelated.id = 'simplecloud-home-slider-fixture';
      unrelated.className = 'webiIframe';
      unrelated.src = '/n/embeds/home-sdui';
      unrelated.srcdoc = '<main><section><div class="MuiSlider-root">Not a waveform</div></section></main>';
      document.body.append(unrelated);
      const frame = document.createElement('iframe');
      frame.id = 'simplecloud-listening-fixture';
      frame.className = 'webiIframe';
      frame.src = '/n/embeds/track-hero?layout=compact';
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px;height:260px';
      frame.srcdoc = '<main><section id="hero"><div><div style="display:flex">'
        + '<div id="column" style="display:flex;flex:1;flex-direction:column;justify-content:space-between;height:240px">'
           + '<div id="hero-title"><h2>Track</h2></div><div id="wave" style="height:100px"><div class="MuiSlider-root" style="height:100%">'
           + '<svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M5 20v60m15-70v80m15-60v40m15-50v60m15-70v80m15-60v40m15-50v60" stroke="white" stroke-width="3"/></svg>'
           + '</div></div>'
         + '<div id="hero-actions"><button>Write a comment</button></div></div><div id="hero-artwork">Artwork</div>'
        + '</div></div></section><section id="discussion">Comments</section></main>';
      return new Promise(resolve => {
        frame.addEventListener('load', () => resolve(), { once: true });
        document.body.prepend(frame);
      });
    })()`);
    const checkHeroActions = async hidden => {
      const result = await listenSite.executeJavaScript(`(() => {
        const doc = document.getElementById('simplecloud-listening-fixture').contentDocument;
        const style = id => doc.defaultView.getComputedStyle(doc.getElementById(id));
        const rect = id => doc.getElementById(id).getBoundingClientRect();
        const hero = rect('hero');
        const title = rect('hero-title');
        const wave = rect('wave');
        const midpoint = (hero.top + hero.bottom) / 2;
        return {
          hidden: style('hero-actions').display === 'none',
          grouped: style('column').display === 'grid',
          titleTop: title.top,
          artworkTop: rect('hero-artwork').top,
          groupLift: midpoint - (title.top + wave.bottom) / 2,
          waveBelowCenter: (wave.top + wave.bottom) / 2 > midpoint,
          offset: doc.getElementById('column').style.getPropertyValue('--sc-listen-content-offset'),
          discussion: style('discussion').display !== 'none'
        };
      })()`);
      if (result.hidden !== hidden || result.grouped !== hidden || !result.discussion
        || (hidden ? Math.abs(result.groupLift - 8) > 1 || !result.waveBelowCenter : result.offset !== '')) {
        throw new Error(`Listening-only track layout did not toggle correctly: ${JSON.stringify(result)}`);
      }
      return result;
    };
    hideComments = true;
    applyCommentPreference();
    await checkHeroActions(false);
    const started = await listenShell.executeJavaScript(`(() => ({
      listen: document.body.classList.contains('listen'),
      header: getComputedStyle(document.querySelector('.header')).display,
      scrolls: document.documentElement.scrollHeight > innerHeight || document.body.scrollHeight > innerHeight,
      strip: Math.round(document.querySelector('.player').getBoundingClientRect().height)
    }))()`);
    const base = listeningWindow.getContentSize();
    const listenBounds = listenView.getBounds();
    if (!started.listen || started.header !== 'none' || started.scrolls || listenShellView.getVisible()
      || listenDockView.getVisible() || started.strip !== listenBarHeight
      || listenBounds.y !== 0 || listenBounds.height !== base[1]) {
      throw new Error(`Listening layout is wrong: ${JSON.stringify({ started, listenBounds, base })}`);
    }
    if (!listeningWindow.contentView.children.includes(listenView) || !listeningWindow.contentView.children.includes(listenShellView)
      || !window.contentView.children.includes(view) || !window.contentView.children.includes(shellView)
      || JSON.stringify(window.getBounds()) !== JSON.stringify(browserBounds)) {
      throw new Error('Listening did not keep both the main page and preview attached to their own windows.');
    }
    if (showShell && (!listeningWindow.isVisible() || !window.isVisible())) {
      throw new Error('The Listening window did not open alongside the main window.');
    }
    const cornerButton = await listenDock.executeJavaScript(`(() => {
      const buttons = document.querySelectorAll('button');
      return buttons.length === 1 && buttons[0].getAttribute('aria-label') === 'Close listening window';
    })()`);
    if (!cornerButton) throw new Error('Close listening window must be the only corner button.');
    if (showShell) {
      // Chromium defers viewport changes on the hidden native host used by the default probe.
      listenFocus = 'player';
      showListenBar();
      listeningWindow.setContentSize(minListenWidth, base[1]);
      const resizeDeadline = Date.now() + 1000;
      while (await listenShell.executeJavaScript('innerWidth') !== minListenWidth && Date.now() < resizeDeadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const size = await listenShell.executeJavaScript(`({
        width: document.querySelector('.player').getBoundingClientRect().width,
        controlEdge: document.querySelector('.track-actions').getBoundingClientRect().right,
        speakerVisible: getComputedStyle(document.getElementById('mute')).display !== 'none'
      })`);
      listeningWindow.setContentSize(...base);
      listenFocus = undefined;
      showListenBar();
      if (size.width !== minListenWidth || size.controlEdge > size.width || !size.speakerVisible) {
        throw new Error(`The listening player does not fit its minimum width: ${JSON.stringify(size)}`);
      }
    }
    if (process.platform === 'win32' && !cornersApplied) throw new Error('The Windows listening corner mask was not applied.');
    if (!await listenSite.executeJavaScript(`document.documentElement.classList.contains('sc-listen')`)
      || await site.executeJavaScript(`document.documentElement.classList.contains('sc-listen')`)) {
      throw new Error('Listening chrome did not stay confined to the waveform preview.');
    }
    const siteBar = await site.executeJavaScript(`(() => {
      const bar = document.querySelector('.playControls');
      return bar ? getComputedStyle(bar).opacity : 'missing';
    })()`);
    if (siteBar !== '0' && siteBar !== 'missing') {
      throw new Error(`SoundCloud's own player bar still paints (${siteBar}).`);
    }
    const placeholderOnly = await listenSite.executeJavaScript(`(() => {
      const home = document.getElementById('simplecloud-home-slider-fixture');
      const status = document.querySelector('.sc-listen-placeholder');
      return !document.querySelector('.sc-listen-frame') && getComputedStyle(home).visibility === 'hidden'
        && status && getComputedStyle(status).visibility === 'visible';
    })()`);
    if (!placeholderOnly) throw new Error('Listening mode exposed Home or fitted a non-track iframe.');
    const previousState = state;
    await listenSite.executeJavaScript(`history.replaceState(history.state, '', '/n/simplecloud-probe/listening/')`);
    state = { ...state, status: 'track', trackId: '/simplecloud-probe/listening', title: 'Track', position: 35, duration: 100, progress: .356 };
    syncListenSkin();
    const heroDeadline = Date.now() + 1500;
    while (!await listenSite.executeJavaScript(`Boolean(document.querySelector('#simplecloud-listening-fixture.sc-listen-frame'))`)
      && Date.now() < heroDeadline) {
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const heroFrame = await listenSite.executeJavaScript(`(() => {
      const frame = document.getElementById('simplecloud-listening-fixture');
      const doc = frame.contentDocument;
      const played = doc.querySelector('.sc-listen-preview-played');
      return {
        fitted: frame.classList.contains('sc-listen-frame'),
        style: Boolean(doc.getElementById('sc-listen-frame')),
        played: Boolean(played?.querySelector('svg')) && played.style.clipPath === 'inset(0px 64.4% 0px 0px)',
        homeHidden: getComputedStyle(document.getElementById('simplecloud-home-slider-fixture')).visibility === 'hidden'
      };
    })()`);
    if (!heroFrame.fitted || !heroFrame.style || !heroFrame.played || !heroFrame.homeHidden) {
      throw new Error(`The crossfade hero frame was not fitted: ${JSON.stringify(heroFrame)}`);
    }
    await checkHeroActions(true);
    hideComments = false;
    applyCommentPreference();
    const commentsOn = await checkHeroActions(false);
    hideComments = true;
    applyCommentPreference();
    const commentsOff = await checkHeroActions(true);
    if (commentsOff.titleTop <= commentsOn.titleTop || commentsOff.artworkTop !== commentsOn.artworkTop) {
      throw new Error('Hiding waveform comments did not move the track content down independently of the artwork.');
    }
    const content = listeningWindow.getContentBounds();
    const edge = { x: content.x + 40, y: content.y + content.height - 2 };
    const hero = { x: content.x + 40, y: content.y + 40 };
    const outside = { x: content.x - 1, y: hero.y };
    updateListenHover(edge, 0);
    updateListenHover(edge, listenRevealDelay - 1);
    if (listenShellView.getVisible()) throw new Error('The bar appeared before the reveal delay.');
    updateListenHover(edge, listenRevealDelay);
    updateListenHover({ x: edge.x, y: content.y + content.height - listenBarHeight + 2 }, listenRevealDelay + 20);
    if (!listenShellView.getVisible() || listenShellView.getBounds().y !== base[1] - listenBarHeight
       || listenView.getBounds().height !== base[1]) {
      throw new Error('Hover did not overlay the listening bar without resizing the hero.');
    }
    const leftAt = listenRevealDelay + 40;
    updateListenHover(hero, leftAt);
    updateListenHover(hero, leftAt + listenHideDelay - 1);
    if (!listenShellView.getVisible()) throw new Error('The bar did not linger on pointer exit.');
    updateListenHover(hero, leftAt + listenHideDelay);
    if (listenShellView.getVisible() || listenView.getBounds().height !== base[1]) {
      throw new Error('Leaving the bar did not reveal the entire hero.');
    }
    const dockBounds = listenDockView.getBounds();
    if (!listenDockView.getVisible() || dockBounds.x + dockBounds.width !== base[0] - listenDockInset
       || dockBounds.y !== listenDockInset) throw new Error('Hover did not reveal the close button in the top-right corner.');
    updateListenHover(outside);
    if (listenDockView.getVisible()) throw new Error('The close button did not hide on pointer exit.');
    await listenSite.sendInputEvent({ type: 'keyDown', keyCode: 'F6' });
    if (!listenShellView.getVisible()) throw new Error('F6 did not reveal the listening bar.');
    await checkVolumePopup(false, true);
    const clickPin = action => listenShell.executeJavaScript(`document.querySelector('.player [data-action="${action}"]').click()`);
    await clickPin('pin');
    if (!listeningWindow.isAlwaysOnTop() || window.isAlwaysOnTop()) throw new Error('The Listening pin did not keep only its own window on top.');
    await clickPin('pin');
    if (listeningWindow.isAlwaysOnTop() || window.isAlwaysOnTop()) throw new Error('Unpinning did not restore normal window stacking.');
    await clickPin('keepBar');
    await listenShell.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    const pressed = await listenShell.executeJavaScript(`document.querySelector('[data-action="keepBar"]').getAttribute('aria-pressed')`);
    if (!listenShellView.getVisible() || listenDockView.getVisible() || pressed !== 'true') {
      throw new Error('Keeping the bar visible did not survive keyboard dismissal.');
    }
    await clickPin('keepBar');
    if (listenShellView.getVisible()) throw new Error('Releasing the bar did not restore hover-only behavior.');
    await listenSite.sendInputEvent({ type: 'keyDown', keyCode: 'F6', modifiers: ['shift'] });
    const focusDeadline = Date.now() + 1000;
    let dockFocused;
    do {
      dockFocused = await listenDock.executeJavaScript(`document.activeElement.id === 'dock'`);
      if (!dockFocused) await new Promise(resolve => setTimeout(resolve, 30));
    } while (!dockFocused && Date.now() < focusDeadline);
    if (!listenDockView.getVisible() || !dockFocused || listenShellView.getVisible()) {
      throw new Error(`Shift+F6 did not focus the listening window’s close button: ${JSON.stringify({
        focused: dockFocused, dock: listenDockView.getVisible(), bar: listenShellView.getVisible()
      })}`);
    }
    await listenDock.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    if (listenDockView.getVisible()) throw new Error('Escape did not hide the close button.');
    state = previousState;
    await listenSite.executeJavaScript(`history.replaceState(history.state, '', ${JSON.stringify(browserUrl)})`);
    syncListenSkin();
    if (await listenSite.executeJavaScript(`(() => {
      const frame = document.getElementById('simplecloud-listening-fixture');
      return frame.classList.contains('sc-listen-frame')
        || !!frame.contentDocument.getElementById('sc-listen-frame')
        || !!frame.contentDocument.querySelector('.sc-listen-scroll, .sc-listen-hero');
    })()`)) throw new Error('A stale track iframe kept its listening styles after a route change.');
    await listenShell.executeJavaScript(`document.querySelector('[data-action="queue"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 500));
    const grown = listeningWindow.getContentSize();
    const drawer = await listenShell.executeJavaScript(`(() => {
      const box = document.querySelector('.queue').getBoundingClientRect();
      return { height: Math.round(box.height), bottom: Math.round(innerHeight - box.bottom),
        open: !document.querySelector('.queue').hidden };
    })()`);
    if (!drawer.open || drawer.height !== queueHeight || drawer.bottom !== 0
      || grown[1] !== base[1] + queueHeight
        || listenView.getBounds().height !== grown[1] - queueHeight || queueOpen) {
      throw new Error(`Listening queue is wrong: ${JSON.stringify({ drawer, grown, base, view: listenView.getBounds() })}`);
    }
    updateListenHover(hero);
    await listenDock.executeJavaScript(`document.getElementById('dock').click()`);
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
       || size[0] !== before[0] || size[1] !== before[1] || !window.contentView.children.includes(view)
       || listeningWindow.contentView.children.includes(view) || !listeningWindow.contentView.children.includes(listenDockView)
       || listeningWindow.getContentSize()[1] !== base[1]) {
      throw new Error(`Browser layout was not restored: ${JSON.stringify({ restored, size, before })}`);
    }
    if (await site.executeJavaScript(`document.documentElement.classList.contains('sc-listen')`)) {
      throw new Error('SoundCloud kept the listening chrome after leaving.');
    }
    if (showShell && (!window.isVisible() || listeningWindow.isVisible())) {
      throw new Error('Docking did not show just the browser window.');
    }
    const browserQueueOpen = await shell.executeJavaScript(`!document.querySelector('.queue').hidden`);
    if (site.getURL() !== browserUrl || await site.executeJavaScript('scrollY') !== preservedScroll
      || queueOpen || browserQueueOpen || view.getBounds().width !== size[0]) {
      throw new Error('Opening or closing Listening changed the main page, scroll or queue.');
    }
    hideComments = false;
    applyCommentPreference();
    await site.executeJavaScript(`document.getElementById('simplecloud-scroll-fixture').remove()`);
    await site.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control', 'shift'] });
    await site.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: ['control', 'shift'] });
    await new Promise(resolve => setTimeout(resolve, 500));
    if (!listeningOpen || !listeningWindow.contentView.children.includes(listenView)) {
      throw new Error('Ctrl+Shift+L did not enter listening mode.');
    }
    await site.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control', 'shift'] });
    await site.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: ['control', 'shift'] });
    await new Promise(resolve => setTimeout(resolve, 700));
    if (listeningOpen
      || view.getBounds().y !== headerHeight || window.getContentSize()[1] !== before[1]) {
      throw new Error('Ctrl+Shift+L did not restore browser mode.');
    }
    enterListen();
    const waitForRoute = async predicate => {
      const deadline = Date.now() + 4000;
      while (!predicate(new URL(site.getURL())) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!predicate(new URL(site.getURL()))) throw new Error(`In-page route check timed out at ${site.getURL()}`);
    };
    await shell.executeJavaScript(`(() => {
      const form = document.querySelector('.search');
      form.querySelector('input').value = 'simplecloud-companion';
      form.requestSubmit();
    })()`);
    await waitForRoute(url => url.searchParams.get('q') === 'simplecloud-companion');
    if (!listeningOpen || listenSite.getURL() !== idleListenUrl) throw new Error('Browsing changed or closed the Listening window.');
    listeningWindow.close();
    if (listeningOpen || listeningWindow.isDestroyed() || !window.contentView.children.includes(view)) {
      throw new Error('Closing the Listening window did not leave the main player intact.');
    }
    if (new URL(site.getURL()).searchParams.get('q') !== 'simplecloud-companion'
      || await site.executeJavaScript('performance.timeOrigin') !== initialDocument) {
      throw new Error('Closing Listening changed or reloaded the main SoundCloud page.');
    }
    console.log('[probe] Listening mode:', JSON.stringify({ browser: before, listening: base, grown, restored: size }));
  }

  async function checkVolumePopup(testLevels = true, listening = false) {
    const chrome = listening ? listenShellView : shellView;
    const shell = chrome.webContents;
    const popupController = listening ? listenVolumePopup : volumePopup;
    const beforeTrack = await shell.executeJavaScript(`document.getElementById('mute').nextElementSibling.matches('.track')`);
    if (!beforeTrack) throw new Error('The speaker is not immediately before track information.');
    await shell.executeJavaScript(`document.getElementById('mute')
      .dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }))`);
    if (!popupController.visible()) throw new Error('Hovering the speaker did not reveal the volume popup.');
    const open = () => shell.executeJavaScript(`document.getElementById('mute')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))`);
    await open();
    const popup = popupController.view;
    if (!popup || !popupController.visible()) throw new Error('The volume shortcut did not open the popup.');
    const host = listening ? listeningWindow : window;
    const childViews = host.contentView.children;
    const shellBounds = chrome.getBounds();
    const anchor = await shell.executeJavaScript(`document.getElementById('mute').getBoundingClientRect().toJSON()`);
    const bounds = popup.getBounds();
    if (childViews.at(-1) !== popup || bounds.y + bounds.height !== Math.round(shellBounds.y + anchor.y)
      || Math.abs(bounds.x + bounds.width / 2 - (anchor.x + anchor.width / 2)) > 1) {
      throw new Error('The volume popup is not above and centered on the speaker.');
    }
    if (popup.webContents.isLoading()) {
      await new Promise((resolve, reject) => {
        popup.webContents.once('did-finish-load', resolve);
        popup.webContents.once('did-fail-load', reject);
      });
    }
    const slider = await popup.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('volume');
      const rect = input.getBoundingClientRect();
      return { vertical: rect.height > rect.width && getComputedStyle(input).writingMode === 'vertical-lr',
        direction: getComputedStyle(input).direction };
    })()`);
    if (!slider.vertical || slider.direction !== 'rtl') throw new Error('Volume is not vertical with maximum at the top.');
    const close = async () => {
      await popup.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      if (popupController.visible() || host.contentView.children.includes(popup)) throw new Error('Escape did not dismiss the volume popup.');
    };
    if (!testLevels) { await close(); return; }
    const setLevel = value => popup.webContents.executeJavaScript(`(() => {
      const slider = document.getElementById('volume');
      slider.value = ${value};
      slider.dispatchEvent(new Event('input'));
    })()`);
    const waitForVolume = async (expected, action) => {
      const deadline = Date.now() + 2500;
      let value, native;
      do {
        value = await popup.webContents.executeJavaScript(`(() => {
          const slider = document.getElementById('volume');
          return slider.disabled ? null : slider.valueAsNumber;
        })()`);
        if (value !== null && expected === undefined) return value;
        native = await site.executeJavaScript(`(() => {
          const value = document.querySelector('.volume__sliderWrapper')?.getAttribute('aria-valuenow');
          return value ? Number(value) * 100 : null;
        })()`);
        const tolerance = expected === 0 ? 0 : 1;
        if (value !== null && native !== null
          && Math.abs(value - expected) <= tolerance && Math.abs(native - expected) <= tolerance) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      throw new Error(`Volume after ${action}: expected ${expected ?? 'available'}, shell ${value}, SoundCloud ${native}.`);
    };
    const clickMute = () => shell.executeJavaScript(`document.getElementById('mute').click()`);
    const original = await waitForVolume(undefined, 'opening the popup');
    const target = original === 45 ? 70 : 45;
    await setLevel(target);
    await waitForVolume(target, 'setting the level');
    await clickMute();
    await waitForVolume(0, 'muting');
    await clickMute();
    await waitForVolume(target, 'unmuting');
    await setLevel(0);
    await waitForVolume(0, 'moving the slider to zero');
    await setLevel(original);
    await waitForVolume(original, 'restoring the original level');
    await close();
    console.log('[probe] Volume and mute follow the native SoundCloud player.');
  }

  async function checkSeek() {
    const trackId = '/simplecloud-probe/seek';
    await site.executeJavaScript(`(() => {
      const fixture = document.createElement('div');
      fixture.id = 'simplecloud-seek-fixture';
      fixture.className = 'playControls';
      fixture.innerHTML = '<div class="playControls__inner" role="contentinfo">'
        + '<a class="playbackSoundBadge__titleLink" href="${trackId}" title="Seek test"></a>'
        + '<a class="playbackSoundBadge__lightLink">Probe</a>'
        + '<span class="playbackTimeline__duration">2:00</span><span class="playbackTimeline__timePassed">0:00</span>'
        + '<div class="playbackTimeline__progressWrapper" style="width:300px;height:24px">'
        + '<div class="playbackTimeline__progressBar" style="width:0%"></div></div></div>';
      const rail = fixture.querySelector('.playbackTimeline__progressWrapper');
      fixture.addEventListener('mousedown', event => {
        if (event.target !== rail || event.buttons !== 1) return;
        let ratio;
        document.addEventListener('mousemove', event => {
          const box = rail.getBoundingClientRect();
          ratio = (event.clientX - box.left) / box.width;
        }, { once: true });
        document.addEventListener('mouseup', () => { fixture.dataset.ratio = ratio; }, { once: true });
      });
      document.body.prepend(fixture);
    })()`);
    const waitFor = async (condition, message) => {
      const deadline = Date.now() + 3300;
      while (!await condition()) {
        if (Date.now() >= deadline) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    };
    try {
      await waitFor(() => state?.trackId === trackId && shell.executeJavaScript(`!document.getElementById('seek').disabled`),
        'The shell did not enable the seek control for the test track.');
      await shell.executeJavaScript(`(() => {
        const seek = document.getElementById('seek');
        seek.value = 87;
        seek.dispatchEvent(new Event('input'));
        seek.dispatchEvent(new Event('change'));
      })()`);
      await waitFor(() => site.executeJavaScript(`Math.abs(Number(document.getElementById('simplecloud-seek-fixture').dataset.ratio) - .725) < .004`),
        'The shell seek did not reach the full SoundCloud rail.');
    } finally {
      await site.executeJavaScript(`document.getElementById('simplecloud-seek-fixture').remove()`);
    }
    await waitFor(() => state?.trackId !== trackId, 'The seek test track was not cleared.');
    console.log('[probe] Seek moves along the full rail even when its filled segment is at zero.');
  }

  async function checkProbe() {
    if (!probe || probing || !readyShells.has(shell) || !readyShells.has(listenShell) || !state) return;
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
      await checkVolumePopup();
      await checkSeek();
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
      let searched = false, returnedHome = false;
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
        } else if (searched && !returnedHome && target.pathname === '/discover') {
          returnedHome = true;
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

  Promise.all([shell.loadFile(shellPath), listenShell.loadFile(shellPath), site.loadURL(home)]).catch(error => {
    console.error('[shell] Startup failed:', error.message);
    if (probe) app.exit(1);
    else report('SoundCloud could not load. Check your connection and reopen SimpleCloud.');
  });
  listenDock.loadFile(listenDockPath).catch(error => {
    if (!listenDock.isDestroyed()) console.warn('[shell] Could not load the listening window’s close button:', error.message);
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

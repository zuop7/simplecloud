const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { WebContentsView } = require('electron');

const page = path.join(__dirname, 'volume-popup.html');
const url = pathToFileURL(page).href;
const width = 44;
const height = 154;

function createVolumePopup(webPreferences, screen, { setVolume, onClose }) {
  let view, contents, host, anchor, bounds, timer, level, ready, held, keyboard, outsideSince;
  const send = value => {
    if (ready && host) contents.send('simplecloud:volume-state', value);
  };
  const hide = (restoreFocus = false) => {
    if (!host) return;
    const previous = host;
    host = undefined;
    held = keyboard = false;
    clearInterval(timer);
    view.setVisible(false);
    if (!previous.isDestroyed()) previous.contentView.removeChildView(view);
    onClose(restoreFocus);
  };
  const tick = () => {
    if (held || keyboard) return;
    const point = screen.getCursorScreenPoint();
    const origin = host.getContentBounds();
    const x = point.x - origin.x;
    const y = point.y - origin.y;
    const inside = x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < anchor.y + anchor.height;
    if (inside) outsideSince = undefined;
    else {
      outsideSince ??= performance.now();
      if (performance.now() - outsideSince >= 160) hide(contents.isFocused());
    }
  };
  const focusSlider = () => {
    contents.focus();
    contents.send('simplecloud:focus-volume');
  };
  const createView = () => {
    view = new WebContentsView({
      webPreferences: { ...webPreferences, preload: path.join(__dirname, 'shell-preload.cjs') }
    });
    view.setBackgroundColor('#292a2d');
    contents = view.webContents;
    contents.on('will-navigate', event => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const fromPopup = event => event.senderFrame?.url === url && !event.senderFrame.parent;
    contents.ipc.on('simplecloud:shell-ready', event => {
      if (!fromPopup(event)) return;
      ready = true;
      send(level);
      if (host && keyboard) focusSlider();
    });
    contents.ipc.on('simplecloud:shell-action', (event, name, value) => {
      if (!host || !fromPopup(event)) return;
      if (name === 'volume' && Number.isFinite(value) && value >= 0 && value <= 1) setVolume(value);
      if (name === 'volumeHold') held = value === true;
      if (name === 'volumeDismiss') hide(true);
    });
    contents.on('blur', () => {
      if (host && (keyboard || held)) hide();
    });
    contents.loadFile(page).catch(error => {
      if (!contents.isDestroyed()) {
        hide();
        console.warn('[shell] Could not open volume:', error.message);
      }
    });
  };
  return {
    show(window, shellBounds, value) {
      const { x, y, width: w, height: h, focus } = value ?? {};
      if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w < 1 || h < 1
        || x + w > shellBounds.width || y + h > shellBounds.height) return false;
      const bottom = Math.round(shellBounds.y + y);
      if (bottom < 1) return false;
      if (host && focus !== true) return true;
      if (!view) createView();
      if (!host) {
        host = window;
        anchor = { y: shellBounds.y + y, height: h };
        const [windowWidth] = window.getContentSize();
        const popupHeight = Math.min(height, bottom);
        bounds = {
          x: Math.round(Math.max(0, Math.min(windowWidth - width, shellBounds.x + x + (w - width) / 2))),
          y: bottom - popupHeight,
          width, height: popupHeight
        };
        view.setBounds(bounds);
        window.contentView.addChildView(view);
        view.setVisible(true);
        outsideSince = undefined;
        timer = setInterval(tick, 40);
        send(level);
      }
      if (focus === true) {
        keyboard = true;
        if (ready) focusSlider();
      }
      return true;
    },
    visible: () => Boolean(host),
    setLevel(value) {
      if (level === value) return;
      level = value;
      if (Number.isFinite(level)) send(level);
      else hide();
    },
    hide,
    destroy() {
      hide();
      if (contents && !contents.isDestroyed()) contents.close();
    },
    get view() { return view; }
  };
}

module.exports = { createVolumePopup };

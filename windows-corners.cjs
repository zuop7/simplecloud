// Electron's logical window bounds omit the invisible Windows resize frame.
// SetWindowRgn uses physical pixels relative to the real HWND instead.
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
koffi.struct('SimpleCloudRect', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const getWindowRect = user32.func('int __stdcall GetWindowRect(void *, _Out_ SimpleCloudRect *)');
const setWindowRegion = user32.func('int __stdcall SetWindowRgn(void *, void *, int)');
const roundRect = gdi32.func('void * __stdcall CreateRoundRectRgn(int, int, int, int, int, int)');
const deleteObject = gdi32.func('int __stdcall DeleteObject(void *)');
const cornerRadius = 20; // Device-independent pixels.

function createListeningCorners(window, screen) {
  const hwnd = koffi.decode(window.getNativeWindowHandle(), 'void *');
  let geometry;
  let applying = false;
  return {
    apply() {
      // SetWindowRgn can synchronously deliver move/resize messages.
      if (applying) return true;
      if (window.isMinimized() || window.isMaximized()) return true;
      const raw = {};
      if (!getWindowRect(hwnd, raw)) return false;
      const logical = window.getContentBounds();
      const pixels = screen.dipToScreenRect(window, logical);
      if (pixels.width < 1 || pixels.height < 1) return false;
      const x = pixels.x - raw.left;
      const y = pixels.y - raw.top;
      const diameter = Math.max(2, Math.round(2 * cornerRadius * pixels.width / logical.width));
      const shape = [x, y, x + pixels.width, y + pixels.height, diameter, diameter];
      const key = shape.join(':');
      if (geometry === key) return true;
      const region = roundRect(...shape);
      if (!region) return false;
      applying = true;
      let applied;
      try { applied = setWindowRegion(hwnd, region, 1); }
      finally { applying = false; }
      if (!applied) {
        deleteObject(region);
        return false;
      }
      // Windows owns the region after SetWindowRgn succeeds.
      geometry = key;
      return true;
    },
    clear() {
      if (!geometry || setWindowRegion(hwnd, null, 1)) {
        geometry = undefined;
        return true;
      }
      return false;
    }
  };
}

module.exports = { createListeningCorners };

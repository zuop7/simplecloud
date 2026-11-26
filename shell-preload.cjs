const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('simpleCloud', {
  onState: callback => { ipcRenderer.on('simplecloud:shell-state', (_event, state) => callback(state)); },
  onHistory: callback => { ipcRenderer.on('simplecloud:search-history', (_event, entries) => callback(entries)); },
  onFocusSearch: callback => { ipcRenderer.on('simplecloud:focus-search', () => callback()); },
  onFocusPlayer: callback => { ipcRenderer.on('simplecloud:focus-player', () => callback()); },
  onBlurSearch: callback => { ipcRenderer.on('simplecloud:blur-search', () => callback()); },
  onError: callback => { ipcRenderer.on('simplecloud:shell-error', (_event, error) => callback(error)); },
  onVolume: callback => { ipcRenderer.on('simplecloud:volume-state', (_event, level) => callback(level)); },
  onFocusVolume: callback => { ipcRenderer.on('simplecloud:focus-volume', () => callback()); },
  onVolumeOpened: callback => { ipcRenderer.on('simplecloud:volume-opened', () => callback()); },
  onVolumeClosed: callback => { ipcRenderer.on('simplecloud:volume-closed', (_event, focus) => callback(focus)); },
  ready: () => ipcRenderer.send('simplecloud:shell-ready'),
  action: (name, value) => ipcRenderer.send('simplecloud:shell-action', name, value)
});

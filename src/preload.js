// Preload script — exposes only specific main-process functions to the
// dashboard renderer, via contextBridge. The renderer never gets raw
// Node.js access (contextIsolation: true in main.js).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('docufast', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getStats: () => ipcRenderer.invoke('get-stats'),
  verifyKey: (key) => ipcRenderer.invoke('verify-key', key),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  getAssetUrl: (name) => ipcRenderer.invoke('get-asset-url', name),
  retryJob: (code) => ipcRenderer.invoke('retry-job', code),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),

  // Listen for live stats pushed from the main process
  onStatsUpdate: (cb) => ipcRenderer.on('stats-update', (_, data) => cb(data)),
  onNavigate: (cb) => ipcRenderer.on('navigate', (_, tab) => cb(tab)),
});

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
  retryJob: (code, reprint) => ipcRenderer.invoke('retry-job', code, !!reprint),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  getPrinterInfo: (name) => ipcRenderer.invoke('get-printer-info', name),
  previewSettings: (draft) => ipcRenderer.invoke('preview-settings', draft),
  detectSumatra: () => ipcRenderer.invoke('detect-sumatra'),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  getLogTail: (n) => ipcRenderer.invoke('get-log-tail', n),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  setPaused: (p) => ipcRenderer.invoke('set-paused', p),
  testPrint: () => ipcRenderer.invoke('test-print'),

  // Account (email sign-in, registration, subscription)
  requestCode: (email) => ipcRenderer.invoke('acct-request-code', email),
  verifyCode: (email, code) => ipcRenderer.invoke('acct-verify', email, code),
  getPlans: () => ipcRenderer.invoke('acct-plans'),
  me: () => ipcRenderer.invoke('acct-me'),
  accountInfo: () => ipcRenderer.invoke('acct-info'),
  subscribe: (form) => ipcRenderer.invoke('acct-subscribe', form),
  finishSignIn: () => ipcRenderer.invoke('acct-finish'),
  signOut: () => ipcRenderer.invoke('acct-logout'),

  // Listen for live stats pushed from the main process
  onStatsUpdate: (cb) => ipcRenderer.on('stats-update', (_, data) => cb(data)),
  onNavigate: (cb) => ipcRenderer.on('navigate', (_, tab) => cb(tab)),
});

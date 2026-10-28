// DocuFast India — Desktop Print Agent
// Main process: manages the system tray, spawns the background print loop,
// and serves the dashboard window. Runs silently on Windows startup.

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, Notification, powerMonitor } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');

// The packaged app's package.json "name" is "docufast-agent" (the raw npm
// name), which is what Electron would otherwise use to build the settings
// folder path (%APPDATA%\docufast-agent\), NOT the friendly "DocuFast Agent"
// name shown everywhere else. Pinning it explicitly — before Store reads
// app.getPath('userData') below — makes the config path predictable, which
// matters for support and for any provisioning script that pre-fills it.
app.setName('DocuFast Agent');

// Cloud URL is baked in at build time — shops never need to enter this.
// To update it, change this constant and rebuild the .exe.
const CLOUD_URL = 'https://docufast-nu.vercel.app';

// Live wake-up connection (Supabase Realtime). The anon key is public by
// design: it can only read/send the empty shop wake-up pings allowed by the
// database policies; all real data still goes through the authenticated API.
const SUPABASE_URL = 'https://chqennbbwkyhmemfubtj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNocWVubmJid2t5aG1lbWZ1YnRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxNjY3NDAsImV4cCI6MjEwODc0Mjc0MH0.SDpg_abhMEO4lNmeOUguSFteEt3kecDu-7SxdfwbKSU';
const PUSH_FALLBACK_POLL_MS = 120000; // safety poll while the live connection is healthy

const Store = require('electron-store');
const store = new Store({
  schema: {
    agentKey:    { type: 'string', default: '' },
    sumatraPath: { type: 'string', default: 'C:\\Users\\ADMIN\\AppData\\Local\\SumatraPDF\\SumatraPDF.exe' },
    printerName: { type: 'string', default: '' },
    autoLaunch:  { type: 'boolean', default: true },
    pollMs:      { type: 'number', default: 10000 },
    setupDone:   { type: 'boolean', default: false },
    // Paper size forced on every print job (see buildPrintSettings). A4 is
    // the standard in India. Not shown in the UI on purpose — shops should
    // never need to touch it; set to '' in config.json to disable forcing.
    paperSize:   { type: 'string', default: 'auto' },   // auto | A3 | A4 | A5 | letter | legal
    // Safe mode: send only the copy count + fit-to-page, nothing the driver could misread.
    safePrint:   { type: 'boolean', default: false },
    // Photos/scans are printed through Windows' own print path (Chromium),
    // which sizes the page correctly on every driver; SumatraPDF is kept for PDFs.
    imageEngine: { type: 'string', default: 'windows' }, // windows | sumatra
    scaling:     { type: 'string', default: 'fit' },    // fit | shrink | noscale
    orientation: { type: 'string', default: 'auto' },   // auto | portrait | landscape
    colorPolicy: { type: 'string', default: 'follow' }, // follow (what customer chose) | bw | color
    duplexPolicy:{ type: 'string', default: 'follow' }, // follow | never
    duplexEdge:  { type: 'string', default: 'long' },   // long | short
    trayBin:     { type: 'number', default: 0 },        // 0 = printer default tray
    printTimeoutSec: { type: 'number', default: 90 },
    livePush:    { type: 'boolean', default: true },    // instant wake-up when a customer pays
    paused:      { type: 'boolean', default: false },   // stop picking up new jobs (paper out, etc.)
    notifications: { type: 'boolean', default: true },
    printedCodes: { type: 'array', default: [] },       // last jobs printed here (guards against re-printing)
    // Cached once and reused for the lifetime of this install — see
    // getMachineId() below. Not something a person ever sets manually.
    machineId:   { type: 'string', default: '' },
  },
});

const isDev = process.argv.includes('--dev');

// A stable ID for THIS computer, used so the cloud can enforce one shop key
// = one computer (see /api/agent/heartbeat and /api/agent/pending on the
// backend). Reads Windows' own per-install MachineGuid — the same value
// changes only on an OS reinstall, never on reboot/update, and needs no
// extra npm dependency. Resolved once and cached in the store so normal
// polling never has to shell out to PowerShell for it.
async function getMachineId() {
  const cached = store.get('machineId');
  if (cached) return cached;

  let id;
  try {
    const { spawn } = require('child_process');
    id = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Cryptography" -Name MachineGuid).MachineGuid'
      ], { windowsHide: true });
      let out = '';
      child.stdout.on('data', d => (out += d));
      child.on('error', reject);
      child.on('close', code => {
        const val = out.trim();
        if (code === 0 && val) resolve(val);
        else reject(new Error(`MachineGuid read failed (exit ${code})`));
      });
    });
  } catch (err) {
    // Fallback: a random UUID generated once and persisted. Not tied to
    // Windows itself, but still stable across restarts of this app, which
    // is what actually matters for duplicate-key detection.
    console.log('Could not read Windows MachineGuid, using a generated one instead:', err.message);
    id = require('crypto').randomUUID();
  }

  store.set('machineId', id);
  return id;
}

let machineId = ''; // resolved once in app.whenReady(), reused everywhere below

// electron-builder's `extraResources` config copies assets/ to
// resources/assets/ — OUTSIDE the app.asar archive. path.join(__dirname,
// '..', 'assets', ...) points INSIDE the asar instead, where these files
// don't actually exist once packaged, which nativeImage/BrowserWindow load
// as silently empty/missing rather than throwing. This resolves to the
// right place in both the packaged app and `npm start`/`npm run dev`.
function assetPath(...segments) {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '..', 'assets');
  return path.join(base, ...segments);
}

let tray = null;
let dashboardWindow = null;
let agentRunning = false;
let updateReady = false;   // an update has downloaded and is waiting to install
let updateVersion = null;
let pollTimer = null;
let heartbeatTimer = null;
let shopDataTimer = null;
let printerId = null;

// ---- Stats (in-memory, reset on restart) ----
const stats = {
  jobsToday: 0,
  revenueToday: 0,
  pending: 0,
  connected: false,
  lastPoll: null,
  recentJobs: [], // last 50 jobs with timestamps
  shopName: null,
  shopSlug: null,
  duplicateKey: false,     // true if this shop key is already active on another PC
  duplicateMessage: '',
  paused: false,
  push: 'off',            // off | connecting | connected | down
};

// ---- App lifecycle ----
stats.paused = store.get('paused');
app.setLoginItemSettings({ openAtLogin: store.get('autoLaunch') });
app.whenReady().then(init);
app.on('window-all-closed', e => e.preventDefault()); // stay alive even if window closed

async function init() {
  createTray();
  machineId = await getMachineId();

  // After sleep, the poll/heartbeat setIntervals don't fire while the PC is
  // asleep, and Windows doesn't "catch up" missed ticks on wake — the agent
  // would otherwise just sit there until whatever the next naturally-timed
  // tick happens to be. Forcing an immediate check on wake means jobs get
  // picked up right away instead of waiting on a stale schedule.
  // (powerMonitor can only be used after 'ready', hence registering it here
  // in init() rather than at module top-level.)
  powerMonitor.on('resume', () => {
    if (!agentRunning) return;
    pollOnce();
    heartbeat();
    fetchShopData();
  });
  // Windows fires 'unlock-screen' on wake-from-sleep separately from
  // 'resume' in some configurations (fast startup / hybrid sleep) — cover
  // both rather than assume only one fires.
  powerMonitor.on('unlock-screen', () => {
    if (!agentRunning) return;
    pollOnce();
    heartbeat();
  });

  // Show 1-field setup screen if this is a fresh install (no API key yet)
  if (!store.get('setupDone') || !store.get('agentKey')) {
    openSetupWizard();
  } else {
    startAgent();
  }

  setupAutoUpdate();
}

// Every fix so far has meant physically visiting each shop with a pendrive
// to reinstall — this makes new builds reach shops on their own. Updates
// download in the background and install automatically the next time the
// app quits and relaunches (which happens naturally at each Windows
// restart) — a shop never has to do anything. autoUpdater with an NSIS
// target and no admin-elevation requirement (see the requestedExecutionLevel
// fix from earlier) installs silently without a UAC prompt or SmartScreen
// interrupting an unattended background update.
function setupAutoUpdate() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    updateVersion = info.version;
    updateTrayMenu();
    new Notification({
      title: 'DocuFast Agent — Update ready',
      body: `Version ${info.version} downloaded. It'll install next time the app restarts, or click "Restart & update" in the tray menu now.`,
      icon: assetPath('icon.ico'),
    }).show();
  });

  autoUpdater.on('error', (err) => {
    // Non-fatal by design — a broken update check should never interrupt
    // the actual print-agent loop. Logged for remote debugging only.
    console.error('Auto-update check failed:', err.message);
  });

  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000); // every 4h
}

function openSetupWizard() {
  const win = new BrowserWindow({
    width: 560,
    height: 580,
    resizable: false,
    title: 'DocuFast Agent — Setup',
    icon: assetPath('icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
  });
  win.loadFile(path.join(__dirname, '..', 'dashboard', 'setup.html'));
}

// ---- System Tray ----
function createTray() {
  const iconPath = assetPath('tray-icon.png');
  let icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();

  // A corrupt or unreadable icon file decodes to an empty image without
  // throwing, which is exactly what made the tray icon invisible before —
  // fall back to the app icon rather than fail silently again.
  if (icon.isEmpty()) {
    const fallbackPath = assetPath('icon.ico');
    if (fs.existsSync(fallbackPath)) icon = nativeImage.createFromPath(fallbackPath);
  }

  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('DocuFast Agent');
  updateTrayMenu();
  tray.on('double-click', () => openDashboard());
}

function updateTrayMenu() {
  const connected = stats.connected;
  const statusLabel = stats.duplicateKey ? '⚠ Duplicate key' : (store.get('paused') ? '⏸ Paused' : (connected ? `● Connected` : `○ Disconnected`));
  const statusSub = stats.duplicateKey
    ? 'Active on another PC — stopped'
    : (connected ? `Polling every ${store.get('pollMs') / 1000}s` : 'Check settings');

  const menu = Menu.buildFromTemplate([
    { label: 'DocuFast Agent', enabled: false },
    { type: 'separator' },
    { label: statusLabel, enabled: false },
    { label: statusSub, enabled: false },
    { type: 'separator' },
    { label: `Jobs today: ${stats.jobsToday}`, enabled: false },
    { label: `Revenue: ₹${(stats.revenueToday / 100).toFixed(2)}`, enabled: false },
    { label: `Pending: ${stats.pending}`, enabled: false },
    { type: 'separator' },
    { label: store.get('paused') ? '▶ Resume printing' : '⏸ Pause printing', click: () => { store.set('paused', !store.get('paused')); stats.paused = store.get('paused'); updateTrayMenu(); broadcastStats(); if (!stats.paused) pollOnce(); } },
    { label: 'Open dashboard', click: () => openDashboard() },
    { label: 'Settings', click: () => openDashboard('setup') },
    { label: 'Safe print mode (use if a printer prints a small block)', type: 'checkbox', checked: !!store.get('safePrint'), click: (mi) => { store.set('safePrint', mi.checked); } },
    { label: `Live connection: ${stats.push === 'connected' ? 'on (instant printing)' : stats.push === 'off' ? 'off' : stats.push === 'connecting' ? 'connecting…' : 'down, checking every ' + Math.round(store.get('pollMs') / 1000) + 's'}`, enabled: false },
    { label: 'Open print log folder', click: () => { fs.mkdirSync(getLogDir(), { recursive: true }); shell.openPath(getLogDir()); } },
    { type: 'separator' },
    ...(updateReady ? [
      { label: `⬇ Restart & update to v${updateVersion}`, click: () => autoUpdater.quitAndInstall() },
      { type: 'separator' },
    ] : []),
    { label: 'Quit DocuFast Agent', click: () => { app.quit(); } },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(stats.duplicateKey
    ? 'DocuFast Agent — Duplicate key, stopped'
    : `DocuFast Agent — ${connected ? 'Connected' : 'Disconnected'}`);
}

// ---- Dashboard Window ----
function openDashboard(tab = 'dashboard') {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    dashboardWindow.webContents.send('navigate', tab);
    return;
  }

  dashboardWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: 'DocuFast Agent',
    icon: assetPath('icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    autoHideMenuBar: true,
  });

  dashboardWindow.loadFile(path.join(__dirname, '..', 'dashboard', 'index.html'));
  dashboardWindow.once('ready-to-show', () => {
    dashboardWindow.show();
    if (tab !== 'dashboard') {
      dashboardWindow.webContents.send('navigate', tab);
    }
  });
  dashboardWindow.on('close', e => {
    e.preventDefault();
    dashboardWindow.hide(); // hide instead of close — agent keeps running
  });

  if (isDev) dashboardWindow.webContents.openDevTools();
}

// ---- IPC handlers (dashboard ↔ main process) ----
ipcMain.handle('get-config', () => ({ ...store.store, printedCodes: undefined, cloudUrl: CLOUD_URL, appVersion: app.getVersion(), logDir: getLogDir() }));
const SETTABLE = {
  agentKey: 'string', sumatraPath: 'string', printerName: 'string', autoLaunch: 'boolean',
  pollMs: 'number', livePush: 'boolean', imageEngine: 'string', paperSize: 'string', safePrint: 'boolean', scaling: 'string',
  orientation: 'string', colorPolicy: 'string', duplexPolicy: 'string', duplexEdge: 'string',
  trayBin: 'number', printTimeoutSec: 'number', paused: 'boolean', notifications: 'boolean',
};
const ALLOWED = {
  imageEngine: ['windows', 'sumatra'],
  paperSize: ['auto', 'A3', 'A4', 'A5', 'letter', 'legal'],
  scaling: ['fit', 'shrink', 'noscale'],
  orientation: ['auto', 'portrait', 'landscape'],
  colorPolicy: ['follow', 'bw', 'color'],
  duplexPolicy: ['follow', 'never'],
  duplexEdge: ['long', 'short'],
};
ipcMain.handle('save-config', (_, config) => {
  const oldKey = store.get('agentKey');
  for (const [k, v] of Object.entries(config || {})) {
    if (!SETTABLE[k] || typeof v !== SETTABLE[k]) continue; // never saves cloudUrl or unknown keys
    if (ALLOWED[k] && !ALLOWED[k].includes(v)) continue;
    if (k === 'pollMs') store.set(k, Math.max(3000, Math.min(60000, v)));
    else if (k === 'trayBin') store.set(k, Math.max(0, Math.min(99, Math.round(v))));
    else if (k === 'printTimeoutSec') store.set(k, Math.max(20, Math.min(600, Math.round(v))));
    else store.set(k, v);
  }
  app.setLoginItemSettings({ openAtLogin: store.get('autoLaunch') });
  printerInfoCache.clear(); // printer may have changed
  if (store.get('agentKey')) {
    store.set('setupDone', true);
    if (store.get('agentKey') !== oldKey) { printerId = null; stats.duplicateKey = false; duplicateKeyNotified = false; }
    startAgent();
  }
  updateTrayMenu();
  broadcastStats();
  return { ok: true };
});
ipcMain.handle('get-stats', () => ({ ...stats }));
ipcMain.handle('open-url', (_, url) => shell.openExternal(url));

// The dashboard/setup HTML load from inside app.asar, but assets/ only
// exists at resources/assets/ (see assetPath() above) — a relative
// "../assets/logo.png" from inside the asar can't reach it. Renderers ask
// for a proper file:// URL instead of guessing a relative path.
ipcMain.handle('get-asset-url', (_, name) => {
  const p = assetPath(name);
  return fs.existsSync(p) ? url.pathToFileURL(p).href : '';
});

// Retry a failed job — same endpoint the web admin dashboard uses.
// Must run here (main process), not the renderer, for the same CORS reason
// as verify-key above.
ipcMain.handle('retry-job', async (_, code, reprint = false) => {
  const agentKey = store.get('agentKey');
  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`${CLOUD_URL}/api/admin/jobs/${encodeURIComponent(code)}/retry${reprint ? '?reprint=1' : ''}`, {
      method: 'POST',
      headers: { 'x-agent-key': agentKey },
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return { ok: false, error: d?.error || `Retry failed (${res.status})` };
    }
    if (reprint) {
      // Allow this PC to print the code again (see printedCodes guard).
      store.set('printedCodes', (store.get('printedCodes') || []).filter(c => c !== code));
    }
    fetchShopData(); // pull the updated status right away instead of waiting up to 30s
    pollOnce();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not reach the server — ${e.message}` };
  }
});

// List printers Windows knows about, so Settings can offer a dropdown
// instead of asking the shop to type an exact printer name.
ipcMain.handle('get-printers', async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const printers = await win.webContents.getPrintersAsync();
    return printers.map(p => ({ name: p.name, isDefault: !!p.isDefault }));
  } catch (e) {
    return [];
  }
});

// ---- Printing tools used by the Settings screen ----
ipcMain.handle('get-printer-info', async (_, name) => {
  const info = await queryPrinterInfo(name || '');
  return info;
});
ipcMain.handle('preview-settings', async (_, draft) => {
  // Shows exactly what would be sent to SumatraPDF for the DRAFT values in
  // the form (not yet saved), for a colour+duplex job.
  const prev = {};
  for (const k of Object.keys(draft || {})) if (SETTABLE[k]) { prev[k] = store.get(k); store.set(k, draft[k]); }
  try {
    const bw = await buildPrintSettings({ printerName: draft.printerName ?? store.get('printerName'), copies: 1, colorMode: 'bw', duplex: false });
    const col = await buildPrintSettings({ printerName: draft.printerName ?? store.get('printerName'), copies: 2, colorMode: 'color', duplex: true });
    return { bw: bw.settings, color: col.settings, notes: [...new Set([...bw.notes, ...col.notes])] };
  } finally {
    for (const [k, v] of Object.entries(prev)) store.set(k, v);
  }
});
ipcMain.handle('detect-sumatra', () => resolveSumatraPath());
ipcMain.handle('open-log-folder', () => { fs.mkdirSync(getLogDir(), { recursive: true }); return shell.openPath(getLogDir()); });
ipcMain.handle('get-log-tail', (_, lines = 40) => {
  try {
    const t = fs.readFileSync(path.join(getLogDir(), 'print.log'), 'utf8').trim().split('\n');
    return t.slice(-Math.max(5, Math.min(200, lines))).join('\n');
  } catch { return '(no print log yet)'; }
});
ipcMain.handle('check-updates', async () => {
  if (!app.isPackaged) return { ok: false, message: 'Updates only work in the installed app.' };
  try {
    const r = await autoUpdater.checkForUpdates();
    const v = r?.updateInfo?.version;
    if (v && v !== app.getVersion()) return { ok: true, message: `Version ${v} found — downloading in the background.` };
    return { ok: true, message: `You're up to date (v${app.getVersion()}).` };
  } catch (e) { return { ok: false, message: `Could not check: ${e.message}` }; }
});
ipcMain.handle('set-paused', (_, paused) => {
  store.set('paused', !!paused);
  stats.paused = !!paused;
  updateTrayMenu();
  broadcastStats();
  if (!paused) pollOnce();
  return { ok: true };
});
ipcMain.handle('test-print', async () => {
  const printerName = store.get('printerName');
  const file = path.join(os.tmpdir(), `docufast-testpage-${Date.now()}.pdf`);
  try {
    const info = await queryPrinterInfo(printerName);
    fs.writeFileSync(file, makeTestPdf([
      'DocuFast India - test page',
      `Printer: ${info.name || printerName || '(Windows default)'}`,
      `Driver: ${info.driver || 'unknown'}`,
      `Paper: ${store.get('paperSize')}   Scaling: ${store.get('scaling')}   Safe mode: ${store.get('safePrint') ? 'on' : 'off'}`,
      `Printed: ${new Date().toLocaleString()}`,
      '',
      'CHECK: the border should be close to all 4 page edges,',
      'the small square below should measure 25.4 mm (1 inch) each side,',
      'and the diagonals should reach all four corners.',
    ]));
    const settings = await printFile(file, 1, 'bw', false);
    return { ok: true, settings };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    setTimeout(() => fs.unlink(file, () => {}), 30000);
  }
});

// Minimal single-page A4 PDF built by hand so a test print needs no
// download and no PDF library. Contents are chosen to expose the exact
// failure we saw ("tiny block in a corner"): a near-edge border, corner
// diagonals and a 1-inch reference square show scaling/paper problems at a glance.
function makeTestPdf(lines) {
  const esc = t => String(t).replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, '?');
  let content = '1 w\n24 24 547 794 re S\n24 24 m 571 818 l S\n24 818 m 571 24 l S\n';
  content += '72 560 72 72 re S\n';
  content += 'BT /F1 18 Tf 50 770 Td (' + esc(lines[0]) + ') Tj ET\n';
  let y = 740;
  for (const l of lines.slice(1)) { content += 'BT /F1 10 Tf 50 ' + y + ' Td (' + esc(l) + ') Tj ET\n'; y -= 16; }
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + 'endstream',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = Buffer.byteLength(out);
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach(o => { out += String(o).padStart(10, '0') + ' 00000 n \n'; });
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(out, 'latin1');
}

// Verify a shop key against the cloud.
// This MUST run in the main process: the setup window is loaded from file://,
// so a fetch() from the renderer is sent with Origin: null and blocked by CORS,
// which surfaces to the user as the generic "Failed to fetch". node-fetch here
// is a plain server-side request with no CORS involved.
//
// Goes through the heartbeat endpoint rather than pending.js specifically so
// the one-shop-key-one-computer check runs right here at setup time — the
// shop owner finds out immediately if this key is already active on
// another PC, instead of the app quietly failing to print later.
ipcMain.handle('verify-key', async (_, key) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`${CLOUD_URL}/api/agent/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-key': key,
        'x-machine-id': machineId,
        'x-machine-name': os.hostname(),
      },
      body: JSON.stringify({}),
      timeout: 15000,
    });

    if (res.status === 401) return { ok: false, error: 'Invalid key — please check and try again.' };
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.message || 'This shop key is already active on another computer.' };
    }
    if (!res.ok) return { ok: false, error: `Could not connect (${res.status}) — check your internet.` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not reach the server — check your internet connection. (${e.message})` };
  }
});

// ---- Print agent loop ----
let pushHandle = null;
let wakePending = false;

// Poll quickly when there is no live connection, slowly (safety net only)
// when push is healthy.
function applyPollInterval() {
  if (stats.duplicateKey) return;
  if (pollTimer) clearInterval(pollTimer);
  const ms = stats.push === 'connected' ? PUSH_FALLBACK_POLL_MS : store.get('pollMs');
  pollTimer = setInterval(pollOnce, ms);
}

function startPushConnection() {
  if (pushHandle) { pushHandle.stop(); pushHandle = null; }
  const key = store.get('agentKey');
  if (!key || !store.get('livePush')) { stats.push = 'off'; return; }
  stats.push = 'connecting';
  try {
    pushHandle = require('./push').startPush({
      agentKey: key,
      url: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
      log: logPrint,
      onWake: () => {
        logPrint('push: wake-up received');
        if (isPolling) wakePending = true; else pollOnce();
      },
      onState: s => {
        stats.push = s;
        applyPollInterval();
        if (s === 'connected') pollOnce(); // catch anything missed while disconnected
        updateTrayMenu();
        broadcastStats();
      },
    });
  } catch (e) {
    logPrint(`push: failed to start - ${e.message}`);
    stats.push = 'down';
  }
}

function startAgent() {
  if (pollTimer) clearInterval(pollTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (shopDataTimer) clearInterval(shopDataTimer);
  agentRunning = true;
  pollOnce();
  fetchShopData();
  startPushConnection();
  applyPollInterval();
  heartbeat();
  // Heartbeat and shop-data used to run on constant 15s/30s timers
  // regardless of activity — most of that was wasted calls while a shop
  // sits idle between customers. Both now fire immediately around actual
  // work (see handleJob below) and only fall back to a periodic call here
  // to keep "online" status from going stale during long idle stretches.
  heartbeatTimer = setInterval(heartbeat, 180000);     // idle fallback: every 3 min
  shopDataTimer = setInterval(fetchShopData, 180000);  // idle fallback: every 3 min
}

function restartAgent() {
  if (pollTimer) clearInterval(pollTimer);
  startAgent();
}

// Pull the shop's name/slug and its full job history from the cloud —
// the same endpoint the web admin dashboard uses (x-shop-key === the shop's
// own api_key, which is exactly what's stored as agentKey here). This is
// what backfills "old prints" and the shop name, which the in-memory
// `stats.recentJobs` alone can't show after an app restart.
async function fetchShopData() {
  const agentKey = store.get('agentKey');
  if (!agentKey) return;

  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`${CLOUD_URL}/api/admin/jobs`, {
      headers: { 'x-shop-key': agentKey },
    });
    if (!res.ok) return; // don't clobber existing data on a transient error

    const data = await res.json();
    stats.shopName = data.shopName || null;
    stats.shopSlug = data.shopSlug || null;

    const cloudJobs = (data.jobs || []).map(j => ({
      code: j.code,
      filename: j.filename,
      colorMode: j.colorMode,
      copies: j.copies,
      duplex: j.duplex,
      pages: j.pages,
      amount: j.amount,
      status: j.status === 'printed' ? 'printed' : (j.status === 'printing' ? 'printing' : (j.printError ? 'failed' : j.status)),
      startedAt: j.createdAt,
      printedAt: j.printedAt,
      error: j.printError || null,
    }));

    mergeJobHistory(cloudJobs);
    recomputeTodayStats(cloudJobs);
    broadcastStats();
  } catch {
    // Non-fatal — local session history still works even if this fetch fails.
  }
}

// jobsToday/revenueToday used to be incremented locally in handleJob(), but
// that never actually worked: /api/agent/pending doesn't send a job's
// amount, so jobRecord.amount was hardcoded to 0 and revenue never moved.
// Deriving both straight from the cloud's job list (which does carry
// amount) is simpler and self-corrects on every 30s poll instead of drifting.
function recomputeTodayStats(cloudJobs) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  let jobsToday = 0;
  let revenueToday = 0;
  for (const j of cloudJobs) {
    const when = j.printedAt ? new Date(j.printedAt) : (j.startedAt ? new Date(j.startedAt) : null);
    if (j.status === 'printed' && when && when >= startOfToday) {
      jobsToday++;
      revenueToday += j.amount || 0;
    }
  }
  stats.jobsToday = jobsToday;
  stats.revenueToday = revenueToday;
}

// Merge cloud history with the in-memory list. The in-memory list still
// wins for a job that's actively "printing" right now (the cloud only
// reflects it once the agent posts a final result), everything else is
// taken from the cloud since it's the durable source of truth.
function mergeJobHistory(cloudJobs) {
  const byCode = new Map();
  for (const j of cloudJobs) byCode.set(j.code, j);
  for (const local of stats.recentJobs) {
    if (local.status === 'printing' && !byCode.has(local.code)) {
      byCode.set(local.code, local);
    }
  }
  stats.recentJobs = Array.from(byCode.values())
    .sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0))
    .slice(0, 50);
}

async function heartbeat() {
  const agentKey = store.get('agentKey');
  if (!agentKey) return;

  try {
    const fetch = (await import('node-fetch')).default;
    const body = { printerName: store.get('printerName') || 'DocuFast Printer', printerId };
    const res = await fetch(`${CLOUD_URL}/api/agent/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-key': agentKey,
        'x-machine-id': machineId,
        'x-machine-name': os.hostname(),
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.printerId) printerId = data.printerId;
      stats.connected = true;
      stats.duplicateKey = false;
    } else if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      handleDuplicateKey(data.message);
    } else {
      stats.connected = false;
    }
  } catch {
    stats.connected = false;
  }
  updateTrayMenu();
  broadcastStats();
}

// A second computer using this shop's key gets here. Rather than just
// showing "Disconnected" (which looks like a normal network hiccup and
// invites someone to just leave it running), this is a distinct, sticky
// state: polling stops entirely — printing jobs from two unrelated
// computers using the same key is a worse outcome than printing nothing —
// and a one-time desktop notification explains why, so whoever's at this
// PC actually sees it instead of it silently doing nothing in the tray.
let duplicateKeyNotified = false;
function handleDuplicateKey(message) {
  stats.connected = false;
  stats.duplicateKey = true;
  stats.duplicateMessage = message || 'This shop key is already active on another computer.';
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (pushHandle) { pushHandle.stop(); pushHandle = null; stats.push = 'off'; }
  agentRunning = false;

  if (!duplicateKeyNotified) {
    duplicateKeyNotified = true;
    new Notification({
      title: 'DocuFast Agent — Duplicate Key',
      body: 'This shop key is already active on another computer. This agent has stopped to avoid double-printing jobs.',
    }).show();
  }
}

let isPolling = false; // guards against overlapping poll cycles (see below)

async function pollOnce() {
  // Without this guard, a print job that takes longer than the poll
  // interval (very normal for multi-page documents) would let the next
  // setInterval tick start a SECOND pollOnce() while the first is still
  // printing. The cloud hasn't marked that job "printed" yet at that point,
  // so the second cycle could see it as still pending and print it again —
  // a customer getting two physical copies of something they paid for once.
  if (isPolling) return;
  isPolling = true;

  const agentKey = store.get('agentKey');
  if (!agentKey) { isPolling = false; return; }

  try {
    const fetch = (await import('node-fetch')).default;
    const headers = { 'x-agent-key': agentKey, 'x-machine-id': machineId };
    if (printerId) headers['x-printer-id'] = printerId;

    const res = await fetch(`${CLOUD_URL}/api/agent/pending`, { headers });
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      handleDuplicateKey(data.message);
      return;
    }
    if (!res.ok) { stats.connected = false; updateTrayMenu(); return; }

    const data = await res.json();
    stats.connected = true;
    stats.pending = data.jobs.length;
    stats.lastPoll = new Date().toISOString();
    updateTrayMenu();

    // Paused (paper out, printer being fixed...): stay connected and keep
    // counting pending jobs, but don't start any print until resumed.
    if (!store.get('paused')) {
      for (const job of data.jobs) {
        await handleJob(job, CLOUD_URL, agentKey);
      }
    }
  } catch {
    stats.connected = false;
    updateTrayMenu();
  } finally {
    isPolling = false;
  }
  broadcastStats();
  // A wake-up arrived while we were busy printing: check again right away.
  if (wakePending) { wakePending = false; pollOnce(); }
}

// Remember the last jobs this PC printed. If the "printed" report to the
// cloud fails (wifi blip), the job comes back on the next poll — without
// this the agent would print it AGAIN and the customer gets two copies.
function rememberPrinted(code) {
  const list = store.get('printedCodes') || [];
  if (!list.includes(code)) { list.push(code); store.set('printedCodes', list.slice(-200)); }
}


function forgetPrinted(code) {
  const list = store.get('printedCodes') || [];
  if (list.includes(code)) store.set('printedCodes', list.filter(c => c !== code));
}

// ---- File types ----
// The web app lets customers upload PDF, images AND Word files, but
// SumatraPDF only prints PDFs and images. A .docx handed straight to it
// either does nothing or prints junk, while the customer has already paid.
// Word files are converted to PDF first (Microsoft Word if installed, else
// LibreOffice); if neither exists the job fails with a message that says so.
const SUMATRA_TYPES = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tif', '.tiff', '.webp']);
const WORD_TYPES = new Set(['.doc', '.docx', '.rtf', '.odt']);

function runProc(cmd, args, timeoutMs, env) {
  return new Promise(resolve => {
    require('child_process').execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, env: env || process.env }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

async function makePrintable(filePath, ext, buffer) {
  const e = (ext || '').toLowerCase();
  if (e === '.pdf' && buffer && buffer.slice(0, 1024).toString('latin1').indexOf('%PDF') === -1) {
    const head = buffer.slice(0, 60).toString('utf8').replace(/\s+/g, ' ');
    throw new Error(`Downloaded file is not a valid PDF (starts with "${head}"). The upload may have expired — ask the customer to upload again.`);
  }
  if (SUMATRA_TYPES.has(e)) return filePath;
  if (!WORD_TYPES.has(e)) throw new Error(`Unsupported file type "${e}" — cannot print this automatically.`);

  const out = filePath.replace(/\.[^.]+$/, '') + '-converted.pdf';
  try { fs.unlinkSync(out); } catch { /* none */ }

  // 1) Microsoft Word, if installed (best fidelity)
  const wordScript = [
    "$ErrorActionPreference='Stop'",
    '$w = New-Object -ComObject Word.Application',
    '$w.Visible = $false; $w.DisplayAlerts = 0',
    'try { $d = $w.Documents.Open($env:DF_IN, $false, $true); $d.ExportAsFixedFormat($env:DF_OUT, 17); $d.Close($false) } finally { $w.Quit() }',
  ].join('\n');
  const env = { ...process.env, DF_IN: filePath, DF_OUT: out };
  let r = await runProc('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(wordScript, 'utf16le').toString('base64')], 90000, env);
  if (!r.err && fs.existsSync(out)) { logPrint(`  converted ${e} -> PDF with Microsoft Word`); return out; }
  logPrint(`  Word conversion unavailable: ${(r.stderr || (r.err && r.err.message) || '').trim().slice(0, 160)}`);

  // 2) LibreOffice
  const lo = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ].find(p => fs.existsSync(p));
  if (lo) {
    r = await runProc(lo, ['--headless', '--convert-to', 'pdf', '--outdir', path.dirname(filePath), filePath], 120000);
    const produced = filePath.replace(/\.[^.]+$/, '') + '.pdf';
    if (fs.existsSync(produced)) { logPrint(`  converted ${e} -> PDF with LibreOffice`); return produced; }
  }
  throw new Error('This is a Word file and this PC has neither Microsoft Word nor LibreOffice to convert it. Install LibreOffice (free) on the shop PC, or ask the customer to upload a PDF.');
}

const IMAGE_TYPES = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tif', '.tiff']);
function isImageExt(ext) { return IMAGE_TYPES.has((ext || '').toLowerCase()); }

// Prints a photo/scan through Windows' normal print pipeline (the same one
// Chrome uses). SumatraPDF sizes an image from its pixel size and DPI
// metadata, which on some printers/drivers gives a small clipped patch of
// the picture instead of the whole page. Here the image is simply laid out
// to fill the paper, centred and scaled to fit, and the driver gets a normal
// page-sized job.
async function printImageWindows(filePath, copies, colorMode, duplex) {
  const printerName = store.get('printerName');
  const htmlPath = filePath + '.print.html';
  const mimeOk = path.extname(filePath).toLowerCase();
  const paper = store.get('paperSize');
  const pageSize = ['A3', 'A4', 'A5', 'Legal', 'Letter'].find(n => n.toLowerCase() === String(paper).toLowerCase()) || 'A4';
  const scaling = store.get('scaling');
  const fitCss = scaling === 'noscale' ? 'object-fit:none' : scaling === 'shrink' ? 'object-fit:scale-down' : 'object-fit:contain';

  fs.writeFileSync(htmlPath,
    '<!doctype html><meta charset="utf-8"><style>' +
    `@page{size:${pageSize};margin:0}html,body{margin:0;padding:0;width:100%;height:100%;background:#fff}` +
    `img{display:block;width:100vw;height:100vh;${fitCss}}</style>` +
    `<img id="i" src="${url.pathToFileURL(filePath).href}">`);

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win.loadFile(htmlPath);
    const dims = await win.webContents.executeJavaScript(
      'new Promise(r=>{const i=document.getElementById("i");const f=()=>r([i.naturalWidth,i.naturalHeight]);(i.complete&&i.naturalWidth)?f():(i.onload=f,i.onerror=()=>r([0,0]))})');
    if (!dims[0]) throw new Error('The image could not be opened (damaged or unsupported picture file).');

    const orientation = store.get('orientation');
    const landscape = orientation === 'landscape' || (orientation !== 'portrait' && dims[0] > dims[1]);
    const color = store.get('safePrint') ? true : (store.get('colorPolicy') === 'bw' ? false : store.get('colorPolicy') === 'color' ? true : colorMode === 'color');
    const wantDuplex = !store.get('safePrint') && duplex && store.get('duplexPolicy') !== 'never';
    const opts = {
      silent: true, printBackground: true, color, landscape,
      copies: Math.max(1, parseInt(copies, 10) || 1),
      margins: { marginType: 'none' },
      pageSize,
      duplexMode: wantDuplex ? (store.get('duplexEdge') === 'short' ? 'shortEdge' : 'longEdge') : 'simplex',
    };
    if (printerName) opts.deviceName = printerName;
    logPrint(`PRINT IMAGE ${path.basename(filePath)} ${dims[0]}x${dims[1]}px via Windows print | printer="${printerName || '(Windows default)'}" | ${JSON.stringify({ ...opts, margins: undefined, deviceName: undefined })}`);

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Image print timed out - printer may be offline or the queue is stuck.')), (store.get('printTimeoutSec') || 90) * 1000);
      win.webContents.print(opts, (ok, reason) => {
        clearTimeout(t);
        logPrint(`  -> image print ${ok ? 'sent to spooler' : 'FAILED: ' + reason}`);
        ok ? resolve() : reject(new Error(`Windows print failed: ${reason || 'unknown reason'}`));
      });
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.unlink(htmlPath, () => {});
  }
}

async function postResult(cloudUrl, agentKey, code, body, tries = 4) {
  const fetch = (await import('node-fetch')).default;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${cloudUrl}/api/agent/${code}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-key': agentKey },
        body: JSON.stringify(body),
        timeout: 15000,
      });
      if (r.ok) return true;
    } catch { /* retry below */ }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return false;
}

async function downloadWithRetry(fetch, blobUrl, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(blobUrl, { timeout: 60000 });
      if (!r.ok) throw new Error(`Download failed (HTTP ${r.status})`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  throw lastErr;
}

function notify(title, body) {
  if (!store.get('notifications')) return;
  try { new Notification({ title, body, icon: assetPath('icon.ico') }).show(); } catch { /* ignore */ }
}

async function handleJob(job, cloudUrl, agentKey) {
  const fetch = (await import('node-fetch')).default;

  // Already printed on this PC, the cloud just never got the report.
  if ((store.get('printedCodes') || []).includes(job.code)) {
    logPrint(`SKIP ${job.code}: already printed here, re-sending the "printed" report only`);
    await postResult(cloudUrl, agentKey, job.code, { success: true });
    fetchShopData();
    return;
  }

  // A payment came through and a print is about to start — this is exactly
  // the moment worth a fresh heartbeat, rather than waiting on the 3-minute
  // idle fallback above.
  heartbeat();

  const ext = path.extname(job.filename) || '.pdf';
  const tempPath = path.join(os.tmpdir(), `docufast-${job.code}${ext}`);

  const jobRecord = {
    code: job.code,
    filename: job.filename,
    colorMode: job.colorMode,
    copies: job.copies,
    duplex: job.duplex,
    pages: job.pages,
    amount: job.amount || 0,
    status: 'printing',
    startedAt: new Date().toISOString(),
    printedAt: null,
    error: null,
  };

  addJobToHistory(jobRecord);
  broadcastStats();

  let printablePath = null;
  try {
    const buffer = await downloadWithRetry(fetch, job.blobUrl);
    fs.writeFileSync(tempPath, buffer);
    logPrint(`JOB ${job.code} "${job.filename}" ${buffer.length} bytes, attempt ${job.attempt || 1}, copies=${job.copies} color=${job.colorMode} duplex=${job.duplex}`);

    printablePath = await makePrintable(tempPath, ext, buffer);
    if (isImageExt(ext) && store.get('imageEngine') !== 'sumatra' && !/^\.tiff?$/i.test(ext)) {
      await printImageWindows(printablePath, job.copies, job.colorMode, job.duplex);
    } else {
      await printFile(printablePath, job.copies, job.colorMode, job.duplex);
    }
    rememberPrinted(job.code);

    const reported = await postResult(cloudUrl, agentKey, job.code, { success: true });
    if (!reported) logPrint(`  -> printed ${job.code} but could not report it to the server yet; it will be re-reported on the next poll`);
    else forgetPrinted(job.code); // server knows now; keeps the guard from blocking a later Reprint

    jobRecord.status = 'printed';
    jobRecord.printedAt = new Date().toISOString();
    stats.pending = Math.max(0, stats.pending - 1);
    fetchShopData(); // pulls the real amount + updates jobsToday/revenueToday right away
    heartbeat();
    notify('DocuFast — Printed', `${job.filename} printed successfully`);
  } catch (err) {
    jobRecord.status = 'failed';
    jobRecord.error = err.message;
    logPrint(`FAILED ${job.code}: ${err.message}`);
    // The server now holds a failed job until the shop presses Retry, so a
    // broken printer can't loop on the same file.
    await postResult(cloudUrl, agentKey, job.code, { success: false, error: err.message }, 2);
    heartbeat();
    notify('DocuFast — Print Failed', `${job.filename}: ${err.message}`);
  } finally {
    fs.unlink(tempPath, () => {});
    if (printablePath && printablePath !== tempPath) fs.unlink(printablePath, () => {});
    updateJobInHistory(jobRecord);
    broadcastStats();
  }
}

// Tries the shop's saved Sumatra path first, then falls back to common
// install locations. The hardcoded default (a specific "ADMIN" user's
// AppData folder, set in the store schema above) only ever worked on the
// one PC it was written for — on any shop PC with a different Windows
// username, fs.existsSync() on that path is always false, silently
// downgrading every job to the far less reliable shell-verb print path.
function resolveSumatraPath() {
  const stored = store.get('sumatraPath');
  if (stored && fs.existsSync(stored)) return stored;

  const candidates = [
    path.join(os.homedir(), 'AppData', 'Local', 'SumatraPDF', 'SumatraPDF.exe'),
    'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
    'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

// ---- Print log ----
// "It printed a tiny block and ejected" is impossible to diagnose without
// knowing exactly what was sent to the printer. Every print appends a few
// lines here: the printer + driver, the exact SumatraPDF settings, and the
// exit code. Rotates at ~1MB so it can never grow without bound.
function getLogDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function logPrint(message) {
  try {
    const dir = getLogDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'print.log');
    try {
      if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, path.join(dir, 'print.old.log'));
    } catch { /* log file doesn't exist yet */ }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
  } catch { /* logging must never be able to break printing */ }
}

// ---- Printer capability lookup ----
// Different printers have very different drivers. Forcing a setting the
// driver doesn't support (duplex on a single-sided printer, colour on a
// mono one) is harmless on well-behaved drivers but makes cheap host-based /
// GDI-only drivers produce garbage — typically a small block in a corner,
// then the page ejects. So we ask Windows what this printer actually
// supports and only send settings it can honour.
const UNKNOWN_PRINTER = { known: false, name: null, driver: null, color: null, duplex: null, papers: [] };
const printerInfoCache = new Map(); // printerName ('' = Windows default) -> { at, info }
const PRINTER_INFO_TTL_MS = 10 * 60 * 1000;

function queryPrinterInfo(printerName) {
  const cached = printerInfoCache.get(printerName);
  if (cached && Date.now() - cached.at < PRINTER_INFO_TTL_MS) return Promise.resolve(cached.info);

  return new Promise(resolve => {
    const { execFile } = require('child_process');
    // Passed via -EncodedCommand and an env var so printer names with quotes
    // or spaces can never break the script.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$all = Get-CimInstance Win32_Printer',
      "if ($env:DF_PRINTER) { $p = $all | Where-Object { $_.Name -eq $env:DF_PRINTER } | Select-Object -First 1 }",
      'else { $p = $all | Where-Object { $_.Default } | Select-Object -First 1 }',
      "if ($p) { @{ name = $p.Name; driver = $p.DriverName; caps = @($p.Capabilities); papers = @($p.PrinterPaperNames) } | ConvertTo-Json -Compress } else { '{}' }",
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 8000, env: { ...process.env, DF_PRINTER: printerName || '' } },
      (err, stdout) => {
        let info = UNKNOWN_PRINTER;
        if (!err) {
          try {
            const raw = JSON.parse(String(stdout).trim() || '{}');
            const list = v => (Array.isArray(v) ? v : [v]);
            const caps = list(raw.caps).filter(x => typeof x === 'number');
            const papers = list(raw.papers).filter(x => typeof x === 'string');
            info = {
              known: !!raw.name,
              name: raw.name || null,
              driver: raw.driver || null,
              // Win32_Printer.Capabilities: 2 = Color, 3 = Duplex. An empty
              // list means the driver didn't say — null ("unknown"), not
              // false ("unsupported").
              color: caps.length ? caps.includes(2) : null,
              duplex: caps.length ? caps.includes(3) : null,
              papers,
            };
          } catch { /* unparseable output — treat as unknown */ }
        }
        printerInfoCache.set(printerName, { at: Date.now(), info });
        resolve(info);
      }
    );
  });
}

// Builds the SumatraPDF -print-settings string for THIS printer, from the
// shop's Print preferences plus what the customer chose.
//  - 'fit' (default) scales every page to the printable area — this is what
//    stops pages coming out as a small block on odd drivers.
//  - Colour/duplex are only sent when the printer isn't known to lack them.
//  - Paper size is only forced when the shop picked one; 'auto' leaves the
//    printer's own default alone.
//  - Safe mode sends nothing but copies + scaling.
async function buildPrintSettings({ printerName, copies, colorMode, duplex }) {
  const info = await queryPrinterInfo(printerName);
  const parts = [`${Math.max(1, parseInt(copies, 10) || 1)}x`];
  const notes = [];

  parts.push(store.get('scaling') || 'fit');

  if (store.get('safePrint')) {
    notes.push('safe print mode on: only copies + scaling sent');
    return { settings: parts.join(','), info, notes };
  }

  const orientation = store.get('orientation');
  if (orientation === 'portrait' || orientation === 'landscape') parts.push(orientation);

  const policy = store.get('colorPolicy');
  const effectiveColor = policy === 'bw' ? 'bw' : policy === 'color' ? 'color' : colorMode;
  if (effectiveColor === 'color') {
    if (info.color === false) notes.push('printer reports no colour support, colour flag skipped');
    else parts.push('color');
  } else {
    parts.push('monochrome');
  }

  const wantDuplex = duplex && store.get('duplexPolicy') !== 'never';
  if (duplex && !wantDuplex) notes.push('duplex disabled in settings, printing single-sided');
  if (wantDuplex) {
    if (info.duplex === false) notes.push('printer reports no duplex support, printing single-sided');
    else parts.push(store.get('duplexEdge') === 'short' ? 'duplexshort' : 'duplexlong');
  }

  const paper = store.get('paperSize');
  if (paper && paper !== 'auto') {
    const listed = info.papers.length === 0 ||
      info.papers.some(n => n.toUpperCase().startsWith(paper.toUpperCase()));
    if (listed) parts.push(`paper=${paper}`);
    else notes.push(`printer doesn't list ${paper}, paper size left to the printer default`);
  }

  const bin = store.get('trayBin');
  if (bin > 0) parts.push(`bin=${bin}`);

  return { settings: parts.join(','), info, notes };
}

async function printFile(filePath, copies, colorMode, duplex) {
  const sumatraPath = resolveSumatraPath();
  const printerName = store.get('printerName');

  let settings = null;
  if (sumatraPath) {
    const built = await buildPrintSettings({ printerName, copies, colorMode, duplex });
    settings = built.settings;
    logPrint(
      `PRINT ${path.basename(filePath)} | printer="${printerName || '(Windows default)'}"` +
      ` resolved="${built.info.name || '?'}" driver="${built.info.driver || '?'}"` +
      ` | colorSupport=${built.info.color} duplexSupport=${built.info.duplex}` +
      ` | paperNames=${built.info.papers.slice(0, 6).join('/') || '?'}` +
      ` | settings="${settings}"` +
      (built.notes.length ? ` | notes: ${built.notes.join('; ')}` : '')
    );
  } else {
    logPrint(`PRINT ${path.basename(filePath)} | SumatraPDF not found, using the Windows shell print fallback (printer selection and options are NOT applied)`);
  }

  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const useSumatra = !!sumatraPath;
    let cmd, args;

    if (useSumatra) {
      cmd = sumatraPath;
      args = printerName
        ? [filePath, '-print-to', printerName, '-silent', '-print-settings', settings]
        : [filePath, '-print-to-default', '-silent', '-print-settings', settings];
    } else {
      // -Wait is essential: without it, PowerShell hands the file to the
      // registered "Print" handler and exits immediately, so this promise
      // used to resolve before anything had actually printed (or failed).
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-Command',
        `Start-Process -FilePath '${filePath.replace(/'/g, "''")}' -Verb Print -Wait`];
    }

    let stderr = '';
    let settled = false;
    const timeoutMs = (store.get('printTimeoutSec') || 90) * 1000;
    const child = spawn(cmd, args, { windowsHide: true });
    if (child.stderr) child.stderr.on('data', d => (stderr += d));

    // Safety ceiling for a genuinely stuck printer/spooler, NOT a
    // substitute for waiting on real completion (that's the bug this
    // replaces). A job progressing normally resolves via 'close' well
    // before this fires.
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      logPrint(`  -> TIMEOUT after ${timeoutMs / 1000}s (${path.basename(filePath)})`);
      reject(new Error(`Print process timed out after ${timeoutMs / 1000}s — printer may be offline or the queue is stuck.`));
    }, timeoutMs);

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      logPrint(`  -> FAILED TO START: ${err.message}`);
      reject(new Error(`Print process failed to start: ${err.message}`));
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      logPrint(`  -> exit code ${code}${stderr.trim() ? ` stderr: ${stderr.trim()}` : ''}`);
      if (code === 0 || code === null) {
        resolve(settings);
      } else {
        reject(new Error(`Printer process exited with code ${code}: ${stderr.trim() || '(no error output)'}`));
      }
    });
  });
}

// ---- Job history ----
function addJobToHistory(job) {
  // A retried/reprinted job comes back with the same code: replace its old row.
  stats.recentJobs = stats.recentJobs.filter(j => j.code !== job.code);
  stats.recentJobs.unshift({ ...job });
  if (stats.recentJobs.length > 50) stats.recentJobs.pop();
}

function updateJobInHistory(job) {
  const idx = stats.recentJobs.findIndex(j => j.code === job.code);
  if (idx !== -1) stats.recentJobs[idx] = { ...job };
}

function broadcastStats() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('stats-update', { ...stats });
  }
}

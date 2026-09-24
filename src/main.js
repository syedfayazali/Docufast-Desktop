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

const Store = require('electron-store');
const store = new Store({
  schema: {
    agentKey:    { type: 'string', default: '' },
    sumatraPath: { type: 'string', default: 'C:\\Users\\ADMIN\\AppData\\Local\\SumatraPDF\\SumatraPDF.exe' },
    printerName: { type: 'string', default: '' },
    autoLaunch:  { type: 'boolean', default: true },
    pollMs:      { type: 'number', default: 10000 },
    setupDone:   { type: 'boolean', default: false },
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
};

// ---- App lifecycle ----
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
  const statusLabel = stats.duplicateKey ? '⚠ Duplicate key' : (connected ? `● Connected` : `○ Disconnected`);
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
    { label: 'Open dashboard', click: () => openDashboard() },
    { label: 'Settings', click: () => openDashboard('setup') },
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
    width: 900,
    height: 640,
    minWidth: 720,
    minHeight: 500,
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
ipcMain.handle('get-config', () => ({ ...store.store, cloudUrl: CLOUD_URL }));
ipcMain.handle('save-config', (_, config) => {
  // Never save cloudUrl — it's always the baked-in constant
  const { cloudUrl, ...rest } = config;
  Object.entries(rest).forEach(([k, v]) => store.set(k, v));
  app.setLoginItemSettings({ openAtLogin: config.autoLaunch ?? store.get('autoLaunch') });
  if (config.agentKey) {
    store.set('setupDone', true);
    startAgent(); // start the agent now that we have a key
  }
  restartAgent();
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
ipcMain.handle('retry-job', async (_, code) => {
  const agentKey = store.get('agentKey');
  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`${CLOUD_URL}/api/admin/jobs/${encodeURIComponent(code)}/retry`, {
      method: 'POST',
      headers: { 'x-agent-key': agentKey },
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return { ok: false, error: d?.error || `Retry failed (${res.status})` };
    }
    fetchShopData(); // pull the updated status right away instead of waiting up to 30s
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
function startAgent() {
  if (pollTimer) clearInterval(pollTimer);
  agentRunning = true;
  pollOnce();
  fetchShopData();
  pollTimer = setInterval(pollOnce, store.get('pollMs'));
  heartbeat();
  // Heartbeat and shop-data used to run on constant 15s/30s timers
  // regardless of activity — most of that was wasted calls while a shop
  // sits idle between customers. Both now fire immediately around actual
  // work (see handleJob below) and only fall back to a periodic call here
  // to keep "online" status from going stale during long idle stretches.
  setInterval(heartbeat, 180000);     // idle fallback: every 3 min
  setInterval(fetchShopData, 180000); // idle fallback: every 3 min
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

    for (const job of data.jobs) {
      await handleJob(job, CLOUD_URL, agentKey);
    }
  } catch {
    stats.connected = false;
    updateTrayMenu();
  } finally {
    isPolling = false;
  }
  broadcastStats();
}

async function handleJob(job, cloudUrl, agentKey) {
  const fetch = (await import('node-fetch')).default;
  const { spawn } = require('child_process');
  const os = require('os');

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
    amount: 0,
    status: 'printing',
    startedAt: new Date().toISOString(),
    printedAt: null,
    error: null,
  };

  addJobToHistory(jobRecord);
  broadcastStats();

  try {
    // Download file
    const fileRes = await fetch(job.blobUrl);
    if (!fileRes.ok) throw new Error(`Download failed (HTTP ${fileRes.status})`);
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    fs.writeFileSync(tempPath, buffer);

    // Print
    await printFile(tempPath, job.copies, job.colorMode, job.duplex);

    // Report success
    await fetch(`${cloudUrl}/api/agent/${job.code}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-key': agentKey },
      body: JSON.stringify({ success: true }),
    });

    jobRecord.status = 'printed';
    jobRecord.printedAt = new Date().toISOString();
    stats.pending = Math.max(0, stats.pending - 1);
    fetchShopData(); // pulls the real amount + updates jobsToday/revenueToday right away
    heartbeat(); // job's done — refresh presence once more before going idle

    // Windows notification
    new Notification({
      title: 'DocuFast — Printed',
      body: `${job.filename} printed successfully`,
      icon: assetPath('icon.ico'),
    }).show();

  } catch (err) {
    jobRecord.status = 'failed';
    jobRecord.error = err.message;

    await fetch(`${cloudUrl}/api/agent/${job.code}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-key': agentKey },
      body: JSON.stringify({ success: false, error: err.message }),
    }).catch(() => {});
    heartbeat(); // still worth refreshing presence even on a failed print

    new Notification({
      title: 'DocuFast — Print Failed',
      body: `${job.filename}: ${err.message}`,
    }).show();
  } finally {
    fs.unlink(tempPath, () => {});
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

function printFile(filePath, copies, colorMode, duplex) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const sumatraPath = resolveSumatraPath();
    const useSumatra = !!sumatraPath;
    let cmd, args;

    if (useSumatra) {
      const colorSetting = colorMode === 'color' ? 'color' : 'monochrome';
      const duplexSetting = duplex ? 'duplex' : 'simplex';
      const settings = `${copies}x,${colorSetting},${duplexSetting}`;
      const printerName = store.get('printerName');

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
      reject(new Error('Print process timed out after 60s — printer may be offline or the queue is stuck.'));
    }, 60000);

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Print process failed to start: ${err.message}`));
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`Printer process exited with code ${code}: ${stderr.trim() || '(no error output)'}`));
      }
    });
  });
}

// ---- Job history ----
function addJobToHistory(job) {
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

// Dashboard renderer — talks to the main process only through window.docufast (preload bridge).

let currentStats = { recentJobs: [], jobsToday: 0, revenueToday: 0, pending: 0, connected: false, paused: false };
let currentTab = 'dashboard';
let dirty = false;
let savedConfig = {};

const $ = id => document.getElementById(id);
const val = id => $(id).value;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

async function init() {
  const logoUrl = await window.docufast.getAssetUrl('logo.png');
  if (logoUrl) $('brandLogoImg').src = logoUrl; else $('brandLogoImg').dispatchEvent(new Event('error'));

  await loadSettings();
  applyStats(await window.docufast.getStats());
  window.docufast.onStatsUpdate(applyStats);
  window.docufast.onNavigate(switchTab);
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'jobs') renderJobsTab();
  if (tab === 'setup' && !dirty) { loadPrinterOptions(val('cfgPrinterName')); refreshPreview(); }
}

/* ================= Stats / dashboard ================= */
function applyStats(stats) {
  currentStats = stats;
  const dot = $('statusDot'), lbl = $('statusLabel');
  if (stats.duplicateKey) { dot.className = 'status-dot disconnected'; lbl.textContent = 'Key in use on another PC'; }
  else if (stats.paused) { dot.className = 'status-dot paused'; lbl.textContent = 'Paused'; }
  else if (stats.connected) { dot.className = 'status-dot connected'; lbl.textContent = 'Connected'; }
  else { dot.className = 'status-dot disconnected'; lbl.textContent = 'Disconnected'; }

  $('kpiJobsToday').textContent = stats.jobsToday;
  $('kpiRevenue').textContent = '₹' + ((stats.revenueToday || 0) / 100).toFixed(2);
  $('kpiPending').textContent = stats.pending;
  if ($('pushState')) $('pushState').textContent = { connected: 'Status: connected', connecting: 'Status: connecting…', down: 'Status: down (using regular checks)', off: 'Status: off' }[stats.push] || '';
  $('kpiPrinter').textContent = stats.duplicateKey ? 'Blocked' : stats.paused ? 'Paused' : stats.connected ? 'Online' : 'Offline';

  if (stats.shopName) { $('shopNameBadge').textContent = stats.shopName; $('brandShop').textContent = stats.shopName; }
  $('lastPoll').textContent = stats.lastPoll ? 'Last check ' + fmtTime(new Date(stats.lastPoll)) : '';

  $('pauseBtn').textContent = stats.paused ? 'Resume printing' : 'Pause printing';
  $('pauseBtn').classList.toggle('primary', !!stats.paused);
  $('pausedBanner').style.display = stats.paused ? 'flex' : 'none';

  const failed = (stats.recentJobs || []).filter(j => j.status === 'failed').length;
  $('failedBanner').style.display = failed ? 'flex' : 'none';
  $('failedCount').textContent = failed;
  $('navFailedBadge').style.display = failed ? 'inline-block' : 'none';
  $('navFailedBadge').textContent = failed;
  $('retryAllBtn').style.display = failed ? 'inline-block' : 'none';

  $('dupBanner').style.display = stats.duplicateKey ? 'flex' : 'none';
  $('dupBanner').textContent = stats.duplicateMessage || '';

  renderDashJobs(stats.recentJobs || []);
  if (currentTab === 'jobs') renderJobsTab();
}

async function togglePause() {
  await window.docufast.setPaused(!currentStats.paused);
}

function typeLabel(j) { return (j.colorMode === 'color' ? 'Colour' : 'B&W') + (j.duplex ? ' · Duplex' : ''); }

function renderDashJobs(jobs) {
  const rows = jobs.slice(0, 8);
  $('dashJobRows').innerHTML = rows.length ? rows.map(j => `
    <tr>
      <td class="code-cell">${esc(j.code)}</td>
      <td class="filename-cell" title="${esc(j.filename)}">${esc(j.filename)}</td>
      <td>${typeLabel(j)}</td>
      <td class="ts-cell">${j.startedAt ? fmtDatetime(new Date(j.startedAt)) : '—'}</td>
      <td class="ts-cell">${j.printedAt ? fmtDatetime(new Date(j.printedAt)) : '—'}</td>
      <td>${pillHTML(j)}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty-cell">No jobs yet</td></tr>';
}

function renderJobsTab() {
  const filter = $('statusFilter').value;
  const q = $('jobSearch').value.trim().toLowerCase();
  const jobs = (currentStats.recentJobs || []).filter(j =>
    (!filter || j.status === filter) &&
    (!q || (j.code || '').toLowerCase().includes(q) || (j.filename || '').toLowerCase().includes(q)));

  $('jobsTabRows').innerHTML = jobs.length ? jobs.map(j => `
    <tr>
      <td class="code-cell">${esc(j.code)}</td>
      <td class="filename-cell" title="${esc(j.filename)}">${esc(j.filename)}</td>
      <td>${j.pages || '?'} × ${j.copies}</td>
      <td>${typeLabel(j)}</td>
      <td class="ts-cell">${j.startedAt ? fmtDatetime(new Date(j.startedAt)) : '—'}</td>
      <td class="ts-cell">${j.printedAt ? fmtDatetime(new Date(j.printedAt)) : '—'}</td>
      <td>${pillHTML(j)}${j.error ? `<div class="err-line" title="${esc(j.error)}">${esc(j.error)}</div>` : ''}</td>
      <td>${j.status === 'failed' ? `<button class="btn sm" onclick="retryJob('${esc(j.code)}', this)">Retry</button>` : canReprint(j) ? `<button class="btn sm" title="Print this order again (available for 30 minutes after printing)" onclick="retryJob('${esc(j.code)}', this, true)">Reprint</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty-cell">No jobs match</td></tr>';
}

function canReprint(j) {
  return j.status === 'printed' && j.printedAt && (Date.now() - new Date(j.printedAt).getTime()) < 30 * 60 * 1000;
}
async function retryJob(code, btn, reprint) {
  const label = reprint ? 'Reprint' : 'Retry';
  btn.disabled = true; btn.textContent = reprint ? 'Reprinting…' : 'Retrying…';
  const r = await window.docufast.retryJob(code, !!reprint);
  if (!r.ok) { btn.disabled = false; btn.textContent = label; btn.title = r.error; btn.style.color = '#B3261E'; alert(r.error); return; }
  btn.textContent = 'Queued ✓';
}
async function retryAllFailed() {
  const failed = (currentStats.recentJobs || []).filter(j => j.status === 'failed');
  for (const j of failed) await window.docufast.retryJob(j.code);
}

/* ================= Settings ================= */
const FIELDS = {
  agentKey: ['cfgAgentKey', 'text'], sumatraPath: ['cfgSumatraPath', 'text'], printerName: ['cfgPrinterName', 'text'],
  paperSize: ['cfgPaperSize', 'text'], scaling: ['cfgScaling', 'text'], orientation: ['cfgOrientation', 'text'],
  colorPolicy: ['cfgColorPolicy', 'text'], duplexPolicy: ['cfgDuplexPolicy', 'text'], duplexEdge: ['cfgDuplexEdge', 'text'],
  trayBin: ['cfgTrayBin', 'num'], livePush: ['cfgLivePush', 'bool'], imageEngine: ['cfgImageEngine', 'text'], safePrint: ['cfgSafePrint', 'bool'], autoLaunch: ['cfgAutoLaunch', 'bool'],
  notifications: ['cfgNotifications', 'bool'],
};

function readForm() {
  const c = {};
  for (const [k, [id, type]] of Object.entries(FIELDS)) {
    const el = $(id);
    c[k] = type === 'bool' ? el.checked : type === 'num' ? Math.max(0, parseInt(el.value, 10) || 0) : el.value.trim();
  }
  c.pollMs = Math.max(3, Math.min(60, parseInt(val('cfgPollMs'), 10) || 10)) * 1000;
  c.printTimeoutSec = Math.max(20, Math.min(600, parseInt(val('cfgPrintTimeout'), 10) || 90));
  return c;
}

async function loadSettings() {
  const c = savedConfig = await window.docufast.getConfig();
  for (const [k, [id, type]] of Object.entries(FIELDS)) {
    if (k === 'printerName') continue;
    const el = $(id);
    if (type === 'bool') el.checked = k === 'autoLaunch' || k === 'notifications' ? c[k] !== false : !!c[k];
    else el.value = c[k] ?? '';
  }
  $('cfgPollMs').value = Math.round((c.pollMs || 10000) / 1000);
  $('cfgPrintTimeout').value = c.printTimeoutSec || 90;
  $('appVer').textContent = 'v' + (c.appVersion || '');
  await loadPrinterOptions(c.printerName || '');
  setDirty(false);
  refreshPreview();
}

async function loadPrinterOptions(selected) {
  const sel = $('cfgPrinterName');
  const printers = await window.docufast.getPrinters();
  sel.innerHTML = '<option value="">Windows default printer</option>' +
    printers.map(p => `<option value="${esc(p.name)}">${esc(p.name)}${p.isDefault ? ' (default)' : ''}</option>`).join('');
  if (selected && ![...sel.options].some(o => o.value === selected)) {
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(selected)}">${esc(selected)} (not detected right now)</option>`);
  }
  sel.value = selected || '';
  showPrinterInfo();
}

async function showPrinterInfo() {
  const box = $('printerInfo');
  box.textContent = 'Asking Windows about this printer…';
  const i = await window.docufast.getPrinterInfo(val('cfgPrinterName'));
  if (!i || !i.known) { box.textContent = 'Windows did not return details for this printer (it may be offline). Printing can still work.'; return; }
  const yn = v => v === null ? 'unknown' : v ? 'yes' : 'no';
  box.innerHTML = `<b>${esc(i.name)}</b><br>Driver: ${esc(i.driver || 'unknown')}<br>Colour: ${yn(i.color)} &nbsp;·&nbsp; Double-sided: ${yn(i.duplex)}` +
    (i.papers?.length ? `<br>Paper sizes: ${esc(i.papers.slice(0, 8).join(', '))}${i.papers.length > 8 ? '…' : ''}` : '');
}

function onPrinterChange() { markDirty(); showPrinterInfo(); }

function markDirty() { setDirty(true); refreshPreview(); }
function setDirty(d) {
  dirty = d;
  $('saveBtn').disabled = !d; $('discardBtn').disabled = !d;
  $('dirtyMsg').textContent = d ? 'You have unsaved changes' : 'All changes saved';
  $('saveBar').classList.toggle('dirty', d);
}

let previewTimer = null;
function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const r = await window.docufast.previewSettings(readForm());
      $('prevBw').textContent = 'Black & white job:  ' + r.bw;
      $('prevColor').textContent = 'Colour + duplex job:  ' + r.color;
      $('prevNotes').textContent = r.notes.length ? 'Note: ' + r.notes.join(' · ') : '';
    } catch { $('prevBw').textContent = '—'; }
  }, 250);
}

async function saveSettings() {
  const c = readForm();
  if (!c.agentKey) { alert('The shop key cannot be empty.'); return; }
  await window.docufast.saveConfig(c);
  savedConfig = await window.docufast.getConfig();
  setDirty(false);
  $('dirtyMsg').textContent = '✓ Saved — agent restarted';
  setTimeout(() => { if (!dirty) $('dirtyMsg').textContent = 'All changes saved'; }, 3000);
}

function toggleKey() {
  const el = $('cfgAgentKey'); el.type = el.type === 'password' ? 'text' : 'password';
}

async function detectSumatra() {
  const p = await window.docufast.detectSumatra();
  const m = $('sumatraMsg');
  if (p) { $('cfgSumatraPath').value = p; markDirty(); m.textContent = '✓ Found SumatraPDF.'; m.style.color = '#1F7A4D'; }
  else { m.textContent = 'SumatraPDF was not found on this PC. Install it (run the DocuFast installer script) and try again.'; m.style.color = '#B3261E'; }
}

async function runTestPrint() {
  if (dirty && !confirm('You have unsaved changes. The test page uses your SAVED settings. Print anyway?')) return;
  const b = $('testPrintBtn'), m = $('testMsg');
  b.disabled = true; m.className = 'inline-msg'; m.textContent = 'Sending…';
  const r = await window.docufast.testPrint();
  b.disabled = false;
  if (r.ok) { m.className = 'inline-msg ok'; m.textContent = '✓ Sent to printer (' + r.settings + ')'; }
  else { m.className = 'inline-msg bad'; m.textContent = r.error; }
}

async function loadLog() {
  const box = $('logBox'); box.style.display = 'block';
  box.textContent = await window.docufast.getLogTail(60);
  box.scrollTop = box.scrollHeight;
}
async function copyLog() {
  const t = await window.docufast.getLogTail(80);
  try { await navigator.clipboard.writeText(t); $('updMsg').textContent = 'Log copied ✓'; }
  catch { await loadLog(); $('updMsg').textContent = 'Select the log text and copy it manually.'; }
}
async function checkUpdates() {
  $('updMsg').textContent = 'Checking…';
  const r = await window.docufast.checkUpdates();
  $('updMsg').textContent = r.message;
}

/* ================= Helpers ================= */
function pillHTML(j) {
  if (j.status === 'printed') return '<span class="pill printed">Printed</span>';
  if (j.status === 'printing') return '<span class="pill printing">Printing…</span>';
  if (j.status === 'failed') return '<span class="pill failed">Failed</span>';
  return '<span class="pill pending">Waiting</span>';
}
function fmtDatetime(d) {
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return `${d.getDate()} ${mon}, ${fmtTime(d)}`;
}
function fmtTime(d) {
  const h = d.getHours() % 12 || 12, m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
}

init();

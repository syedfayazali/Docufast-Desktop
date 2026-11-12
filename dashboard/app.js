// DocuFast desktop app — renderer. Talks to the main process only through window.docufast (preload bridge).

let currentStats = { recentJobs: [], jobsToday: 0, revenueToday: 0, pending: 0, connected: false, paused: false };
let currentTab = 'dashboard';
let dirty = false;
let savedConfig = {};
let plansInfo = null;

const $ = id => document.getElementById(id);
const val = id => $(id).value;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const PAGES = {
  dashboard: ['Home', 'Everything about your shop at a glance'],
  jobs: ['Orders', 'Every order this computer has printed or is waiting to print'],
  shop: ['Shop & earnings', 'Orders, reports, prices and plan for your shop'],
  setup: ['Printer & settings', 'Changes apply to the next order'],
  account: ['Account & plan', 'Your sign-in, plan and this computer'],
  help: ['Help & support', 'Answers, updates and how to reach us'],
};

async function init() {
  const logoUrl = await window.docufast.getAssetUrl('logo-icon.png');
  if (logoUrl) $('brandLogoImg').src = logoUrl; else $('brandLogoImg').dispatchEvent(new Event('error'));

  await loadSettings();
  $('needGo').onclick = () => { $('needModal').style.display = 'none'; window.docufast.openSubscribe(); };
  $('needNo').onclick = () => { $('needModal').style.display = 'none'; };
  $('subTabs').onclick = e => { const b = e.target.closest('button'); if (b) showSub(b.dataset.sub); };
  $('shopFrame').addEventListener('load', () => $('shopLoad').classList.add('hide'));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDrawer(); $('needModal').style.display = 'none'; } });
  plansInfo = await window.docufast.getPlans();
  applyStats(await window.docufast.getStats());
  paintAccount(await window.docufast.accountInfo());
  switchTab('dashboard');
  renderSetup(); renderPlanTiles();
  window.docufast.onStatsUpdate(applyStats);
  window.docufast.onNavigate(switchTab);
  if (savedConfig.signedIn) { const kf = $('cfgAgentKey').closest('.field'); if (kf) kf.style.display = 'none'; }
}

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.style.display = 'none'; }, 2600);
}

function switchTab(tab) {
  if (!PAGES[tab]) tab = 'dashboard';
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('pageTitle').textContent = PAGES[tab][0];
  $('pageSub').textContent = tab === 'dashboard' && currentStats.lastPoll ? 'Last check ' + fmtTime(new Date(currentStats.lastPoll)) : PAGES[tab][1];
  $('scroll').scrollTop = 0;
  if (tab === 'jobs') renderJobsTab();
  if (tab === 'shop') {
    const ok = hasPlan();
    $('shopLocked').style.display = ok ? 'none' : 'block'; $('shopWrap').style.display = ok ? 'flex' : 'none';
    const f = $('shopFrame'); if (ok && !f.src && savedConfig.cloudUrl) { $('shopLoad').classList.remove('hide'); f.src = savedConfig.cloudUrl + '/admin.html?app=1'; }
  }
  if (tab === 'account') renderAccount();
  if (tab === 'help') renderHelp();
  renderSetup();
  if (tab === 'setup' && !dirty) { loadPrinterOptions(val('cfgPrinterName')); refreshPreview(); }
}
function showSub(name) {
  document.querySelectorAll('#subTabs button').forEach(b => b.classList.toggle('on', b.dataset.sub === name));
  document.querySelectorAll('.sub-pane').forEach(p => p.classList.toggle('on', p.dataset.pane === name));
}

/* ================= Stats / home ================= */
function applyStats(stats) {
  if (stats && stats.account !== undefined) paintAccount(stats.account);
  currentStats = stats;
  renderSetup();
  const dot = $('statusDot'), lbl = $('statusLabel');
  const plan = hasPlan();
  let pill, cls;
  if (!plan) { pill = 'Not set up yet'; cls = 'paused'; }
  else if (stats.duplicateKey) { pill = 'Key in use on another PC'; cls = 'disconnected'; }
  else if (stats.paused) { pill = 'Printing paused'; cls = 'paused'; }
  else if (stats.connected) { pill = 'Connected'; cls = 'connected'; }
  else { pill = 'Disconnected'; cls = 'disconnected'; }
  dot.className = 'status-dot ' + cls; lbl.textContent = pill;

  $('kpiJobsToday').textContent = stats.jobsToday;
  $('kpiRevenue').textContent = '₹' + ((stats.revenueToday || 0) / 100).toFixed(2);
  $('kpiPending').textContent = stats.pending;
  if ($('pushState')) $('pushState').textContent = { connected: 'Status: connected', connecting: 'Status: connecting…', down: 'Status: down (using regular checks)', off: 'Status: off' }[stats.push] || '';
  $('kpiPrinter').textContent = !plan ? 'Not set up' : stats.duplicateKey ? 'Blocked' : stats.paused ? 'Paused' : stats.connected ? 'Online' : 'Offline';

  if (stats.shopName) { $('brandShop').textContent = stats.shopName; $('shopAv').textContent = stats.shopName.trim().charAt(0).toUpperCase() || 'D'; }
  const city = stats.account && stats.account.shop && stats.account.shop.city;
  $('brandCity').textContent = plan ? (city || 'Shop active') : 'Not set up yet';
  if (currentTab === 'dashboard') $('pageSub').textContent = stats.lastPoll ? 'Last check ' + fmtTime(new Date(stats.lastPoll)) : PAGES.dashboard[1];

  $('pauseBtn').querySelector('span').textContent = stats.paused ? 'Resume printing' : 'Pause printing';
  $('pauseBtn').querySelector('use').setAttribute('href', stats.paused ? '#i-play' : '#i-pause');
  $('pauseBtn').classList.toggle('primary', !!stats.paused);
  $('pauseBtn').style.display = plan ? '' : 'none';
  $('pausedBanner').style.display = stats.paused ? 'flex' : 'none';

  const failed = (stats.recentJobs || []).filter(j => j.status === 'failed').length;
  $('failedBanner').style.display = failed ? 'flex' : 'none';
  $('failedCount').textContent = failed;
  $('navFailedBadge').style.display = failed ? 'inline-block' : 'none';
  $('navFailedBadge').textContent = failed;
  $('retryAllBtn').style.display = failed ? 'inline-flex' : 'none';

  $('dupBanner').style.display = stats.duplicateKey ? 'flex' : 'none';
  $('dupBanner').textContent = stats.duplicateMessage || '';

  const pn = savedConfig.printerName;
  $('homePrinter').textContent = !plan ? 'Not chosen yet' : (pn || 'Windows default printer');
  $('homePrinterSub').textContent = !plan ? 'Start your trial, then pick the printer orders should print on.' : (stats.connected ? 'Ready. Orders print here automatically.' : 'Waiting for a connection…');
  const chip = $('homePrinterChip'); chip.textContent = !plan ? 'Not set up' : stats.paused ? 'Paused' : stats.connected ? 'Online' : 'Offline';
  chip.className = 'chip ' + (!plan ? '' : stats.paused ? 'warn' : stats.connected ? 'ok' : 'err');

  paintHero();
  renderDashJobs(stats.recentJobs || []);
  if (currentTab === 'jobs') renderJobsTab();
}

function paintHero() {
  const plan = hasPlan(), s = currentStats || {}, h = new Date().getHours();
  $('heroHi').textContent = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const acts = $('heroActions');
  if (!plan) {
    $('heroTitle').textContent = 'Welcome to DocuFast';
    $('heroSub').textContent = 'Customers scan your QR, upload and pay by UPI, and the order prints on your printer. Look around, then start your free trial when you are ready.';
    acts.innerHTML = '<button class="btn gold" onclick="window.docufast.openSubscribe()">Start free 7-day trial</button>';
  } else {
    $('heroTitle').textContent = s.shopName || 'Your shop';
    $('heroSub').textContent = s.paused ? 'Printing is paused. Resume when you are ready for orders.' : s.connected ? 'You are online. New paid orders print automatically.' : 'Connecting to DocuFast…';
    acts.innerHTML = `<button class="btn" onclick="togglePause()">${s.paused ? 'Resume printing' : 'Pause printing'}</button><button class="btn" onclick="runTestPrintHome()">Print test page</button><button class="btn gold" onclick="openPoster()">Open QR poster</button><button class="btn" onclick="openPoster('counter')">Counter poster 10×20 cm</button>`;
  }
  $('topCta').style.display = plan ? 'none' : '';
}

async function togglePause() {
  if (need('Pausing and resuming printing needs your shop to be set up first.')) return;
  await window.docufast.setPaused(!currentStats.paused);
}

function typeLabel(j) { return (j.colorMode === 'color' ? 'Colour' : 'B&W') + (j.duplex ? ' · Duplex' : ''); }

function renderDashJobs(jobs) {
  const rows = jobs.slice(0, 8);
  $('dashJobRows').innerHTML = rows.length ? rows.map(j => `
    <tr data-code="${esc(j.code)}" style="cursor:pointer" onclick="openDrawer('${esc(j.code)}')">
      <td class="code-cell">${esc(j.code)}</td>
      <td class="filename-cell" title="${esc(j.filename)}">${esc(j.filename)}</td>
      <td>${typeLabel(j)}</td>
      <td class="ts-cell">${j.startedAt ? fmtDatetime(new Date(j.startedAt)) : '—'}</td>
      <td class="ts-cell">${j.printedAt ? fmtDatetime(new Date(j.printedAt)) : '—'}</td>
      <td>${pillHTML(j)}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty-cell">${hasPlan() ? 'No orders yet. They appear here the moment a customer pays.' : 'Orders will appear here once your shop is set up.'}</td></tr>`;
}

/* ================= Orders ================= */
let jobFilter = '';
function renderJobsTab() {
  const all = currentStats.recentJobs || [];
  const count = s => s ? all.filter(j => j.status === s).length : all.length;
  const defs = [['', 'All'], ['paid', 'Waiting'], ['printing', 'Printing'], ['printed', 'Printed'], ['failed', 'Failed']];
  $('jobChips').innerHTML = defs.map(([v, l]) => `<button class="fchip ${jobFilter === v ? 'on' : ''}" onclick="setJobFilter('${v}')">${l}<b>${count(v)}</b></button>`).join('');
  $('statusFilter').value = jobFilter;
  const q = $('jobSearch').value.trim().toLowerCase();
  const jobs = all.filter(j => (!jobFilter || j.status === jobFilter) && (!q || (j.code || '').toLowerCase().includes(q) || (j.filename || '').toLowerCase().includes(q)));
  $('jobsTabRows').innerHTML = jobs.length ? jobs.map(j => `
    <tr onclick="openDrawer('${esc(j.code)}')">
      <td class="code-cell">${esc(j.code)}</td>
      <td class="filename-cell" title="${esc(j.filename)}">${esc(j.filename)}</td>
      <td>${j.pages || '?'} × ${j.copies}</td>
      <td>${typeLabel(j)}</td>
      <td class="ts-cell">${j.startedAt ? fmtDatetime(new Date(j.startedAt)) : '—'}</td>
      <td class="ts-cell">${j.printedAt ? fmtDatetime(new Date(j.printedAt)) : '—'}</td>
      <td>${pillHTML(j)}${j.error ? `<div class="err-line" title="${esc(j.error)}">${esc(j.error)}</div>` : ''}</td>
      <td onclick="event.stopPropagation()">${j.status === 'failed' ? `<button class="btn sm" onclick="retryJob('${esc(j.code)}', this)">Retry</button>` : canReprint(j) ? `<button class="btn sm" title="Print this order again (available for 30 minutes after printing)" onclick="retryJob('${esc(j.code)}', this, true)">Reprint</button>` : ''}</td>
    </tr>`).join('') : `<tr><td colspan="8" class="empty-cell">${all.length ? 'No orders match your filter.' : 'No orders yet. They appear here the moment a customer pays.'}</td></tr>`;
}
function setJobFilter(v) { jobFilter = v; renderJobsTab(); }

function canReprint(j) {
  return j.status === 'printed' && j.printedAt && (Date.now() - new Date(j.printedAt).getTime()) < 30 * 60 * 1000;
}
async function retryJob(code, btn, reprint) {
  const label = reprint ? 'Reprint' : 'Retry';
  btn.disabled = true; btn.textContent = reprint ? 'Reprinting…' : 'Retrying…';
  const r = await window.docufast.retryJob(code, !!reprint);
  if (!r.ok) { btn.disabled = false; btn.textContent = label; btn.title = r.error; toast(r.error); return; }
  btn.textContent = 'Queued ✓'; toast(reprint ? 'Reprint queued' : 'Retry queued');
}
async function retryAllFailed() {
  const failed = (currentStats.recentJobs || []).filter(j => j.status === 'failed');
  for (const j of failed) await window.docufast.retryJob(j.code);
  toast(failed.length + ' order(s) queued to retry');
}
function exportJobs() {
  const rows = currentStats.recentJobs || [];
  if (!rows.length) { toast('No orders to export yet'); return; }
  const cell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = ['Code,File,Pages,Copies,Type,Started,Printed,Status,Error']
    .concat(rows.map(j => [j.code, j.filename, j.pages, j.copies, typeLabel(j), j.startedAt || '', j.printedAt || '', j.status, j.error || ''].map(cell).join(','))).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'docufast-orders-' + new Date().toISOString().slice(0, 10) + '.csv'; document.body.appendChild(a); a.click(); a.remove();
}

function openDrawer(code) {
  const j = (currentStats.recentJobs || []).find(x => x.code === code); if (!j) return;
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  $('drawerBody').innerHTML = `<div style="margin-bottom:16px;">${pillHTML(j)}</div><dl class="dl">
    ${row('Order code', `<span class="code-cell">${esc(j.code)}</span>`)}${row('File', esc(j.filename))}${row('Pages', esc(j.pages || '?'))}${row('Copies', esc(j.copies))}
    ${row('Print type', typeLabel(j))}${row('Started', j.startedAt ? fmtDatetime(new Date(j.startedAt)) : '—')}${row('Printed', j.printedAt ? fmtDatetime(new Date(j.printedAt)) : '—')}</dl>
    ${j.error ? `<div class="banner err" style="margin-top:16px;display:block;"><b>What went wrong</b><br>${esc(j.error)}</div>` : ''}
    <div class="btn-row" style="margin-top:18px;">${j.status === 'failed' ? `<button class="btn primary" onclick="retryJob('${esc(j.code)}', this);">Retry printing</button>` : canReprint(j) ? `<button class="btn primary" onclick="retryJob('${esc(j.code)}', this, true)">Reprint</button>` : ''}<button class="btn" onclick="navigator.clipboard && navigator.clipboard.writeText('${esc(j.code)}').then(()=>toast('Code copied'))">Copy code</button></div>`;
  $('drawer').style.display = 'flex'; $('drawerBg').style.display = 'block';
}
function closeDrawer() { $('drawer').style.display = 'none'; $('drawerBg').style.display = 'none'; }

/* ================= Customer link, poster, test print ================= */
const custUrl = () => (currentStats.shopSlug && (savedConfig.publicUrl || savedConfig.cloudUrl)) ? (savedConfig.publicUrl || savedConfig.cloudUrl) + '/?shop=' + encodeURIComponent(currentStats.shopSlug) : '';
function copyCustLink(btn) {
  if (need('Your customer link is created when you start your free trial.')) return;
  navigator.clipboard.writeText(custUrl()).then(() => toast('Customer link copied'));
}
// kind: undefined = the A4 wall poster, 'counter' = the 10 x 20 cm stand card for the counter.
function openPoster(kind) {
  if (need('Your shop\'s QR poster is created when you start your free trial.')) return;
  window.docufast.markStep('poster');
  window.docufast.openUrl((savedConfig.publicUrl || savedConfig.cloudUrl || '') + (kind === 'counter' ? '/counter.html?shop=' : '/signage.html?shop=') + encodeURIComponent(currentStats.shopSlug || ''));
  setTimeout(async () => { savedConfig = await window.docufast.getConfig(); renderSetup(); }, 500);
}
async function runTestPrintHome() {
  if (need('To print a test page on your shop printer, start your free trial first.')) return;
  toast('Sending test page…');
  const r = await window.docufast.testPrint();
  toast(r.ok ? 'Test page sent to your printer' : (r.error || 'Test print failed'));
  savedConfig = await window.docufast.getConfig(); renderSetup();
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
  $('appVer').textContent = 'DocuFast v' + (c.appVersion || '');
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

function onPrinterChange() {
  if (need('To choose the printer for your shop, start your free trial first. It takes about a minute.')) { loadPrinterOptions(savedConfig.printerName || ''); return; }
  markDirty(); showPrinterInfo();
}

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
  if (need('To save settings and start printing, start your free trial first.')) return;
  const c = readForm();
  if (!c.agentKey) { alert('Your shop is not set up yet.'); return; }
  await window.docufast.saveConfig(c);
  savedConfig = await window.docufast.getConfig();
  setDirty(false);
  toast('Settings saved'); $('dirtyMsg').textContent = '✓ Saved — printing restarted';
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
  if (need('To print a test page on your shop printer, start your free trial first.')) return;
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
  $('updMsg').textContent = r.message; if ($('updMsg2')) $('updMsg2').textContent = r.message; toast(r.message);
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

/* ================= Explore mode, guided setup, subscribe prompts ================= */
const hasPlan = () => !!savedConfig.agentKey;   // a shop exists (new account with a plan, or an older install)

// Returns true (and asks them to start the trial) when they try something that needs a shop.
function need(text) {
  if (hasPlan()) return false;
  $('needText').textContent = text || 'To set up printing for your shop, start your free trial. You pay nothing for 7 days and can cancel any time.';
  $('needModal').style.display = 'grid';
  return true;
}

function renderSetup() {
  const plan = hasPlan(), c = savedConfig || {}, s = currentStats || {};
  const printed = (s.recentJobs || []).length > 0 || s.jobsToday > 0;
  const steps = [
    { t: 'Start your free trial', d: plan ? 'Your shop is created.' : 'Sign in with your email and approve AutoPay. Nothing is charged for 7 days.', done: plan, label: 'Start free trial', go: () => window.docufast.openSubscribe() },
    { t: 'Choose your printer', d: 'Pick the printer your customers\' orders should print on.', done: plan && !!c.printerName, label: 'Choose printer', go: () => { switchTab('setup'); need('To choose the printer for your shop, start your free trial first. It takes about a minute.'); } },
    { t: 'Print a test page', d: 'Check that paper size and scaling come out right.', done: !!c.testPrinted && plan, label: 'Print test', go: () => runTestPrintHome() },
    { t: 'Put your QR poster on the counter', d: 'Customers scan it, upload and pay from their phone.', done: !!c.posterOpened && plan, label: 'Open poster', go: () => openPoster() },
    { t: 'Receive your first order', d: 'It prints automatically as soon as the customer pays.', done: plan && printed, label: '', go: null },
  ];
  const done = steps.filter(x => x.done).length;
  $('setupCard').style.display = done === steps.length ? 'none' : 'block';
  $('exploreCard').style.display = plan ? 'none' : 'block';
  $('setupTitle').textContent = plan ? 'Finish setting up your shop' : 'Get started in 5 steps';
  $('setupSub').textContent = plan ? 'A few quick steps and you are ready for customers.' : 'Look around first. We will ask you to start the free trial when you set something up.';
  $('setupProg').textContent = done + ' of ' + steps.length + ' done';
  $('setupBarFill').style.width = Math.round(done / steps.length * 100) + '%';
  const firstTodo = steps.findIndex(x => !x.done);
  $('setupSteps').innerHTML = steps.map((x, i) => `<li class="${x.done ? 'done' : ''}"><span class="n">${x.done ? '✓' : i + 1}</span><div class="t"><b>${esc(x.t)}</b><span>${esc(x.d)}</span></div>${!x.done && x.label ? `<button class="btn ${i === firstTodo ? 'primary' : ''} sm" data-i="${i}">${esc(x.label)}</button>` : ''}</li>`).join('');
  $('setupSteps').querySelectorAll('button').forEach(b => { b.onclick = () => steps[+b.dataset.i].go(); });
}

function planTiles(d, withBtn) {
  return d.plans.map(p => `<div class="plan-tile"><b>${esc(p.name)}</b><div class="p2">₹${p.price.toLocaleString('en-IN')}<small> / month</small></div><small>or ₹${(p.yearly || p.price * 10).toLocaleString('en-IN')} / year (2 months free)</small><ul>${(p.features || []).map(f => '<li>' + esc(f) + '</li>').join('')}</ul></div>`).join('') +
    (withBtn ? `<div style="grid-column:1/-1;text-align:center;margin-top:4px;"><button class="btn gold" type="button" onclick="window.docufast.openSubscribe()">Start free ${d.trialDays || 7}-day trial</button><div class="hint" style="margin-top:6px;">Nothing is charged for ${d.trialDays || 7} days. Cancel any time.</div></div>` : '');
}
function renderPlanTiles() { if (plansInfo && plansInfo.plans) { $('explorePlans').innerHTML = planTiles(plansInfo, true); $('acctPlans').innerHTML = planTiles(plansInfo, true); } }

/* ================= Account & plan ================= */
function billingText(b, planName, acctType) {
  if (acctType === 'owner') return { chip: 'Owner', cls: 'ok', name: 'Owner account · all features', pct: 100, sub: 'No subscription needed. This account never expires.' };
  if (!b) return { chip: 'No plan', cls: '', name: 'No plan yet', pct: 0, sub: 'Start your free trial to begin.' };
  const d = Math.max(b.daysLeft || 0, 0), until = b.until ? new Date(b.until).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  if (b.state === 'trial') return { chip: 'Free trial', cls: 'ok', name: (planName || 'Plan') + ' · free trial', pct: Math.round(d / 7 * 100), sub: d + ' day' + (d === 1 ? '' : 's') + ' left. Your plan starts automatically on ' + until + '. Cancel before then and pay nothing.' };
  if (b.state === 'active') return { chip: 'Active', cls: 'ok', name: (planName || 'Plan') + ' · active', pct: Math.min(100, Math.round(d / 30 * 100)), sub: 'Renews / valid until ' + until + ' (' + d + ' days left).' };
  if (b.state === 'grace') return { chip: 'Renew now', cls: 'warn', name: (planName || 'Plan') + ' · ended', pct: 0, sub: 'Your plan ended. Renew within a few days to keep taking orders.' };
  if (b.state === 'expired') return { chip: 'Expired', cls: 'err', name: (planName || 'Plan') + ' · expired', pct: 0, sub: 'New orders are paused until you renew.' };
  return { chip: 'No plan', cls: '', name: 'No plan yet', pct: 0, sub: 'Start your free trial to begin.' };
}
function paintPlanCards() {
  const acc = currentStats.account, sh = acc && acc.shop, t = billingText(sh && sh.billing, sh && sh.planName, sh && sh.acctType);
  const set = (chip, name, bar, sub) => { $(chip).textContent = t.chip; $(chip).className = 'chip ' + t.cls; $(name).textContent = t.name; $(bar).style.width = t.pct + '%'; $(sub).textContent = t.sub; };
  set('homePlanChip', 'homePlan', 'homePlanBar', 'homePlanSub');
  set('acctPlanChip', 'acctPlanName', 'acctPlanBar', 'acctPlanSub');
  $('homePlanBtn').textContent = sh ? 'Manage plan' : 'Start free trial';
  $('homePlanBtn').onclick = () => sh ? switchTab('account') : window.docufast.openSubscribe();
  $('acctPlanBtn').textContent = sh ? 'Manage plan & billing' : 'Start free trial';
  $('acctPlanBtn').onclick = () => sh ? switchTab('shop') : window.docufast.openSubscribe();
  $('acctPlansCard').style.display = sh ? 'none' : 'block';
  $('custLink').value = custUrl() || 'Available after you start your trial';
}
function renderAccount() {
  const acc = currentStats.account, sh = acc && acc.shop;
  const row = (k, v) => `<dt>${k}</dt><dd>${v == null || v === '' ? '—' : esc(v)}</dd>`;
  $('acctDl').innerHTML = row('Email', acc ? acc.email : 'Not signed in') + row('Name', acc && acc.name) + row('Shop', sh ? sh.name : 'Not created yet') + row('Shop code', sh && sh.slug) + row('Customer link', custUrl()) + row('Computers allowed', sh ? sh.maxPrinters : '');
  $('acctSignBtn').textContent = acc ? 'Sign out' : 'Sign in / start free trial';
  paintPlanCards();
  $('pcDl').innerHTML = row('Computer name', savedConfig.computerName || '') + row('App version', savedConfig.appVersion) + row('Server', savedConfig.cloudUrl) + row('Starts with Windows', savedConfig.autoLaunch === false ? 'No' : 'Yes');
}
function acctAction() {
  if (currentStats.account) { if (confirm('Sign out of DocuFast on this computer? Printing will stop until you sign in again.')) window.docufast.signOut(); }
  else window.docufast.openSubscribe();
}

/* ================= Help ================= */
function renderHelp() {
  const wa = plansInfo && plansInfo.whatsapp;
  $('helpWa').style.display = wa ? '' : 'none';
  $('helpWaNote').textContent = wa ? '' : 'WhatsApp support will appear here once it is set up. Use the website for now.';
  const row = (k, v) => `<dt>${k}</dt><dd>${esc(v)}</dd>`;
  $('aboutDl').innerHTML = row('Version', 'DocuFast ' + (savedConfig.appVersion || '')) + row('Server', savedConfig.cloudUrl || '') + row('Log folder', savedConfig.logDir || '');
}
function openWa() { const wa = plansInfo && plansInfo.whatsapp; if (wa) window.docufast.openUrl('https://wa.me/' + wa); }

/* ---- Account footer + plan banner ---- */
function paintAccount(acc) {
  $('acct').style.display = 'block';
  if (acc !== undefined) currentStats.account = acc;
  if (!acc || !acc.shop) {
    $('acctMail').textContent = acc ? acc.email : 'Not signed in';
    $('acctPlan').textContent = 'Exploring · no plan yet';
    $('acctOut').textContent = 'Start free trial'; $('acctOut').onclick = () => window.docufast.openSubscribe();
    paintPlanBar(null); paintPlanCards(); return;
  }
  $('acctOut').textContent = 'Sign out';
  $('acctOut').onclick = () => { if (confirm('Sign out of DocuFast on this computer? Printing will stop until you sign in again.')) window.docufast.signOut(); };
  $('acctMail').textContent = acc.email;
  const b = acc.shop.billing, plan = acc.shop.planName;
  let t = '';
  if (acc.shop.acctType === 'owner') t = 'Owner account · no subscription';
  else if (b) t = b.state === 'trial' ? `${plan || ''} trial · ${Math.max(b.daysLeft, 0)} day${b.daysLeft === 1 ? '' : 's'} left`
    : b.state === 'active' ? `${plan || 'Plan'} · active` : b.state === 'grace' ? 'Plan ended · renew now' : b.state === 'expired' ? 'Plan expired' : '';
  $('acctPlan').textContent = t;
  paintPlanBar(b); paintPlanCards();
}
function paintPlanBar(b) {
  let bar = $('planBar');
  if (!bar) { bar = document.createElement('div'); bar.id = 'planBar'; bar.className = 'planbar'; $('planBarHost').appendChild(bar); }
  const warn = b && !(currentStats.account && currentStats.account.shop && currentStats.account.shop.acctType === 'owner') && (b.state === 'grace' || b.state === 'expired' || (b.state === 'trial' && b.daysLeft <= 2));
  bar.style.display = warn ? 'flex' : 'none';
  if (warn) {
    bar.className = 'planbar ' + (b.state === 'trial' ? 'warn' : 'err');
    bar.innerHTML = '<span>' + (b.state === 'trial' ? 'Your free trial ends soon. Your plan will start automatically.' : b.state === 'grace' ? 'Your plan has ended. Renew to keep taking orders.' : 'Your plan has expired. New orders are paused until you renew.') + '</span><button type="button" id="planGo">Manage plan</button>';
    $('planGo').onclick = () => switchTab('account');
  }
}


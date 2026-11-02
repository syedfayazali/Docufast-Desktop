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
  $('needGo').onclick = () => { $('needModal').style.display = 'none'; window.docufast.openSubscribe(); };
  $('needNo').onclick = () => { $('needModal').style.display = 'none'; };
  applyStats(await window.docufast.getStats());
  renderSetup(); loadExplorePlans();
  window.docufast.onStatsUpdate(applyStats);
  window.docufast.onNavigate(switchTab);
  paintAccount(await window.docufast.accountInfo());
  if (savedConfig.signedIn) { const kf = $('cfgAgentKey').closest('.field'); if (kf) kf.style.display = 'none'; }
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'jobs') renderJobsTab();
  if (tab === 'shop') {
    const ok = hasPlan();
    $('shopLocked').style.display = ok ? 'none' : 'block'; $('shopFrame').style.display = ok ? 'block' : 'none';
    const f = $('shopFrame'); if (ok && !f.src && savedConfig.cloudUrl) f.src = savedConfig.cloudUrl + '/admin.html?app=1';
  }
  renderSetup();
  if (tab === 'setup' && !dirty) { loadPrinterOptions(val('cfgPrinterName')); refreshPreview(); }
}

/* ================= Stats / dashboard ================= */
function applyStats(stats) {
  if (stats && stats.account !== undefined) paintAccount(stats.account);
  currentStats = stats;
  if (typeof renderSetup === 'function' && savedConfig) renderSetup();
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
  if (need('Pausing and resuming printing needs your shop to be set up first.')) return;
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

/* ---- Account footer + plan banner ---- */
function paintAccount(acc) {
  $('acct').style.display = 'block';
  if (!acc || !acc.shop) {
    $('acctMail').textContent = acc ? acc.email : 'Not signed in';
    $('acctPlan').textContent = 'Exploring · no plan yet';
    $('acctOut').textContent = 'Start free trial'; $('acctOut').onclick = () => window.docufast.openSubscribe();
    return;
  }
  $('acctOut').textContent = 'Sign out';
  $('acctOut').onclick = () => { if (confirm('Sign out of DocuFast on this computer? Printing will stop until you sign in again.')) window.docufast.signOut(); };
  $('acctMail').textContent = acc.email;
  const b = acc.shop && acc.shop.billing, plan = acc.shop && acc.shop.planName;
  let t = '';
  if (b) t = b.state === 'trial' ? `${plan || ''} trial · ${Math.max(b.daysLeft, 0)} day${b.daysLeft === 1 ? '' : 's'} left`
    : b.state === 'active' ? `${plan || 'Plan'} · active` : b.state === 'grace' ? 'Plan ended · renew now' : b.state === 'expired' ? 'Plan expired' : '';
  $('acctPlan').textContent = t;
  let bar = $('planBar');
  if (!bar) { bar = document.createElement('div'); bar.id = 'planBar'; bar.className = 'planbar'; document.querySelector('main.content').prepend(bar); }
  const warn = b && (b.state === 'grace' || b.state === 'expired' || (b.state === 'trial' && b.daysLeft <= 2));
  bar.style.display = warn ? 'flex' : 'none';
  if (warn) {
    bar.className = 'planbar ' + (b.state === 'trial' ? 'warn' : 'err');
    bar.innerHTML = '<span>' + (b.state === 'trial' ? 'Your free trial ends soon. Your plan will start automatically.' : b.state === 'grace' ? 'Your plan has ended. Renew to keep taking orders.' : 'Your plan has expired. New orders are paused until you renew.') + '</span><button type="button" id="planGo">Orders &amp; plan</button>';
    $('planGo').onclick = () => switchTab('shop');
  }
}

/* ---- Explore mode, guided setup, subscribe prompts ---- */
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
    { t: 'Print a test page', d: 'Check that paper size and scaling come out right.', done: !!c.testPrinted && plan, label: 'Print test', go: () => { switchTab('setup'); need('To print a test page on your shop printer, start your free trial first.'); } },
    { t: 'Put your QR poster on the counter', d: 'Customers scan it, upload and pay from their phone.', done: !!c.posterOpened && plan, label: 'Open poster', go: () => { if (need('Your shop\'s QR poster is created when you start your free trial.')) return; window.docufast.markStep('poster'); window.docufast.openUrl((savedConfig.cloudUrl || '') + '/signage.html?shop=' + encodeURIComponent(s.shopSlug || '')); setTimeout(async () => { savedConfig = await window.docufast.getConfig(); renderSetup(); }, 500); } },
    { t: 'Receive your first order', d: 'It prints automatically as soon as the customer pays.', done: plan && printed, label: '', go: null },
  ];
  const done = steps.filter(x => x.done).length;
  const card = $('setupCard');
  card.style.display = done === steps.length ? 'none' : 'block';
  $('exploreCard').style.display = plan ? 'none' : 'block';
  $('setupTitle').textContent = plan ? 'Finish setting up your shop' : 'Welcome to DocuFast';
  $('setupSub').textContent = plan ? 'A few quick steps and you are ready for customers.' : 'Look around first. We will ask you to start the free trial when you set something up.';
  $('setupProg').textContent = done + ' of ' + steps.length + ' done';
  $('setupBarFill').style.width = Math.round(done / steps.length * 100) + '%';
  const firstTodo = steps.findIndex(x => !x.done);
  $('setupSteps').innerHTML = steps.map((x, i) => `<li class="${x.done ? 'done' : ''}"><span class="n">${x.done ? '✓' : i + 1}</span><div class="t"><b>${esc(x.t)}</b><span>${esc(x.d)}</span></div>${!x.done && x.label ? `<button class="btn ${i === firstTodo ? 'primary' : ''} sm" data-i="${i}">${esc(x.label)}</button>` : ''}</li>`).join('');
  $('setupSteps').querySelectorAll('button').forEach(b => { b.onclick = () => steps[+b.dataset.i].go(); });
}

async function loadExplorePlans() {
  const d = await window.docufast.getPlans();
  if (!d || !d.plans) return;
  $('explorePlans').innerHTML = d.plans.map(p => `<div class="plan-tile"><b>${esc(p.name)}</b><div class="p">₹${p.price.toLocaleString('en-IN')}<small> / month</small></div><ul>${(p.features || []).slice(0, 4).map(f => '<li>' + esc(f) + '</li>').join('')}</ul></div>`).join('') +
    `<div style="grid-column:1/-1;text-align:center;margin-top:4px;"><button class="btn primary" type="button" onclick="window.docufast.openSubscribe()">Start free ${d.trialDays || 7}-day trial</button><div class="hint" style="margin-top:6px;">Nothing is charged for ${d.trialDays || 7} days. Cancel any time.</div></div>`;
}

// Dashboard renderer — communicates with main process via window.docufast (preload bridge)

let currentStats = { recentJobs: [], jobsToday: 0, revenueToday: 0, pending: 0, connected: false };
let currentTab = 'dashboard';

// ---- Init ----
async function init() {
  // A relative "../assets/logo.png" can't resolve here (this page loads
  // from inside app.asar, but assets/ only exists at resources/assets/ in
  // the packaged app) — ask the main process for a proper file:// URL.
  const logoUrl = await window.docufast.getAssetUrl('logo.png');
  const logoImg = document.getElementById('brandLogoImg');
  if (logoUrl) logoImg.src = logoUrl;
  else logoImg.dispatchEvent(new Event('error'));

  await loadSettings();
  const stats = await window.docufast.getStats();
  applyStats(stats);

  // Live updates pushed from main process
  window.docufast.onStatsUpdate(applyStats);
  window.docufast.onNavigate(tab => switchTab(tab));
}

// ---- Tab switching ----
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.getElementById(`tab-${tab}`).classList.add('active');
  if (tab === 'jobs') renderJobsTab();
  if (tab === 'setup') loadPrinterOptions(document.getElementById('cfgPrinterName').value);
}

// ---- Stats rendering ----
function applyStats(stats) {
  currentStats = stats;

  // Status dot
  const dot = document.getElementById('statusDot');
  const lbl = document.getElementById('statusLabel');
  if (stats.duplicateKey) {
    dot.className = 'status-dot disconnected';
    lbl.textContent = stats.duplicateMessage || 'Duplicate key — active on another computer';
  } else if (stats.connected) {
    dot.className = 'status-dot connected';
    lbl.textContent = 'Connected';
  } else {
    dot.className = 'status-dot disconnected';
    lbl.textContent = 'Disconnected';
  }

  // KPIs
  document.getElementById('kpiJobsToday').textContent = stats.jobsToday;
  document.getElementById('kpiRevenue').textContent = '₹' + ((stats.revenueToday || 0) / 100).toFixed(2);
  document.getElementById('kpiPending').textContent = stats.pending;
  document.getElementById('kpiPrinter').textContent = stats.connected ? 'Online' : 'Offline';

  // Shop name (once known — comes from the cloud via stats.shopName)
  if (stats.shopName) {
    document.getElementById('shopNameBadge').textContent = stats.shopName;
    document.getElementById('shopNameBadge').style.display = 'inline-block';
    const brandShop = document.getElementById('brandShop');
    brandShop.textContent = stats.shopName;
    brandShop.style.display = 'block';
  }

  // Last poll
  if (stats.lastPoll) {
    const d = new Date(stats.lastPoll);
    document.getElementById('lastPoll').textContent = 'Last poll: ' + fmtTime(d);
  }

  // Dashboard recent jobs (last 10)
  renderDashJobs(stats.recentJobs || []);

  // If jobs tab is open, update it too
  if (currentTab === 'jobs') renderJobsTab();
}

// ---- Dashboard recent jobs (compact, last 10) ----
function renderDashJobs(jobs) {
  const tbody = document.getElementById('dashJobRows');
  const recent = jobs.slice(0, 10);
  if (!recent.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No jobs yet today</td></tr>';
    return;
  }
  tbody.innerHTML = recent.map(j => `
    <tr>
      <td class="code-cell">${j.code}</td>
      <td class="filename-cell" title="${j.filename}">${j.filename}</td>
      <td>${j.colorMode === 'color' ? '🟡 Colour' : '⚫ B&W'}${j.duplex ? ' · D' : ''}</td>
      <td class="ts-cell">${j.startedAt ? fmtDatetime(new Date(j.startedAt)) : '—'}</td>
      <td class="ts-cell">${j.printedAt ? fmtDatetime(new Date(j.printedAt)) : '—'}</td>
      <td>${pillHTML(j)}</td>
    </tr>
  `).join('');
}

// ---- Jobs tab (full history with timestamps + duration) ----
function renderJobsTab() {
  const filter = document.getElementById('statusFilter').value;
  const jobs = (currentStats.recentJobs || []).filter(j => {
    if (!filter) return true;
    return j.status === filter;
  });

  const tbody = document.getElementById('jobsTabRows');
  if (!jobs.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-cell">No jobs match this filter</td></tr>';
    return;
  }

  tbody.innerHTML = jobs.map(j => {
    const started = j.startedAt ? new Date(j.startedAt) : null;
    const printed = j.printedAt ? new Date(j.printedAt) : null;
    const duration = started && printed
      ? ((printed - started) / 1000).toFixed(1) + 's'
      : '—';

    return `
      <tr>
        <td class="code-cell">${j.code}</td>
        <td class="filename-cell" title="${j.filename}">${j.filename}</td>
        <td>${j.pages || '?'} × ${j.copies}</td>
        <td>${j.colorMode === 'color' ? '🟡 Colour' : '⚫ B&W'}${j.duplex ? ' · Duplex' : ''}</td>
        <td class="ts-cell">${started ? fmtDatetime(started) : '—'}</td>
        <td class="ts-cell">${printed ? fmtDatetime(printed) : '—'}</td>
        <td class="ts-cell">${duration}</td>
        <td>${pillHTML(j)}${j.error ? `<div style="font-size:10px;color:#B3261E;margin-top:3px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${j.error}">${j.error}</div>` : ''}</td>
        <td>${j.status === 'failed' ? `<button class="retry-btn" onclick="retryJob('${j.code}', this)">Retry</button>` : ''}</td>
      </tr>
    `;
  }).join('');
}

// Re-queue a failed job for printing. Disables the button and shows the
// outcome inline rather than a popup alert, then refreshes the row once the
// cloud confirms the retry.
async function retryJob(code, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = 'Retrying…';
  const result = await window.docufast.retryJob(code);
  if (!result.ok) {
    btnEl.disabled = false;
    btnEl.textContent = 'Retry';
    btnEl.title = result.error;
    btnEl.style.color = '#B3261E';
    return;
  }
  // The main process already kicked off a fresh fetchShopData(); the next
  // onStatsUpdate push will re-render this row with the new status.
  btnEl.textContent = 'Retried ✓';
}

// ---- Settings ----
async function loadSettings() {
  const config = await window.docufast.getConfig();
  document.getElementById('cfgAgentKey').value = config.agentKey || '';
  document.getElementById('cfgSumatraPath').value = config.sumatraPath || '';
  document.getElementById('cfgPollMs').value = (config.pollMs || 10000) / 1000;
  document.getElementById('cfgAutoLaunch').checked = config.autoLaunch !== false;
  await loadPrinterOptions(config.printerName || '');
}

// Populate the printer dropdown with what Windows actually reports, so the
// shop picks from a real list instead of typing an exact name that has to
// match a Windows printer verbatim.
async function loadPrinterOptions(selectedName) {
  const select = document.getElementById('cfgPrinterName');
  const printers = await window.docufast.getPrinters();

  select.innerHTML = '<option value="">Use Windows default printer</option>' +
    printers.map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}${p.isDefault ? ' (Windows default)' : ''}</option>`).join('');

  // Preserve a previously-saved printer name even if it isn't in the list
  // right now (e.g. printer temporarily off) so Save doesn't silently clear it.
  if (selectedName && ![...select.options].some(o => o.value === selectedName)) {
    const opt = document.createElement('option');
    opt.value = selectedName;
    opt.textContent = `${selectedName} (not currently detected)`;
    select.appendChild(opt);
  }
  select.value = selectedName || '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function saveSettings() {
  const pollSec = Math.max(3, Math.min(60, parseInt(document.getElementById('cfgPollMs').value) || 5));
  const config = {
    agentKey:    document.getElementById('cfgAgentKey').value.trim(),
    sumatraPath: document.getElementById('cfgSumatraPath').value.trim(),
    printerName: document.getElementById('cfgPrinterName').value.trim(),
    pollMs:      pollSec * 1000,
    autoLaunch:  document.getElementById('cfgAutoLaunch').checked,
  };
  await window.docufast.saveConfig(config);
  const msg = document.getElementById('saveMsg');
  msg.textContent = '✓ Saved — agent restarted';
  setTimeout(() => { msg.textContent = ''; }, 3000);
}

// ---- Helpers ----
function pillHTML(j) {
  if (j.status === 'printed') return '<span class="pill printed">Printed</span>';
  if (j.status === 'printing') return '<span class="pill printing">Printing…</span>';
  if (j.status === 'failed') return '<span class="pill failed">Failed</span>';
  return '<span class="pill pending">Pending</span>';
}

function fmtDatetime(d) {
  // Format: "15 Sep, 2:34:07 PM"
  const day = d.getDate();
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${day} ${month}, ${h12}:${m}:${s} ${ampm}`;
}

function fmtTime(d) {
  const h = d.getHours() % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
  return `${h}:${m}:${s} ${ampm}`;
}

init();

// Asks Windows (PowerShell) how the chosen printer is doing. Nothing here is a guess shown as a fact:
// when Windows cannot tell, the state is "unknown" and printing is never blocked because of it.
const { execFile } = require('child_process');

const PRINTER_ERRORS = { 4: 'out of paper', 6: 'out of toner or ink', 7: 'a door or cover is open', 8: 'a paper jam', 9: 'offline', 11: 'the output tray is full' };
const BAD_JOB = /error|offline|paperout|usercontext|userintervention|blocked|paused/i;

const SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$n=$env:DF_PRINTER",
  "$p = if ($n) { Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $n } | Select-Object -First 1 } else { Get-CimInstance Win32_Printer | Where-Object { $_.Default } | Select-Object -First 1 }",
  "if (-not $p) { '{}'; return }",
  "$port = [string]$p.PortName",
  // USB printers: devices Windows has seen (USBPRINT) versus devices that are plugged in AND switched on right now.
  "$usbKnown = 0; $usbPresent = 0",
  "if ($port -match '^(USB|DOT4)') {",
  "  $usbKnown = @(Get-PnpDevice | Where-Object { $_.InstanceId -like 'USBPRINT*' }).Count",
  "  $usbPresent = @(Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USBPRINT*' }).Count",
  "}",
  // Network printers: can this PC reach the printer's address at all?
  "$net = $null",
  "$tp = Get-CimInstance Win32_TCPIPPrinterPort | Where-Object { $_.Name -eq $port } | Select-Object -First 1",
  "if ($tp) { try { $c = New-Object Net.Sockets.TcpClient; $ok = $c.ConnectAsync($tp.HostAddress, [int]$tp.PortNumber).Wait(2000); $net = [bool]($ok -and $c.Connected); $c.Close() } catch { $net = $false } }",
  "$q = @(Get-PrintJob -PrinterName $p.Name | ForEach-Object { @{ id = $_.ID; status = [string]$_.JobStatus } })",
  "@{ offline = [bool]$p.WorkOffline; status = [int]$p.PrinterStatus; err = [int]$p.DetectedErrorState; port = $port; usbKnown = $usbKnown; usbPresent = $usbPresent; net = $net; queue = $q } | ConvertTo-Json -Compress -Depth 4",
].join('\n');

function run(printerName, script, timeout = 12000) {
  return new Promise(resolve => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout, env: { ...process.env, DF_PRINTER: printerName || '' } },
      (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

// Turns the raw Windows answer into one plain verdict. Pure function so it can be tested anywhere.
function judge(r) {
  if (!r || typeof r !== 'object' || r.status === undefined) return { state: 'unknown', label: 'Unknown', detail: 'Windows did not report on this printer.' };
  const queue = Array.isArray(r.queue) ? r.queue : (r.queue ? [r.queue] : []);
  const queued = queue.length;
  const stuck = queue.filter(j => BAD_JOB.test(j.status || ''));
  const base = { queued, stuck: stuck.length };
  if (r.offline || r.status === 7) return { ...base, state: 'offline', label: 'Offline', detail: 'Windows says the printer is offline. Check that it is switched on and connected.' };
  if (r.net === false) return { ...base, state: 'offline', label: 'Not reachable', detail: 'This PC cannot reach the printer on the network. Check that it is on and on the same Wi-Fi or cable.' };
  if (/^(USB|DOT4)/i.test(r.port || '') && r.usbKnown > 0 && r.usbPresent === 0) return { ...base, state: 'offline', label: 'Off or unplugged', detail: 'The printer is switched off or its USB cable is unplugged.' };
  if (PRINTER_ERRORS[r.err]) return { ...base, state: 'error', label: PRINTER_ERRORS[r.err][0].toUpperCase() + PRINTER_ERRORS[r.err].slice(1), detail: `The printer reports: ${PRINTER_ERRORS[r.err]}.` };
  if (stuck.length) return { ...base, state: 'error', label: 'Jobs stuck', detail: 'Jobs are stuck in the Windows print queue. The printer may be off or has an error.' };
  return { ...base, state: 'ready', label: 'Ready', detail: queued ? `Ready. ${queued} job${queued > 1 ? 's' : ''} in the Windows queue.` : 'Ready to print.' };
}

async function checkPrinter(printerName) {
  const out = await run(printerName, SCRIPT);
  if (out === null) return judge(null);
  try { return judge(JSON.parse(out || '{}')); } catch { return judge(null); }
}

// After a job is sent: if Windows shows a job stuck in an error/offline state, remove it and say so, so the
// server holds the job for a retry instead of the file printing twice later. Returns a problem text or null.
async function stuckAfterSend(printerName, waitMs = 18000) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$n=$env:DF_PRINTER",
    "$p = if ($n) { Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $n } | Select-Object -First 1 } else { Get-CimInstance Win32_Printer | Where-Object { $_.Default } | Select-Object -First 1 }",
    "if (-not $p) { '[]'; return }",
    "@(Get-PrintJob -PrinterName $p.Name | ForEach-Object { @{ id = $_.ID; status = [string]$_.JobStatus } }) | ConvertTo-Json -Compress -Depth 3",
  ].join('\n');
  const started = Date.now();
  await new Promise(r => setTimeout(r, 6000));
  let badSeen = 0;
  while (Date.now() - started < waitMs) {
    const out = await run(printerName, script, 8000);
    let jobs = [];
    try { jobs = JSON.parse(out || '[]'); if (!Array.isArray(jobs)) jobs = [jobs]; } catch { jobs = []; }
    const bad = jobs.filter(j => BAD_JOB.test(j.status || ''));
    if (!bad.length) return null;
    badSeen++;
    if (badSeen >= 2) {
      const rm = ["$ErrorActionPreference='SilentlyContinue'", "$n=$env:DF_PRINTER",
        "$p = if ($n) { Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $n } | Select-Object -First 1 } else { Get-CimInstance Win32_Printer | Where-Object { $_.Default } | Select-Object -First 1 }",
        "if ($p) { Get-PrintJob -PrinterName $p.Name | Where-Object { $_.JobStatus -match 'rror|ffline|aperOut|ntervention|locked|aused' } | Remove-PrintJob }"].join('\n');
      await run(printerName, rm, 8000);
      return 'not responding (the job was stuck in the Windows queue and has been cancelled)';
    }
    await new Promise(r => setTimeout(r, 4000));
  }
  return null;
}

module.exports = { checkPrinter, stuckAfterSend, judge, PRINTER_ERRORS };

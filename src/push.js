// Live "wake-up" connection to the cloud (Supabase Realtime).
//
// When a customer's payment goes through, the server pings this shop's
// private channel; we then fetch jobs immediately instead of waiting for the
// next poll. The ping carries no data and the agent still uses the normal
// authenticated API, so this is purely a speed-up: if the connection drops,
// main.js falls back to regular polling on its own.
const crypto = require('crypto');
const WebSocket = require('ws');
const { RealtimeClient } = require('@supabase/realtime-js');

// Must match lib/wake.js on the server.
function channelName(agentKey) {
  return 'shop-' + crypto.createHash('sha256').update(String(agentKey)).digest('hex').slice(0, 32);
}

// Open a raw WebSocket to the same endpoint and report exactly how it fails
// (DNS, reset, TLS/cert, proxy HTTP status, timeout). realtime-js hides this.
function probeSocket(url, anonKey) {
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; try { ws.terminate(); } catch { /* ignore */ } resolve(r); } };
    const target = `${url.replace(/^http/, 'ws').replace(/\/$/, '')}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;
    let ws;
    try { ws = new WebSocket(target, { handshakeTimeout: 10000 }); } catch (e) { return resolve(`could not open: ${e.message}`); }
    ws.on('open', () => finish('websocket opens fine in isolation (problem is after connect)'));
    ws.on('unexpected-response', (_req, res) => finish(`server/proxy answered HTTP ${res.statusCode} instead of upgrading (proxy or filter in the way)`));
    ws.on('error', e => finish(`${e.code || 'error'}: ${e.message}`));
    ws.on('close', c => finish(`closed immediately, code ${c}`));
    setTimeout(() => finish('timed out after 12s (connection silently dropped)'), 12000);
  });
}

function startPush({ agentKey, url, anonKey, onWake, onState, onReason, log }) {
  let client = null;
  let probing = false;
  let lastProbe = 0;
  const seen = new Map();
  const logOnce = m => { const t = Date.now(); if (t - (seen.get(m) || 0) > 300000) { seen.set(m, t); log(m); } };
  const probe = async why => {
    if (probing || stopped || Date.now() - lastProbe < 300000) return;
    probing = true;
    lastProbe = Date.now();
    const r = await probeSocket(url, anonKey);
    probing = false;
    if (stopped) return;
    log(`push: diagnosis after ${why}: ${r}`);
    try { onReason && onReason(r); } catch { /* ignore */ }
  };
  let stopped = false;
  let state = 'connecting';
  const setState = s => { if (s !== state && !stopped) { state = s; try { onState(s); } catch { /* ignore */ } } };

  try {
    client = new RealtimeClient(`${url.replace(/^http/, 'ws').replace(/\/$/, '')}/realtime/v1`, {
      transport: WebSocket,
      params: { apikey: anonKey },
      heartbeatIntervalMs: 25000,
      timeout: 15000,
      reconnectAfterMs: n => Math.min(60000, [1000, 2000, 5000, 10000, 30000][n - 1] || 60000),
    });
    client.stateChangeCallbacks.error.push(e => logOnce(`push: socket error - ${(e && (e.message || e.code)) || 'unknown'}`));
    client.setAuth(anonKey);

    const channel = client.channel(channelName(agentKey), {
      config: { private: true, broadcast: { self: false } },
    });
    channel.on('broadcast', { event: 'job' }, () => { if (!stopped) onWake(); });
    channel.subscribe((status, err) => {
      if (stopped) return;
      if (status === 'SUBSCRIBED') { log('push: connected'); try { onReason && onReason(''); } catch { /* ignore */ } setState('connected'); }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        logOnce(`push: ${status}${err ? ' - ' + (err.message || err) : ''}`);
        setState('down');
        probe(status);
      }
    });
    client.connect();
  } catch (e) {
    log(`push: could not start - ${e.message}`);
    setState('down');
    probe('start failure');
  }

  return {
    stop() {
      stopped = true;
      try { client && client.disconnect(); } catch { /* ignore */ }
    },
  };
}

module.exports = { startPush, channelName };

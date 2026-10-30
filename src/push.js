// Live "wake-up" connection to the cloud (Supabase Realtime).
//
// When a customer's payment goes through, the server pings this shop's
// private channel; we then fetch jobs immediately instead of waiting for the
// next poll. The ping carries no data and the agent still uses the normal
// authenticated API, so this is purely a speed-up: if the connection drops,
// main.js falls back to regular polling on its own.
//
// This speaks the Realtime wire protocol directly over `ws` (join a private
// broadcast channel, answer heartbeats, reconnect with backoff). It replaces
// the realtime-js library, whose reconnect loop was dropping the socket every
// ~27 s on the shop PC. Every close code and join reply is logged so a failure
// says why.
const crypto = require('crypto');
const WebSocket = require('ws');

// Must match lib/wake.js on the server.
function channelName(agentKey) {
  return 'shop-' + crypto.createHash('sha256').update(String(agentKey)).digest('hex').slice(0, 32);
}

// Open a raw WebSocket to the same endpoint and report exactly how it fails
// (DNS, reset, TLS/cert, proxy HTTP status, timeout).
function probeSocket(url, anonKey) {
  return new Promise(resolve => {
    let done = false;
    let ws;
    const finish = r => { if (!done) { done = true; try { ws.terminate(); } catch { /* ignore */ } resolve(r); } };
    const target = `${url.replace(/^http/, 'ws').replace(/\/$/, '')}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;
    try { ws = new WebSocket(target, { handshakeTimeout: 10000 }); } catch (e) { return resolve(`could not open: ${e.message}`); }
    ws.on('open', () => finish('websocket opens fine in isolation (problem is after connect)'));
    ws.on('unexpected-response', (_req, res) => finish(`server/proxy answered HTTP ${res.statusCode} instead of upgrading (proxy or filter in the way)`));
    ws.on('error', e => finish(`${e.code || 'error'}: ${e.message}`));
    ws.on('close', c => finish(`closed immediately, code ${c}`));
    setTimeout(() => finish('timed out after 12s (connection silently dropped)'), 12000);
  });
}

const HEARTBEAT_MS = 25000;   // how often we ping the server
const HEARTBEAT_WAIT_MS = 12000;   // how long we wait for its answer
const JOIN_WAIT_MS = 15000;

function startPush({ agentKey, url, anonKey, onWake, onState, onReason, log }) {
  const topic = 'realtime:' + channelName(agentKey);
  let ws = null, ref = 0, joined = false, stopped = false, tries = 0;
  let hbTimer = null, hbWait = null, joinTimer = null, retryTimer = null;
  let state = 'connecting';
  let probing = false, lastProbe = 0;
  const seen = new Map();
  const logOnce = m => { const t = Date.now(); if (t - (seen.get(m) || 0) > 300000) { seen.set(m, t); log(m); } };
  const reason = r => { try { onReason && onReason(r); } catch { /* ignore */ } };
  const setState = s => { if (s !== state && !stopped) { state = s; try { onState(s); } catch { /* ignore */ } } };
  const send = (t, e, p) => { try { ws.send(JSON.stringify({ topic: t, event: e, payload: p, ref: String(++ref) })); } catch { /* socket gone; close handler follows */ } };
  const clearTimers = () => { clearInterval(hbTimer); clearTimeout(hbWait); clearTimeout(joinTimer); };

  const probe = async why => {
    if (probing || stopped || Date.now() - lastProbe < 300000) return;
    probing = true; lastProbe = Date.now();
    const r = await probeSocket(url, anonKey);
    probing = false;
    if (stopped) return;
    log(`push: diagnosis after ${why}: ${r}`);
    reason(r);
  };

  function drop(why) {
    clearTimers();
    const was = joined;
    joined = false;
    try { if (ws) { ws.removeAllListeners(); ws.on('error', () => {}); ws.terminate(); } } catch { /* ignore */ }
    ws = null;
    if (stopped) return;
    logOnce(`push: ${why}`);
    setState('down');
    if (!was) { reason(why); probe(why); }
    tries++;
    const wait = Math.min(60000, [1000, 2000, 5000, 10000, 30000][tries - 1] || 60000);
    retryTimer = setTimeout(open, wait);
  }

  function open() {
    if (stopped) return;
    const target = `${url.replace(/^http/, 'ws').replace(/\/$/, '')}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;
    try { ws = new WebSocket(target, { handshakeTimeout: 15000 }); }
    catch (e) { return drop(`could not start - ${e.message}`); }
    const mine = ws;
    ws.on('open', () => {
      send(topic, 'phx_join', { config: { broadcast: { ack: false, self: false }, presence: { key: '' }, postgres_changes: [], private: true }, access_token: anonKey });
      joinTimer = setTimeout(() => { if (mine === ws && !joined) drop('no answer to join within 15s'); }, JOIN_WAIT_MS);
    });
    ws.on('message', data => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.topic === topic && m.event === 'phx_reply') {
        if (m.payload && m.payload.status === 'ok') {
          joined = true; tries = 0;
          clearTimeout(joinTimer);
          log('push: connected');
          reason('');
          setState('connected');
          clearInterval(hbTimer);
          hbTimer = setInterval(() => {
            send('phoenix', 'heartbeat', {});
            clearTimeout(hbWait);
            hbWait = setTimeout(() => { if (mine === ws) drop('no heartbeat reply from server (link looks dead)'); }, HEARTBEAT_WAIT_MS);
          }, HEARTBEAT_MS);
        } else {
          drop('join refused: ' + JSON.stringify(m.payload && (m.payload.response || m.payload)).slice(0, 160));
        }
      } else if (m.topic === 'phoenix' && m.event === 'phx_reply') {
        clearTimeout(hbWait);
      } else if (m.topic === topic && m.event === 'broadcast' && m.payload && m.payload.event === 'job') {
        if (!stopped) onWake();
      } else if (m.topic === topic && (m.event === 'phx_error' || m.event === 'phx_close')) {
        drop('server ended the channel (' + m.event + ')');
      }
    });
    ws.on('unexpected-response', (_req, res) => { if (mine === ws) drop(`server/proxy answered HTTP ${res.statusCode} instead of upgrading`); });
    ws.on('error', e => { if (mine === ws) logOnce(`push: socket error - ${e.code || ''} ${e.message}`); });
    ws.on('close', (code, reasonBuf) => { if (mine === ws) drop(`socket closed (code ${code}${reasonBuf && reasonBuf.length ? ', ' + reasonBuf.toString().slice(0, 60) : ''})`); });
  }

  open();

  return {
    stop() {
      stopped = true;
      clearTimers(); clearTimeout(retryTimer);
      try { if (ws) { ws.removeAllListeners(); ws.on('error', () => {}); ws.close(); } } catch { /* ignore */ }
    },
  };
}

module.exports = { startPush, channelName };

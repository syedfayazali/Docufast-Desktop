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

function startPush({ agentKey, url, anonKey, onWake, onState, log }) {
  let client = null;
  let stopped = false;
  let state = 'connecting';
  const setState = s => { if (s !== state && !stopped) { state = s; try { onState(s); } catch { /* ignore */ } } };

  try {
    client = new RealtimeClient(`${url.replace(/^http/, 'ws').replace(/\/$/, '')}/realtime/v1`, {
      transport: WebSocket,
      params: { apikey: anonKey },
      heartbeatIntervalMs: 25000,
      timeout: 15000,
    });
    client.setAuth(anonKey);

    const channel = client.channel(channelName(agentKey), {
      config: { private: true, broadcast: { self: false } },
    });
    channel.on('broadcast', { event: 'job' }, () => { if (!stopped) onWake(); });
    channel.subscribe((status, err) => {
      if (stopped) return;
      if (status === 'SUBSCRIBED') { log('push: connected'); setState('connected'); }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        log(`push: ${status}${err ? ' - ' + (err.message || err) : ''}`);
        setState('down');
      }
    });
    client.connect();
  } catch (e) {
    log(`push: could not start - ${e.message}`);
    setState('down');
  }

  return {
    stop() {
      stopped = true;
      try { client && client.disconnect(); } catch { /* ignore */ }
    },
  };
}

module.exports = { startPush, channelName };

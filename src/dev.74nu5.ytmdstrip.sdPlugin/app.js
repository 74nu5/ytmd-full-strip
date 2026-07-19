'use strict';

// ---------------------------------------------------------------------------
// YTMD Full Strip — composes an 800x100 image (album art + title + progress)
// and spreads it across the Stream Deck + dials, one 200x100 slice each.
// Seam testing showed that [0,0,200,100] layout rects are honoured without
// any inset, so the slices butt together with no visible discontinuity.
// ---------------------------------------------------------------------------

const YTMD = {
  appId: 'sdplusfullstrip',
  appName: 'SD+ Full Strip',
  appVersion: '1.0.0',
};

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9863;
const DEFAULT_SLOTS = 4;

// Settings driven by the Property Inspector (stored as global settings).
let host = DEFAULT_HOST;
let port = DEFAULT_PORT;
let slots = DEFAULT_SLOTS;

const STRIP_H = 100;
const SLOT_W = 200;

// Composition width: one 200px slice per occupied dial.
let stripW = DEFAULT_SLOTS * SLOT_W;

function baseUrl() {
  return 'http://' + host + ':' + port;
}
const ART = 100;          // square album art, sits entirely inside slot 0
const PAD = 12;           // gap between album art and text
const POLL_MS = 1000;

// trackState values reported by YTMD
const TRACK_PAUSED = 0;
const TRACK_PLAYING = 1;

let ws = null;
let pluginUUID = null;
let token = null;
const AUTH_RETRY_MS = 10000;          // back-off after a failed authorization
const AUTH_RETRY_LIMITED_MS = 60000;  // back-off after a 429

let authInFlight = false;
let authRetryAt = 0;
let authCode = null;
let lastError = null;
let piContext = null;   // Property Inspector context, when it is open

// Global settings also carry host/port/slots: never clobber them by writing
// the token alone.
function persistSettings(extra) {
  send({
    event: 'setGlobalSettings',
    context: pluginUUID,
    payload: Object.assign({ host: host, port: port, slots: slots }, extra || {}),
  });
}

const dials = new Map();       // context -> column 0..3

// Marketplace guidelines require surfacing failures through showAlert. It is
// only fired when the error actually changes: otherwise the retry loop would
// make the alert blink forever.
function alertDials() {
  dials.forEach(function (column, context) {
    send({ event: 'showAlert', context: context });
  });
}

function setError(message) {
  if (message && message !== lastError) {
    alertDials();
  }
  lastError = message;
}

const artCache = new Map();    // url -> ImageBitmap | HTMLImageElement
const artFailed = new Map();   // url -> timestamp of last failure (deferred retry)
const artInflight = new Set(); // url currently being fetched

const ART_RETRY_MS = 30000;

let state = null;
let volume = 50;
let lastPaintKey = '';
let ticks = 0;

const strip = document.getElementById('strip');
const sctx = strip.getContext('2d');
const slot = document.getElementById('slot');
const slotCtx = slot.getContext('2d');

// ---------------------------------------------------------------------------
// Stream Deck plumbing
// ---------------------------------------------------------------------------

function send(payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function log(message) {
  send({ event: 'logMessage', payload: { message: '[ytmdstrip] ' + message } });
}

function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo) {
  pluginUUID = inUUID;
  ws = new WebSocket('ws://127.0.0.1:' + inPort);

  ws.onopen = function () {
    send({ event: inRegisterEvent, uuid: inUUID });
    send({ event: 'getGlobalSettings', context: inUUID });
    log('registered');
    startMetronome();
  };

  ws.onmessage = function (evt) {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    handleEvent(msg);
  };
}
window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;

function handleEvent(msg) {
  switch (msg.event) {
    case 'didReceiveGlobalSettings':
      applySettings((msg.payload && msg.payload.settings) || {});
      break;

    case 'propertyInspectorDidAppear':
      piContext = msg.context;
      sendStatus();
      break;

    case 'propertyInspectorDidDisappear':
      piContext = null;
      break;

    case 'sendToPlugin': {
      const payload = msg.payload || {};
      if (payload.cmd === 'reset-auth') { resetAuth(); }
      if (payload.cmd === 'get-status') { sendStatus(); }
      break;
    }
    case 'willAppear': {
      const coords = msg.payload && msg.payload.coordinates;
      dials.set(msg.context, coords ? coords.column : 0);
      lastPaintKey = '';   // force a repaint on the newly added dial
      break;
    }
    case 'willDisappear':
      dials.delete(msg.context);
      break;
    case 'dialRotate':
      onRotate(msg.payload ? msg.payload.ticks : 0);
      break;
    case 'dialDown':
    case 'touchTap':
      command('playPause');
      break;
    case 'dialUp':
      flushVolume();   // make sure the final dial value is actually sent
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Settings (Property Inspector)
// ---------------------------------------------------------------------------

// Settings are global: they apply to every dial at once. Changing host or
// port requires reopening the real-time socket; changing the slice count
// requires resizing the canvas.
function applySettings(settings) {
  const wasToken = token;
  const previousEndpoint = host + ':' + port;

  token = settings.token || null;
  host = settings.host || DEFAULT_HOST;
  port = settings.port || DEFAULT_PORT;

  const wanted = Math.max(1, Math.min(4, settings.slots || DEFAULT_SLOTS));
  if (wanted !== slots) {
    slots = wanted;
    stripW = slots * SLOT_W;
    strip.width = stripW;          // resizing also clears the canvas
    log('composing across ' + slots + ' slice(s), ' + stripW + 'px wide');
  }

  if (host + ':' + port !== previousEndpoint) {
    log('target changed -> ' + baseUrl());
    dropRealtime();
  }

  if (token && !wasToken) { log('token restored from global settings'); }

  lastPaintKey = '';
  sendStatus();
}

function resetAuth() {
  log('authorization reset requested');
  token = null;
  authCode = null;
  setError(null);
  authRetryAt = 0;   // the button must trigger a new request right away
  dropRealtime();
  // Keep host/port/slots, forget only the token.
  send({
    event: 'setGlobalSettings',
    context: pluginUUID,
    payload: { host: host, port: port, slots: slots },
  });
  lastPaintKey = '';
  sendStatus();
}

function dropRealtime() {
  rtReady = false;
  if (rt) {
    try { rt.close(); } catch (e) { /* already closed */ }
    rt = null;
  }
  rtRetryAt = 0;
}

function sendStatus() {
  if (!piContext) { return; }

  let status;
  let level;
  if (!token && authCode) {
    status = 'Code ' + authCode + ' — approve it in YTMD';
    level = 'warn';
  } else if (!token) {
    status = 'Not authorized yet';
    level = 'warn';
  } else if (lastError) {
    status = lastError;
    level = 'err';
  } else if (rtReady) {
    status = 'Connected — real-time active';
    level = 'ok';
  } else {
    status = 'Connected — degraded (polling)';
    level = 'warn';
  }

  send({
    event: 'sendToPropertyInspector',
    action: 'dev.74nu5.ytmdstrip.slice',
    context: piContext,
    payload: { status: status, level: level },
  });
}

// ---------------------------------------------------------------------------
// API YTMD
// ---------------------------------------------------------------------------

async function api(path, options) {
  // no-store is mandatory: without it Chromium serves the first /state
  // response from cache forever and the display freezes on that sample.
  const opts = Object.assign({ cache: 'no-store', headers: {} }, options || {});
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
  if (token) {
    opts.headers['Authorization'] = token;
  }
  return fetch(baseUrl() + path, opts);
}

async function command(name, data) {
  if (!token) { return; }
  try {
    const body = data === undefined ? { command: name } : { command: name, data: data };
    await api('/api/v1/command', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    alertDials();
    log('command ' + name + ' failed: ' + e);
  }
}

// One detent = one dialRotate event. Sending a setVolume per detent trips
// YTMD's rate limit (HTTP 429). Commands are coalesced instead: at most one
// every VOLUME_MIN_MS, with the final value flushed on release.
// No setTimeout here — see the metronome note about background timers.
const VOLUME_MIN_MS = 200;
let pendingVolume = null;
let lastVolumeSentAt = 0;

function onRotate(ticks) {
  if (!ticks) { return; }
  volume = Math.max(0, Math.min(100, volume + ticks * 2));
  pendingVolume = volume;
  flushVolume();
}

function flushVolume() {
  if (pendingVolume === null) { return; }
  const now = Date.now();
  if (now - lastVolumeSentAt < VOLUME_MIN_MS) { return; }
  lastVolumeSentAt = now;
  const value = pendingVolume;
  pendingVolume = null;
  command('setVolume', value);
}

// Token request. YTMD shows a code the user must approve; /auth/request
// blocks until they do.
//
// Until "Enable companion authorization" is ticked, the server answers 403.
// Without a back-off we would re-request on every tick and YTMD would end up
// rate limiting us (429). This is the typical first-run experience, so it has
// to stay quiet on the server side.
async function requestToken() {
  if (authInFlight || Date.now() < authRetryAt) { return; }
  authInFlight = true;
  try {
    const r = await api('/api/v1/auth/requestcode', {
      method: 'POST',
      body: JSON.stringify({
        appId: YTMD.appId,
        appName: YTMD.appName,
        appVersion: YTMD.appVersion,
      }),
    });
    if (!r.ok) {
      setError(r.status === 403
        ? 'Enable "companion authorization" in YTMD'
        : 'requestcode HTTP ' + r.status);
      authCode = null;
      authRetryAt = Date.now() + (r.status === 429 ? AUTH_RETRY_LIMITED_MS : AUTH_RETRY_MS);
      log(lastError + ' — retrying in '
        + Math.round((authRetryAt - Date.now()) / 1000) + 's');
      return;
    }
    const payload = await r.json();
    authCode = payload.code;
    setError(null);
    log('code to approve: ' + authCode);
    paint();   // show the code on the strip
    sendStatus();

    const r2 = await api('/api/v1/auth/request', {
      method: 'POST',
      body: JSON.stringify({ appId: YTMD.appId, code: authCode }),
    });
    if (!r2.ok) {
      setError('Authorization declined or expired');
      authCode = null;
      authRetryAt = Date.now() + AUTH_RETRY_MS;
      return;
    }
    const granted = await r2.json();
    token = granted.token;
    authCode = null;
    setError(null);
    // The token lives in Stream Deck's global settings, not in a plaintext file.
    persistSettings({ token: token });
    log('token granted and stored');
    sendStatus();
  } catch (e) {
    setError('YTMD unreachable');
    authRetryAt = Date.now() + AUTH_RETRY_MS;
    log('auth failed: ' + e);
  } finally {
    authInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Real time (socket.io). Push beats polling here: network frames arrive
// whenever they arrive. The Engine.IO/Socket.IO v4 protocol is spoken
// directly over a raw WebSocket rather than bundling the socket.io library.
//
//   "0{...}"            Engine.IO open
//   "40<ns>,<authJSON>" namespace connect (we send this one)
//   "42<ns>,[ev,data]"  event
//   "2" / "3"           server ping / client pong
//   "44<ns>,<err>"      namespace connection refused
// ---------------------------------------------------------------------------

const RT_NAMESPACE = '/api/v1/realtime';
let rt = null;
let rtReady = false;
let rtRetryAt = 0;
let rtEvents = 0;
let rtFirstAt = 0;
let pollBackoffUntil = 0;

function ensureRealtime() {
  if (!token || rt || Date.now() < rtRetryAt) { return; }

  try {
    rt = new WebSocket('ws://' + host + ':' + port + '/socket.io/?EIO=4&transport=websocket');
  } catch (e) {
    log('realtime: could not open socket (' + e.message + ')');
    scheduleRealtimeRetry();
    return;
  }

  rt.onmessage = function (evt) {
    const data = typeof evt.data === 'string' ? evt.data : '';
    if (!data) { return; }

    if (data === '2') { rt.send('3'); return; }               // ping -> pong

    if (data.charAt(0) === '0') {                             // handshake
      rt.send('40' + RT_NAMESPACE + ',' + JSON.stringify({ token: token }));
      return;
    }

    if (data.indexOf('40' + RT_NAMESPACE) === 0) {
      rtReady = true;
      log('realtime: connected, push active');
      sendStatus();
      return;
    }

    if (data.indexOf('44') === 0) {
      log('realtime: namespace refused -> ' + data.slice(2, 200));
      rtReady = false;
      return;
    }

    if (data.indexOf('42') === 0) {
      const comma = data.indexOf(',');
      const json = comma === -1 ? data.slice(2) : data.slice(comma + 1);
      let frame;
      try { frame = JSON.parse(json); } catch (e) { return; }
      if (frame[0] === 'state-update' && frame[1]) {
        state = frame[1];
        // Do not overwrite the local value while a detent is still pending,
        // otherwise the dial appears to jump back between coalesced commands.
        if (pendingVolume === null && state.player && typeof state.player.volume === 'number') {
          volume = state.player.volume;
        }
        setError(null);

        rtEvents += 1;
        if (rtEvents === 1) { rtFirstAt = Date.now(); }
        // Rare trace (~every 5 min): enough to confirm push is alive without
        // drowning the log. YTMD emits roughly every 270 ms.
        if (rtEvents % 1000 === 0) {
          log('realtime: ' + rtEvents + ' state-update, ~'
            + Math.round((Date.now() - rtFirstAt) / rtEvents) + 'ms entre deux');
        }

        paint();
      }
    }
  };

  rt.onclose = function () {
    rtReady = false;
    rt = null;
    scheduleRealtimeRetry();
    sendStatus();
  };

  rt.onerror = function () { /* onclose always follows: recovery is handled there */ };
}

function scheduleRealtimeRetry() {
  rtRetryAt = Date.now() + 5000;
}

// Metronome for the fallback polling loop (the nominal path is socket.io push).
//
// This is defensive: a plugin page is never visible, and Chromium is known to
// throttle timers on backgrounded pages, which Worker timers escape. To be
// honest, throttling was NOT actually proven on this engine — the ~5s spacing
// measured during development turned out to be fetch latency under rate
// limiting, not the timer. So the Worker is precautionary rather than strictly
// required; plain setInterval would most likely do. Created from a Blob URL,
// because a worker loaded from file:// would be rejected.
function startMetronome() {
  try {
    const source = 'setInterval(function () { postMessage(0); }, ' + POLL_MS + ');';
    const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = function () { tick(); };
    log('metronome: Worker active');
  } catch (e) {
    setInterval(tick, POLL_MS);
    log('metronome: Worker refused (' + e.message + '), falling back to setInterval');
  }
}

async function tick() {
  if (!dials.size) { return; }

  if (!token) {
    await requestToken();
    paint();
    return;
  }

  ensureRealtime();
  flushVolume();   // flush any dial detent still waiting to be sent

  // When push is active it does all the work; this polling loop is only a
  // safety net for when the socket drops.
  if (rtReady) {
    ticks += 1;
    if (ticks % 600 === 0) { log('heartbeat: push active, dials=' + dials.size); }
    return;
  }

  // After a 429, let the pressure drop instead of hammering.
  if (Date.now() < pollBackoffUntil) { return; }

  try {
    const r = await api('/api/v1/state');
    if (r.status === 401) {
      token = null;                       // token revoked -> restart the auth flow
      persistSettings();
      sendStatus();
      return;
    }
    if (r.status === 429) {
      pollBackoffUntil = Date.now() + 20000;
      log('429: YTMD is rate limiting, pausing polling for 20s');
      return;   // keep the current display rather than showing an error
    }
    if (!r.ok) { setError('state HTTP ' + r.status); paint(); return; }
    state = await r.json();
    if (state && state.player && typeof state.player.volume === 'number') {
      volume = state.player.volume;
    }
    setError(null);
  } catch (e) {
    setError('YTMD offline');
    state = null;
  }

  // We only reach this point when push has dropped: report it, without spamming.
  ticks += 1;
  if (ticks % 12 === 0) {
    log('degraded: push unavailable, falling back to polling (dials=' + dials.size + ')');
  }

  paint();
}

// ---------------------------------------------------------------------------
// Album art
// ---------------------------------------------------------------------------

// Two routes, both keeping the canvas "clean" so that toDataURL() does not
// throw SecurityError: fetch->blob->ImageBitmap first, then an
// <img crossOrigin="anonymous"> fallback if the fetch is refused.
async function fetchArt(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.ok) {
      return await createImageBitmap(await r.blob());
    }
    log('album art: HTTP ' + r.status);
  } catch (e) {
    log('album art: fetch refused (' + e.message + '), falling back to <img>');
  }
  try {
    return await new Promise(function (resolve, reject) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('onerror')); };
      img.src = url;
    });
  } catch (e) {
    log('album art: <img> fallback failed too (' + e.message + ')');
  }
  return null;
}

// Synchronous: returns the album art if ready, otherwise kicks off the load
// and returns null. A failure is retried after ART_RETRY_MS instead of being
// remembered forever.
function getArt(url) {
  if (!url) { return null; }
  if (artCache.has(url)) { return artCache.get(url); }
  if (artInflight.has(url)) { return null; }

  const failedAt = artFailed.get(url);
  if (failedAt && (Date.now() - failedAt) < ART_RETRY_MS) { return null; }

  artInflight.add(url);
  fetchArt(url).then(function (img) {
    artInflight.delete(url);
    if (img) {
      artCache.set(url, img);
      artFailed.delete(url);
      log('album art loaded (' + img.width + 'x' + img.height + ')');
    } else {
      artFailed.set(url, Date.now());
    }
    lastPaintKey = '';   // force a repaint, on success as well as on failure
  });
  return null;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) { return text; }
  let out = text;
  while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + '…';
}

function mmss(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function drawMessage(title, subtitle) {
  sctx.fillStyle = '#0d0d16';
  sctx.fillRect(0, 0, stripW, STRIP_H);
  sctx.textAlign = 'center';
  sctx.fillStyle = '#ffffff';
  sctx.font = '600 30px "Segoe UI", -apple-system, "Helvetica Neue", sans-serif';
  sctx.fillText(title, stripW / 2, 46);
  if (subtitle) {
    sctx.fillStyle = '#9aa0b5';
    sctx.font = '400 20px "Segoe UI", -apple-system, "Helvetica Neue", sans-serif';
    sctx.fillText(subtitle, stripW / 2, 76);
  }
  sctx.textAlign = 'left';
}

function drawNowPlaying(art, video, player) {
  const playing = player.trackState === TRACK_PLAYING;

  // Background: the album art, blurred and darkened, stretched full width.
  sctx.fillStyle = '#0d0d16';
  sctx.fillRect(0, 0, stripW, STRIP_H);
  if (art) {
    sctx.save();
    sctx.filter = 'blur(18px)';
    sctx.globalAlpha = 0.55;
    sctx.drawImage(art, 0, -stripW / 4, stripW, stripW / 2);
    sctx.restore();
    sctx.fillStyle = 'rgba(8, 8, 18, 0.62)';
    sctx.fillRect(0, 0, stripW, STRIP_H);
  }

  // Sharp album art, flush left (entirely within slot 0).
  if (art) {
    sctx.drawImage(art, 0, 0, ART, ART);
  } else {
    sctx.fillStyle = '#242437';
    sctx.fillRect(0, 0, ART, ART);
    sctx.fillStyle = '#5b5b7a';
    sctx.font = '400 46px "Segoe UI", -apple-system, "Helvetica Neue", sans-serif';
    sctx.textAlign = 'center';
    sctx.fillText('♪', ART / 2, 66);
    sctx.textAlign = 'left';
  }

  const x = ART + PAD;
  const w = stripW - x - PAD;

  sctx.fillStyle = playing ? '#ffffff' : '#8e93a8';
  sctx.font = '600 30px "Segoe UI", -apple-system, "Helvetica Neue", sans-serif';
  sctx.fillText(fitText(sctx, video.title || 'Nothing playing', w), x, 36);

  sctx.fillStyle = playing ? '#c3c7d8' : '#71768a';
  sctx.font = '400 22px "Segoe UI", -apple-system, "Helvetica Neue", sans-serif';
  const artist = [video.author, video.album].filter(Boolean).join('  ·  ');
  sctx.fillText(fitText(sctx, artist, w - 90), x, 66);

  // Progress bar and timing, right-aligned on the strip.
  const duration = video.durationSeconds || 0;
  const progress = player.videoProgress || 0;
  const ratio = duration > 0 ? Math.min(1, progress / duration) : 0;

  sctx.fillStyle = '#c3c7d8';
  sctx.font = '400 17px "Segoe UI", -apple-system, "Helvetica Neue", sans-serif';
  sctx.textAlign = 'right';
  sctx.fillText(mmss(progress) + ' / ' + mmss(duration), stripW - PAD, 66);
  sctx.textAlign = 'left';

  const barY = 84;
  sctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
  sctx.fillRect(x, barY, w, 5);
  sctx.fillStyle = playing ? '#ff2d55' : '#6b6b80';
  sctx.fillRect(x, barY, w * ratio, 5);

  if (!playing) {
    sctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    sctx.fillRect(stripW - 30, 12, 5, 18);
    sctx.fillRect(stripW - 21, 12, 5, 18);
  }
}

function paint() {
  if (!dials.size) { return; }

  const video = (state && state.video) || null;
  const player = (state && state.player) || null;
  let art = null;

  // Repaint key: only push pixels when something actually changed.
  let key;
  if (!token && authCode) {
    key = 'code:' + authCode;
  } else if (lastError) {
    key = 'err:' + lastError;
  } else if (video && player) {
    const url = video.thumbnails && video.thumbnails.length
      ? video.thumbnails[video.thumbnails.length - 1].url
      : null;
    art = getArt(url);
    key = [video.title, player.trackState, Math.floor(player.videoProgress || 0), !!art].join('|');
  } else {
    key = 'idle';
  }
  if (key === lastPaintKey) { return; }
  lastPaintKey = key;

  if (!token && authCode) {
    drawMessage('Code ' + authCode, 'Approve the request in YouTube Music Desktop');
  } else if (lastError) {
    drawMessage('YTMD', lastError);
  } else if (video && player) {
    drawNowPlaying(art, video, player);
  } else {
    drawMessage('Nothing playing', null);
  }

  pushSlices();
}

function pushSlices() {
  try {
    dials.forEach(function (column, context) {
      const col = ((column % slots) + slots) % slots;
      slotCtx.clearRect(0, 0, SLOT_W, STRIP_H);
      slotCtx.drawImage(strip, col * SLOT_W, 0, SLOT_W, STRIP_H, 0, 0, SLOT_W, STRIP_H);
      send({
        event: 'setFeedback',
        context: context,
        payload: { canvas: slot.toDataURL('image/png') },
      });
    });
  } catch (e) {
    // Typically SecurityError if the canvas got tainted by a cross-origin
    // image: without this guard the failure would be completely silent.
    log('pushSlices failed: ' + e.name + ' ' + e.message);
  }
}

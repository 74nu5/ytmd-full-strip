'use strict';

// ---------------------------------------------------------------------------
// YTMD Full Strip — compose une image 800x100 (pochette + titre + progression)
// et la repartit sur les 4 encodeurs du Stream Deck +, une tranche 200x100 par
// dial. Les tests de couture ont montre que les rects [0,0,200,100] sont
// honores sans marge : les 4 tranches se raboutent sans discontinuite.
// ---------------------------------------------------------------------------

const YTMD = {
  base: 'http://127.0.0.1:9863',
  appId: 'sdplusfullstrip',
  appName: 'SD+ Full Strip',
  appVersion: '1.0.0',
};

const STRIP_W = 800;
const STRIP_H = 100;
const SLOT_W = 200;
const ART = 100;          // pochette carree, calee dans le slot 0
const PAD = 12;           // marge entre pochette et texte
const POLL_MS = 1000;

// trackState renvoye par YTMD
const TRACK_PAUSED = 0;
const TRACK_PLAYING = 1;

let ws = null;
let pluginUUID = null;
let token = null;
let authInFlight = false;
let authCode = null;
let lastError = null;

const dials = new Map();       // context -> colonne 0..3
const artCache = new Map();    // url -> ImageBitmap | HTMLImageElement
const artFailed = new Map();   // url -> horodatage du dernier echec (retry differé)
const artInflight = new Set(); // url en cours de chargement

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
// Liaison Stream Deck
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
    log('enregistre');
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
    case 'didReceiveGlobalSettings': {
      const settings = (msg.payload && msg.payload.settings) || {};
      if (settings.token) {
        token = settings.token;
        log('token restaure depuis les global settings');
      }
      break;
    }
    case 'willAppear': {
      const coords = msg.payload && msg.payload.coordinates;
      dials.set(msg.context, coords ? coords.column : 0);
      lastPaintKey = '';   // force un repaint sur le nouveau dial
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
      flushVolume();   // garantit que la derniere valeur de la molette part bien
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// API YTMD
// ---------------------------------------------------------------------------

async function api(path, options) {
  // no-store est indispensable : sans lui Chromium ressert la premiere reponse
  // de /state en cache et l'affichage reste fige sur le premier echantillon.
  const opts = Object.assign({ cache: 'no-store', headers: {} }, options || {});
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
  if (token) {
    opts.headers['Authorization'] = token;
  }
  return fetch(YTMD.base + path, opts);
}

async function command(name, data) {
  if (!token) { return; }
  try {
    const body = data === undefined ? { command: name } : { command: name, data: data };
    await api('/api/v1/command', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    log('commande ' + name + ' KO: ' + e);
  }
}

// Un cran de molette = un evenement dialRotate. Envoyer un setVolume par cran
// declenche le rate-limit de YTMD (HTTP 429). On coalesce : au plus une commande
// tous les VOLUME_MIN_MS, la derniere valeur etant poussee au relachement.
// Pas de setTimeout ici : les timers de cette page sont brides a ~5s.
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

// Demande de token. YTMD affiche un code que l'utilisateur doit approuver ;
// /auth/request bloque jusqu'a l'approbation.
async function requestToken() {
  if (authInFlight) { return; }
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
      lastError = r.status === 403
        ? 'Active "Enable companion authorization" dans YTMD'
        : 'requestcode HTTP ' + r.status;
      authCode = null;
      log(lastError);
      return;
    }
    const payload = await r.json();
    authCode = payload.code;
    lastError = null;
    log('code a approuver: ' + authCode);
    paint();   // affiche le code sur le bandeau

    const r2 = await api('/api/v1/auth/request', {
      method: 'POST',
      body: JSON.stringify({ appId: YTMD.appId, code: authCode }),
    });
    if (!r2.ok) {
      lastError = 'approbation refusee ou expiree';
      authCode = null;
      return;
    }
    const granted = await r2.json();
    token = granted.token;
    authCode = null;
    lastError = null;
    // Le token vit dans les global settings de Stream Deck, pas en clair sur disque.
    send({ event: 'setGlobalSettings', context: pluginUUID, payload: { token: token } });
    log('token obtenu et enregistre');
  } catch (e) {
    lastError = 'YTMD injoignable';
    log('auth KO: ' + e);
  } finally {
    authInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Temps reel (socket.io) — le seul moyen d'echapper au bridage des timers :
// les trames reseau, elles, arrivent quand elles veulent. On parle le
// protocole Engine.IO/Socket.IO v4 directement sur une WebSocket brute,
// plutot que d'embarquer la bibliotheque socket.io.
//
//   "0{...}"            ouverture Engine.IO
//   "40<ns>,<authJSON>" connexion au namespace (c'est nous qui l'envoyons)
//   "42<ns>,[ev,data]"  evenement
//   "2" / "3"           ping serveur / pong client
//   "44<ns>,<err>"      connexion au namespace refusee
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
    rt = new WebSocket('ws://127.0.0.1:9863/socket.io/?EIO=4&transport=websocket');
  } catch (e) {
    log('realtime: ouverture KO (' + e.message + ')');
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
      log('realtime: connecte, push actif');
      return;
    }

    if (data.indexOf('44') === 0) {
      log('realtime: namespace refuse -> ' + data.slice(2, 200));
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
        // Ne pas ecraser la valeur locale tant qu'un cran attend son envoi,
        // sinon la molette "recule" entre deux commandes coalescees.
        if (pendingVolume === null && state.player && typeof state.player.volume === 'number') {
          volume = state.player.volume;
        }
        lastError = null;

        rtEvents += 1;
        if (rtEvents === 1) { rtFirstAt = Date.now(); }
        // Trace rare (~toutes les 5 min) : suffit a confirmer que le push vit,
        // sans noyer le log. YTMD emet environ toutes les 270 ms.
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
  };

  rt.onerror = function () { /* onclose suit toujours : on y gere la reprise */ };
}

function scheduleRealtimeRetry() {
  rtRetryAt = Date.now() + 5000;
}

// Metronome du polling de secours (le chemin nominal est le push socket.io).
//
// Il est ici par precaution : la page d'un plugin n'est jamais visible, et
// Chromium sait brider les timers des pages en arriere-plan. Les timers d'un
// Worker y echappent. Honnetement, le bridage n'a PAS ete prouve sur ce
// moteur — les ~5s mesurees pendant la mise au point venaient en fait de la
// latence des fetch sous rate-limiting, pas du timer. Le Worker est donc
// defensif plutot que strictement necessaire ; setInterval suffirait
// probablement. Cree depuis une Blob URL, car un worker charge depuis
// file:// serait refuse.
function startMetronome() {
  try {
    const source = 'setInterval(function () { postMessage(0); }, ' + POLL_MS + ');';
    const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = function () { tick(); };
    log('metronome: Worker actif');
  } catch (e) {
    setInterval(tick, POLL_MS);
    log('metronome: Worker refuse (' + e.message + '), repli sur setInterval bride');
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
  flushVolume();   // rattrape un dernier cran de molette reste en attente

  // Quand le push est actif, il fait tout le travail : ce polling bride a ~5s
  // ne sert plus que de filet si la socket tombe.
  if (rtReady) {
    ticks += 1;
    if (ticks % 600 === 0) { log('battement: push actif, dials=' + dials.size); }
    return;
  }

  // Apres un 429, on laisse retomber la pression au lieu de marteler.
  if (Date.now() < pollBackoffUntil) { return; }

  try {
    const r = await api('/api/v1/state');
    if (r.status === 401) {
      token = null;                       // token revoque -> on repart en auth
      send({ event: 'setGlobalSettings', context: pluginUUID, payload: {} });
      return;
    }
    if (r.status === 429) {
      pollBackoffUntil = Date.now() + 20000;
      log('429 : YTMD limite le debit, pause de 20s du polling');
      return;   // on garde l'affichage courant plutot que d'afficher une erreur
    }
    if (!r.ok) { lastError = 'state HTTP ' + r.status; paint(); return; }
    state = await r.json();
    if (state && state.player && typeof state.player.volume === 'number') {
      volume = state.player.volume;
    }
    lastError = null;
  } catch (e) {
    lastError = 'YTMD hors ligne';
    state = null;
  }

  // Battement toutes les 15 s : prouve que la boucle tourne ET que la
  // progression avance vraiment. C'est ce qui manquait pour diagnostiquer le gel.
  // On n'arrive ici que si le push est tombe : le signaler, sans spammer.
  ticks += 1;
  if (ticks % 12 === 0) {
    log('mode degrade : push indisponible, polling bride (dials=' + dials.size + ')');
  }

  paint();
}

// ---------------------------------------------------------------------------
// Pochette
// ---------------------------------------------------------------------------

// Deux voies, toutes deux gardant le canvas "propre" pour que toDataURL()
// ne leve pas SecurityError : fetch->blob->ImageBitmap, puis repli sur un
// <img crossOrigin="anonymous"> si le fetch est refuse.
async function fetchArt(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.ok) {
      return await createImageBitmap(await r.blob());
    }
    log('pochette: HTTP ' + r.status);
  } catch (e) {
    log('pochette: fetch refuse (' + e.message + '), repli sur <img>');
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
    log('pochette: repli <img> KO aussi (' + e.message + ')');
  }
  return null;
}

// Synchrone : rend la pochette si elle est prete, sinon lance le chargement
// et retourne null. Un echec est reessaye au bout de ART_RETRY_MS au lieu
// d'etre memorise definitivement.
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
      log('pochette chargee (' + img.width + 'x' + img.height + ')');
    } else {
      artFailed.set(url, Date.now());
    }
    lastPaintKey = '';   // force le repaint, que ce soit un succes ou un echec
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
  sctx.fillRect(0, 0, STRIP_W, STRIP_H);
  sctx.textAlign = 'center';
  sctx.fillStyle = '#ffffff';
  sctx.font = '600 30px "Segoe UI", sans-serif';
  sctx.fillText(title, STRIP_W / 2, 46);
  if (subtitle) {
    sctx.fillStyle = '#9aa0b5';
    sctx.font = '400 20px "Segoe UI", sans-serif';
    sctx.fillText(subtitle, STRIP_W / 2, 76);
  }
  sctx.textAlign = 'left';
}

function drawNowPlaying(art, video, player) {
  const playing = player.trackState === TRACK_PLAYING;

  // Fond : la pochette floutee et assombrie, etiree sur tout le bandeau.
  sctx.fillStyle = '#0d0d16';
  sctx.fillRect(0, 0, STRIP_W, STRIP_H);
  if (art) {
    sctx.save();
    sctx.filter = 'blur(18px)';
    sctx.globalAlpha = 0.55;
    sctx.drawImage(art, 0, -STRIP_W / 4, STRIP_W, STRIP_W / 2);
    sctx.restore();
    sctx.fillStyle = 'rgba(8, 8, 18, 0.62)';
    sctx.fillRect(0, 0, STRIP_W, STRIP_H);
  }

  // Pochette nette, calee a gauche (entierement dans le slot 0).
  if (art) {
    sctx.drawImage(art, 0, 0, ART, ART);
  } else {
    sctx.fillStyle = '#242437';
    sctx.fillRect(0, 0, ART, ART);
    sctx.fillStyle = '#5b5b7a';
    sctx.font = '400 46px "Segoe UI", sans-serif';
    sctx.textAlign = 'center';
    sctx.fillText('♪', ART / 2, 66);
    sctx.textAlign = 'left';
  }

  const x = ART + PAD;
  const w = STRIP_W - x - PAD;

  sctx.fillStyle = playing ? '#ffffff' : '#8e93a8';
  sctx.font = '600 30px "Segoe UI", sans-serif';
  sctx.fillText(fitText(sctx, video.title || 'Rien en lecture', w), x, 36);

  sctx.fillStyle = playing ? '#c3c7d8' : '#71768a';
  sctx.font = '400 22px "Segoe UI", sans-serif';
  const artist = [video.author, video.album].filter(Boolean).join('  ·  ');
  sctx.fillText(fitText(sctx, artist, w - 90), x, 66);

  // Progression + minutage, aligne a droite du bandeau.
  const duration = video.durationSeconds || 0;
  const progress = player.videoProgress || 0;
  const ratio = duration > 0 ? Math.min(1, progress / duration) : 0;

  sctx.fillStyle = '#c3c7d8';
  sctx.font = '400 17px "Segoe UI", sans-serif';
  sctx.textAlign = 'right';
  sctx.fillText(mmss(progress) + ' / ' + mmss(duration), STRIP_W - PAD, 66);
  sctx.textAlign = 'left';

  const barY = 84;
  sctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
  sctx.fillRect(x, barY, w, 5);
  sctx.fillStyle = playing ? '#ff2d55' : '#6b6b80';
  sctx.fillRect(x, barY, w * ratio, 5);

  if (!playing) {
    sctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    sctx.fillRect(STRIP_W - 30, 12, 5, 18);
    sctx.fillRect(STRIP_W - 21, 12, 5, 18);
  }
}

function paint() {
  if (!dials.size) { return; }

  const video = (state && state.video) || null;
  const player = (state && state.player) || null;
  let art = null;

  // Cle de repaint : on ne pousse des pixels que si quelque chose a bouge.
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
    drawMessage('Code ' + authCode, 'Approuve la demande dans YouTube Music Desktop');
  } else if (lastError) {
    drawMessage('YTMD', lastError);
  } else if (video && player) {
    drawNowPlaying(art, video, player);
  } else {
    drawMessage('Rien en lecture', null);
  }

  pushSlices();
}

function pushSlices() {
  try {
    dials.forEach(function (column, context) {
      const col = ((column % 4) + 4) % 4;
      slotCtx.clearRect(0, 0, SLOT_W, STRIP_H);
      slotCtx.drawImage(strip, col * SLOT_W, 0, SLOT_W, STRIP_H, 0, 0, SLOT_W, STRIP_H);
      send({
        event: 'setFeedback',
        context: context,
        payload: { canvas: slot.toDataURL('image/png') },
      });
    });
  } catch (e) {
    // Typiquement SecurityError si le canvas a ete teinte par une image
    // cross-origin : sans ce garde, l'echec serait totalement silencieux.
    log('pushSlices KO: ' + e.name + ' ' + e.message);
  }
}

'use strict';

// The Midnight Express — live game-state server.
//
// Responsibilities:
//   1. Serve the static DC screens (buzzer, main display, countdown) + support.js + assets.
//   2. Hold the one true game state in Redis and fan changes out over WebSocket.
//
// The screens themselves don't know any of this exists: dc-net.js on the client
// intercepts the `nighttrain_*` localStorage keys and pipes them through /ws.

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { createClient } = require('redis');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
// Simple gate for the Game Master screen. Not real security — just keeps guests
// from wandering into the controls. Change it in docker-compose.yml.
const GM_PASSWORD = process.env.GM_PASSWORD || 'midnight';

// Everything the screens share lives under this namespace. The client shim only
// forwards keys with this prefix, so the GM screen can invent new keys later
// (e.g. nighttrain_round_v1) without any server change.
const KEY_PREFIX = 'nighttrain_';
const REDIS_HASH = 'nighttrain:state'; // field -> JSON string (opaque to us)
const REDIS_CHANNEL = 'nighttrain:events';

const STATIC_DIR = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.resolve(__dirname, '..');

const isManagedKey = (k) => typeof k === 'string' && k.startsWith(KEY_PREFIX);

// ---------------------------------------------------------------------------
// Redis: one client for commands, a second (duplicated) for pub/sub.
// State writes go SET-then-PUBLISH; the subscriber loops the event back and is
// the single path that broadcasts to WebSocket clients — so the writer's own
// screens get the echo too, and it stays correct if this ever runs multi-process.
// ---------------------------------------------------------------------------
const redis = createClient({ url: REDIS_URL });
const sub = redis.duplicate();

redis.on('error', (e) => console.error('[redis] command client error:', e.message));
sub.on('error', (e) => console.error('[redis] subscriber error:', e.message));

async function connectRedis() {
  await Promise.all([redis.connect(), sub.connect()]);
  await sub.subscribe(REDIS_CHANNEL, (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // msg: { key, value }  where value is a JSON string, or null for a delete
    broadcast({ type: 'update', key: msg.key, value: msg.value });
  });
  console.log('[redis] connected:', REDIS_URL);
}

async function readSnapshot() {
  const all = await redis.hGetAll(REDIS_HASH); // { key: jsonString }
  return all || {};
}

async function setKey(key, value /* string */) {
  await redis.hSet(REDIS_HASH, key, value);
  await redis.publish(REDIS_CHANNEL, JSON.stringify({ key, value }));
}

async function delKey(key) {
  await redis.hDel(REDIS_HASH, key);
  await redis.publish(REDIS_CHANNEL, JSON.stringify({ key, value: null }));
}

// ---------------------------------------------------------------------------
// Seats & access codes.
// Each character gets a private 4-letter code. A player enters (or scans) their
// code; the server hands back that character's identity (and, later, their
// secret briefing). Codes live in Redis so they're stable across restarts and
// are NEVER served in the public game.json — identity is only revealed for a
// valid code, which is what keeps future per-player secrets private.
// ---------------------------------------------------------------------------
const REDIS_CODES = 'nighttrain:seatcodes'; // field: seat index -> code
const CODE_ALPHABET = 'ABCDEFGHJKLMNPRSTUVWXYZ'; // no I/O/Q — unambiguous when read aloud
const CODE_LEN = 4;

let characters = [];       // [{ name, role }] from game.json
let codeToSeat = new Map(); // 'WXYZ' -> index
let seatToCode = [];        // index -> 'WXYZ'

function loadCharacters() {
  try {
    const raw = fs.readFileSync(path.join(STATIC_DIR, 'game.json'), 'utf8');
    const g = JSON.parse(raw);
    characters = Array.isArray(g.characters) ? g.characters : [];
  } catch (e) {
    console.error('[seats] could not read game.json:', e.message);
    characters = [];
  }
}

function genCode() {
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return c;
}

async function ensureCodes() {
  loadCharacters();
  const existing = (await redis.hGetAll(REDIS_CODES)) || {};
  codeToSeat = new Map();
  seatToCode = [];
  // keep any existing codes; mint codes for seats that don't have one yet
  for (let i = 0; i < characters.length; i++) {
    let code = existing[String(i)];
    if (!code) {
      do { code = genCode(); } while (codeToSeat.has(code) || Object.values(existing).includes(code));
      await redis.hSet(REDIS_CODES, String(i), code);
    }
    seatToCode[i] = code;
    codeToSeat.set(code, i);
  }
  console.log(`[seats] ${characters.length} seats ready with access codes`);
}

function seatList() {
  return characters.map((c, i) => ({ index: i, name: c.name, role: c.role || '', code: seatToCode[i] }));
}

function claimSeat(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!codeToSeat.has(code)) return null;
  const i = codeToSeat.get(code);
  // NOTE: future secret briefing fields would be attached here, never in game.json.
  return { index: i, name: characters[i].name, role: characters[i].role || '' };
}

// Build the public-facing base URL from the (Cloudflare-forwarded) request headers.
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// HTTP: static screens + friendly routes.
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, redis: redis.isReady, clients: wss ? wss.clients.size : 0, seats: characters.length });
});

// --- Seats / codes / QR ----------------------------------------------------
// GM-only view of every seat's access code + deep link. (No auth yet — behind
// Cloudflare Access or a GM token this is where you'd lock it down.)
app.get('/api/seats', (req, res) => {
  const base = baseUrl(req);
  res.json(seatList().map((s) => ({ ...s, joinUrl: `${base}/play?code=${s.code}` })));
});

// GM password check (client stores an ok flag locally after this passes).
app.post('/api/gm-auth', (req, res) => {
  const ok = String(req.body && req.body.password || '') === GM_PASSWORD;
  res.json({ ok });
});

// Player exchanges a code for their character identity.
app.post('/api/claim', (req, res) => {
  const seat = claimSeat(req.body && req.body.code);
  if (!seat) return res.status(404).json({ error: 'invalid code' });
  res.json(seat);
});

// QR image (SVG) that deep-links a player straight into their seat.
app.get('/qr', async (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  const target = code ? `${baseUrl(req)}/play?code=${code}` : `${baseUrl(req)}/join`;
  try {
    const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (e) {
    res.status(500).send('qr error');
  }
});

// Clean, QR-friendly routes for the spaced .dc.html filenames. No trailing
// slash, so relative `./support.js` and `assets/...` resolve against `/`.
const SCREENS = {
  '/display': 'Main Display.html',              // TV shell — auto-switches countdown/voting
  '/gm': 'Game Master.html',                    // Game Master control panel
  '/buzzer': 'Buzzer.dc.html',                  // iPad
  '/play': 'Player.html',                       // player's own character screen
  '/join': 'Player.html',                       // code-entry entry point (same page)
  '/voting': 'Main Display - Voting.dc.html',   // inner screen (embedded by /display)
  '/countdown': 'Main Display - Countdown.dc.html', // inner screen (embedded by /display)
};
for (const [route, file] of Object.entries(SCREENS)) {
  app.get(route, (_req, res) => res.sendFile(path.join(STATIC_DIR, file)));
}

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Midnight Express — Screens</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:ui-serif,Georgia,serif;background:radial-gradient(120% 90% at 50% 30%,#2c1d10,#0f0905);color:#efe0bd}
  .card{text-align:center;padding:40px}
  h1{font-size:clamp(24px,5vw,44px);letter-spacing:.08em;margin:0 0 6px;color:#f0e2bf}
  p{color:#a8895a;letter-spacing:.24em;text-transform:uppercase;font-size:12px;margin:0 0 28px}
  a{display:block;margin:10px auto;max-width:340px;padding:14px 20px;border:1px solid #6a4f2a;
    border-radius:8px;color:#e6c877;text-decoration:none;letter-spacing:.14em;text-transform:uppercase;font-size:15px}
  a:hover{background:rgba(214,168,74,.1);color:#f3dd9b}
</style>
<div class="card">
  <h1>The Midnight Express</h1>
  <p>Game screens</p>
  <a href="/display">Main Display · TV</a>
  <a href="/gm">Game Master · Phone</a>
  <a href="/buzzer">Buzzer · iPad</a>
  <a href="/join">Join · Player</a>
</div>`);
});

// support.js, dc-net.js, /assets, /uploads, and the raw filenames.
app.use(express.static(STATIC_DIR, { extensions: [], index: false }));

// ---------------------------------------------------------------------------
// WebSocket transport at /ws.
//   client -> server: {type:'hello'} | {type:'set',key,value} | {type:'del',key}
//   server -> client: {type:'snapshot',state:{key:value}} | {type:'update',key,value}
// `value` is always the opaque localStorage string (or null on delete).
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(data);
    }
  }
}

wss.on('connection', async (ws) => {
  ws.on('message', async (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    try {
      if (msg.type === 'hello') {
        ws.send(JSON.stringify({ type: 'snapshot', state: await readSnapshot() }));
      } else if (msg.type === 'set' && isManagedKey(msg.key) && typeof msg.value === 'string') {
        await setKey(msg.key, msg.value);
      } else if (msg.type === 'del' && isManagedKey(msg.key)) {
        await delKey(msg.key);
      }
    } catch (e) {
      console.error('[ws] handling', msg && msg.type, '->', e.message);
    }
  });
});

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
(async () => {
  try {
    await connectRedis();
    await ensureCodes();
  } catch (e) {
    console.error('[boot] startup failed:', e.message);
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    console.log(`[boot] Midnight Express server on http://${HOST}:${PORT}`);
    console.log(`[boot] serving static from ${STATIC_DIR}`);
  });
})();

function shutdown(sig) {
  console.log(`[shutdown] ${sig}`);
  server.close();
  Promise.allSettled([redis.quit(), sub.quit()]).finally(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

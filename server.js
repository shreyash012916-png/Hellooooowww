'use strict';
/*
 * ROOM/05 — peer-to-peer video rooms.
 * This server only (1) serves the static site and (2) relays tiny WebRTC
 * "signaling" messages between people in the same room. Audio and video never
 * pass through it: browsers connect directly to each other (WebRTC).
 * No database, no accounts, no API keys.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const MAX_PEOPLE = Math.max(2, Number(process.env.MAX_PEOPLE || 5));
const ROOT = __dirname;
const PUBLIC_FILES = ['index.html', 'style.css', 'main.js', 'favicon.svg'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

// Free public STUN servers. Optional TURN relay (only needed for strict networks):
// set TURN_URL (e.g. turn:host:3478), TURN_USER and TURN_PASS in Render environment.
function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  if (process.env.TURN_URL) {
    list.push({ urls: process.env.TURN_URL.split(',').map((s) => s.trim()), username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
  }
  return list;
}

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': data.length,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'no-cache',
    'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)',
    ...extra
  });
  res.end(data);
}

// Load, hash and pre-compress the site once at startup so every request is instant.
const ASSETS = new Map();
for (const file of PUBLIC_FILES) {
  try {
    const raw = fs.readFileSync(path.join(ROOT, file));
    ASSETS.set(file, { raw, gz: zlib.gzipSync(raw, { level: 9 }), type: MIME[path.extname(file)], etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) + '"' });
  } catch (e) { console.error('Missing file', file); }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(res, 400, 'Bad request'); }

  if (pathname === '/health') return send(res, 200, JSON.stringify({ ok: true, app: 'ROOM/05', mode: 'p2p-webrtc', rooms: rooms.size }), 'application/json; charset=utf-8');
  if (pathname === '/config') return send(res, 200, JSON.stringify({ iceServers: iceServers(), maxPeople: MAX_PEOPLE }), 'application/json; charset=utf-8');

  const name = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const asset = ASSETS.get(name);
  if (!asset) return send(res, 404, 'Not found');
  if (req.headers['if-none-match'] === asset.etag) return send(res, 304, '', asset.type, { ETag: asset.etag });
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = gz ? asset.gz : asset.raw;
  const extra = { ETag: asset.etag, Vary: 'Accept-Encoding', 'Cache-Control': 'public, max-age=0, must-revalidate' };
  if (gz) extra['Content-Encoding'] = 'gzip';
  send(res, 200, req.method === 'HEAD' ? '' : body, asset.type, extra);
});

// ---------- signaling ----------
const rooms = new Map(); // code -> Map(id -> {ws, name})
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return socket.destroy(); }
  if (url.pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

const out = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);

wss.on('connection', (ws) => {
  let room = null;
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    // light rate limit: 400 messages / 10s per connection (ICE bursts are well under this)
    const now = Date.now();
    if (now - (ws.winStart || 0) > 10000) { ws.winStart = now; ws.winCount = 0; }
    if (++ws.winCount > 400) return;
    if (m.type === 'ping') return out(ws, { type: 'pong' });

    if (m.type === 'join' && !room) {
      const code = clean(m.room, 8).toUpperCase();
      if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) return out(ws, { type: 'error', reason: 'bad-room' });
      let members = rooms.get(code);
      if (!members) { members = new Map(); rooms.set(code, members); }
      if (members.size >= MAX_PEOPLE) return out(ws, { type: 'full', max: MAX_PEOPLE });
      me = crypto.randomBytes(6).toString('hex');
      room = code;
      const name = clean(m.name, 28) || 'Guest';
      const peers = Array.from(members, ([id, p]) => ({ id, name: p.name, state: p.state }));
      members.set(me, { ws, name, state: {} });
      out(ws, { type: 'joined', id: me, peers });
      members.forEach((p, id) => { if (id !== me) out(p.ws, { type: 'peer-joined', id: me, name }); });
      return;
    }
    if (!room || !me) return;
    const members = rooms.get(room);
    if (!members) return;
    const self = members.get(me);

    if (m.type === 'signal' && typeof m.to === 'string') {
      const target = members.get(m.to);
      if (target) out(target.ws, { type: 'signal', from: me, data: m.data });
    } else if (m.type === 'state' && m.state && typeof m.state === 'object') {
      self.state = { mic: !!m.state.mic, cam: !!m.state.cam, screen: !!m.state.screen, hand: !!m.state.hand };
      members.forEach((p, id) => { if (id !== me) out(p.ws, { type: 'state', id: me, state: self.state }); });
    } else if (m.type === 'chat') {
      const text = clean(m.text, 400);
      if (text) members.forEach((p, id) => { if (id !== me) out(p.ws, { type: 'chat', from: me, name: self.name, text }); });
    } else if (m.type === 'reaction') {
      const emoji = clean(m.emoji, 8);
      if (emoji) members.forEach((p, id) => { if (id !== me) out(p.ws, { type: 'reaction', from: me, name: self.name, emoji }); });
    }
  });

  ws.on('close', () => {
    if (!room || !me) return;
    const members = rooms.get(room);
    if (!members) return;
    members.delete(me);
    members.forEach((p) => out(p.ws, { type: 'peer-left', id: me }));
    if (members.size === 0) rooms.delete(room);
  });
  ws.on('error', () => {});
});

// Keep connections alive (and drop dead ones). Also stops idle proxies closing sockets.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, 25000);

server.keepAliveTimeout = 65000;
const shutdown = () => { wss.clients.forEach((c) => { try { c.close(1001); } catch (_) {} }); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (e) => console.error('uncaught', e));
process.on('unhandledRejection', (e) => console.error('unhandled', e));

server.listen(PORT, '0.0.0.0', () => console.log(`ROOM/05 (P2P) listening on port ${PORT}, max ${MAX_PEOPLE} per room`));

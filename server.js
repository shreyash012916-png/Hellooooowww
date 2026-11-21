'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const MAX_PARTICIPANTS = 5;
const ROOM_PREFIX = 'ROOM05-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function send(res, status, body, headers = {}) {
  const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'Content-Length': data.length,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function b64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(apiKey, apiSecret, claims) {
  const head = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url(claims);
  const input = `${head}.${payload}`;
  const signature = crypto.createHmac('sha256', apiSecret).update(input).digest('base64url');
  return `${input}.${signature}`;
}

function config() {
  const raw = String(process.env.LIVEKIT_URL || '').trim();
  const apiKey = String(process.env.LIVEKIT_API_KEY || '').trim();
  const apiSecret = String(process.env.LIVEKIT_API_SECRET || '').trim();
  if (!raw || !apiKey || !apiSecret) throw new Error('Server is not configured. Add LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in Render Environment.');
  const parsed = new URL(raw);
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(parsed.protocol)) throw new Error('LIVEKIT_URL must use https:// or wss://.');
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  parsed.protocol = secure ? 'https:' : 'http:';
  parsed.pathname = parsed.pathname.replace(/\/$/, '');
  parsed.search = '';
  parsed.hash = '';
  const apiUrl = parsed.toString().replace(/\/$/, '');
  const client = new URL(apiUrl);
  client.protocol = secure ? 'wss:' : 'ws:';
  return { apiUrl, clientUrl: client.toString().replace(/\/$/, ''), apiKey, apiSecret };
}

function serviceToken(c, video) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(c.apiKey, c.apiSecret, {
    iss: c.apiKey, sub: 'room05-service', nbf: now - 5, iat: now, exp: now + 60, video,
  });
}

function livekitCall(c, method, body, grant) {
  const url = new URL(`/twirp/livekit.RoomService/${method}`, c.apiUrl);
  const payload = Buffer.from(JSON.stringify(body));
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceToken(c, grant)}`,
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      },
      timeout: 12000,
    }, (resp) => {
      let raw = '';
      resp.setEncoding('utf8');
      resp.on('data', chunk => { raw += chunk; });
      resp.on('end', () => {
        let result = {};
        try { result = raw ? JSON.parse(raw) : {}; } catch {}
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          const err = new Error(result.msg || result.message || `LiveKit request failed (${resp.statusCode}).`);
          err.code = result.code || '';
          err.status = resp.statusCode;
          reject(err);
        } else resolve(result);
      });
    });
    req.on('timeout', () => req.destroy(new Error('LiveKit request timed out.')));
    req.on('error', reject);
    req.end(payload);
  });
}

function participantToken(c, roomName, displayName, role) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(c.apiKey, c.apiSecret, {
    iss: c.apiKey,
    sub: `guest-${crypto.randomUUID()}`,
    name: displayName,
    nbf: now - 5,
    iat: now,
    exp: now + 7200,
    metadata: JSON.stringify({ role }),
    video: { roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true },
  });
}

function randomCode() {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, b => ALPHABET[b & 31]).join('');
}

async function roomApi(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST for room actions.' }, { 'Content-Type': 'application/json' });
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Cross-origin requests are not allowed.' }, { 'Content-Type': 'application/json' }); }
    catch { return send(res, 403, { error: 'Invalid request origin.' }, { 'Content-Type': 'application/json' }); }
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) return send(res, 413, { error: 'Request is too large.' }, { 'Content-Type': 'application/json' });
  }
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'Request body must be valid JSON.' }, { 'Content-Type': 'application/json' }); }
  const action = body.action;
  const displayName = String(body.displayName || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 28);
  if (!displayName) return send(res, 400, { error: 'Add a display name before joining.' }, { 'Content-Type': 'application/json' });
  if (!['create', 'join'].includes(action)) return send(res, 400, { error: 'Unknown room action.' }, { 'Content-Type': 'application/json' });

  let c;
  try { c = config(); } catch (e) { return send(res, 503, { error: e.message }, { 'Content-Type': 'application/json' }); }
  try {
    let code;
    let roomName;
    let role;
    if (action === 'create') {
      let created = false;
      for (let i = 0; i < 3 && !created; i++) {
        code = randomCode();
        roomName = ROOM_PREFIX + code;
        try {
          await livekitCall(c, 'CreateRoom', {
            name: roomName, emptyTimeout: 300, departureTimeout: 30,
            maxParticipants: MAX_PARTICIPANTS,
            metadata: JSON.stringify({ app: 'ROOM/05', capacity: MAX_PARTICIPANTS }),
          }, { roomCreate: true });
          created = true;
        } catch (e) {
          if (!(['already_exists', 'AlreadyExists'].includes(e.code)) || i === 2) throw e;
        }
      }
      if (!created) throw new Error('Could not create a room. Try again.');
      role = 'host';
    } else {
      code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (code.length !== 8 || [...code].some(ch => !ALPHABET.includes(ch))) return send(res, 400, { error: 'Enter a valid 8-character room code.' }, { 'Content-Type': 'application/json' });
      roomName = ROOM_PREFIX + code;
      const listed = await livekitCall(c, 'ListRooms', { names: [roomName] }, { roomList: true });
      const rooms = Array.isArray(listed.rooms) ? listed.rooms : [];
      if (!rooms.length) return send(res, 404, { error: 'This room is not active. Ask the host to create a new room.' }, { 'Content-Type': 'application/json' });
      const count = Number(rooms[0].numParticipants ?? rooms[0].num_participants ?? 0);
      if (count >= MAX_PARTICIPANTS) return send(res, 409, { error: 'This room is full. It can hold five people at a time.' }, { 'Content-Type': 'application/json' });
      role = 'guest';
    }
    return send(res, 200, { code, token: participantToken(c, roomName, displayName, role), livekitUrl: c.clientUrl, role }, { 'Content-Type': 'application/json' });
  } catch (e) {
    console.error('ROOM/05 LiveKit error:', e.code || e.message);
    if (e.code === 'resource_exhausted' || e.code === 'ResourceExhausted' || /max.?participants|room.?full|participant.?limit/i.test(e.message || '')) return send(res, 409, { error: 'This room has reached its five-person limit.' }, { 'Content-Type': 'application/json' });
    if (/unauthenticated|permission.?denied|forbidden/i.test(`${e.code || ''} ${e.message || ''}`)) return send(res, 502, { error: 'LiveKit rejected the credentials. Check the API key, secret and project URL.' }, { 'Content-Type': 'application/json' });
    return send(res, 502, { error: 'The video room service is unavailable. Check LiveKit settings and try again.' }, { 'Content-Type': 'application/json' });
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/room') return roomApi(req, res);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request'); }
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(ROOT, `.${pathname}`);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600', 'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)', 'X-Frame-Options': 'DENY' });
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`ROOM/05 listening on ${PORT}`));

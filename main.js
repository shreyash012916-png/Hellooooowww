'use strict';

/* ROOM/05 — free peer-to-peer video rooms (WebRTC mesh).
   Media goes directly browser-to-browser. The server only relays signaling. */
(() => {
  const $ = (id) => document.getElementById(id);
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

  const landing = $('landing-screen');
  const callScreen = $('call-screen');
  const videoGrid = $('video-grid');
  const errorBox = $('landing-error');
  const createButton = $('create-room');
  const joinButton = $('join-room');

  let config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], maxPeople: 5 };
  let ws = null;
  let myId = '';
  let currentCode = '';
  let localName = '';
  let localStream = null;      // camera + mic
  let screenStream = null;
  let peers = new Map();       // id -> {id, name, pc, polite, makingOffer, ignoreOffer, stream, state, vsender, asender, tile}
  let state = { mic: true, cam: true, screen: false, hand: false };
  let inRoom = false;
  let entering = false;
  let leaving = false;
  let retryCount = 0;
  let toastTimer = null;
  let audioCtx = null;
  let wakeLock = null;
  let pinnedId = null;
  let hbTimer = null, lastPong = 0, statsTimer = null;

  // ---------- preferences ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('room05-' + k); return v === null ? d : v; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('room05-' + k, v); } catch (_) {} }
  };
  const prefs = { quality: store.get('quality', 'auto'), mirror: store.get('mirror', '1') === '1', sound: store.get('sound', '1') === '1' };

  const THEMES = [
    ['auto', 'Auto'], ['cream', 'Cream'], ['midnight', 'Midnight'], ['grape', 'Grape'],
    ['sunset', 'Sunset'], ['bubblegum', 'Bubblegum'], ['matcha', 'Matcha']
  ];
  const THEME_COLORS = { cream: ['#e9e6dc', '#d9ff00'], midnight: ['#0f110e', '#d9ff00'], grape: ['#130e1f', '#c59bff'], sunset: ['#1a0e12', '#ffb347'], bubblegum: ['#ffe0ed', '#ff8bd1'], matcha: ['#dce9d2', '#9dff6a'] };
  function applyTheme(choice) {
    let t = choice;
    if (t === 'auto') t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'midnight' : 'cream';
    document.documentElement.dataset.theme = t;
    const meta = $('meta-theme'); if (meta) meta.content = THEME_COLORS[t][0];
    store.set('theme', choice);
    document.querySelectorAll('.theme-chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.theme === choice)));
  }
  function buildThemePickers() {
    document.querySelectorAll('.theme-swatches').forEach((box) => {
      box.innerHTML = '';
      THEMES.forEach(([id, label]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'theme-chip' + (id === 'auto' ? ' auto' : ''); b.dataset.theme = id;
        b.title = label; b.setAttribute('aria-label', label + ' theme');
        if (THEME_COLORS[id]) { b.style.setProperty('--c1', THEME_COLORS[id][0]); b.style.setProperty('--c2', THEME_COLORS[id][1]); }
        b.addEventListener('click', () => { applyTheme(id); buzz(); });
        box.appendChild(b);
      });
    });
    applyTheme(store.get('theme', 'auto'));
    document.querySelectorAll('.theme-wrap').forEach((wrap) => {
      const btn = wrap.querySelector('.theme-toggle'); const pop = wrap.querySelector('.theme-pop');
      btn.addEventListener('click', (e) => { e.stopPropagation(); const open = pop.classList.toggle('hidden') === false; btn.setAttribute('aria-expanded', String(open)); });
    });
    document.addEventListener('click', (e) => { document.querySelectorAll('.theme-pop').forEach((p) => { if (!p.contains(e.target)) p.classList.add('hidden'); }); });
    if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (store.get('theme', 'auto') === 'auto') applyTheme('auto'); });
  }

  // tiny haptics + sound blips (no audio files needed)
  function buzz(ms) { if (prefs.sound && navigator.vibrate) { try { navigator.vibrate(ms || 8); } catch (_) {} } }
  function blip(kind) {
    if (!prefs.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const notes = kind === 'join' ? [660, 880] : kind === 'leave' ? [660, 440] : [880];
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t0 = audioCtx.currentTime + i * 0.11;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
        o.connect(g); g.connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.16);
      });
    } catch (_) {}
  }
  document.addEventListener('pointerdown', (e) => { if (e.target.closest && e.target.closest('button')) buzz(6); }, { passive: true });

  // ---------- quality presets ----------
  function qualityFor(peerCount) {
    const q = prefs.quality;
    if (q === 'max') return { w: 1920, h: 1080, fps: 30, bitrate: 4500000 };
    if (q === 'data') return { w: 640, h: 360, fps: 24, bitrate: 450000 };
    if (q === 'hd') return { w: 1280, h: 720, fps: 30, bitrate: 2200000 };
    // auto: the more people, the more everyone uploads, so share the upload budget
    if (peerCount <= 1) return { w: 1920, h: 1080, fps: 30, bitrate: 4000000 };
    if (peerCount === 2) return { w: 1280, h: 720, fps: 30, bitrate: 2200000 };
    if (peerCount === 3) return { w: 1280, h: 720, fps: 30, bitrate: 1600000 };
    return { w: 960, h: 540, fps: 30, bitrate: 1100000 };
  }
  function retuneAll() {
    const q = qualityFor(peers.size);
    peers.forEach((p) => { if (p.vsender) tuneVideoSender(p.vsender); });
    const t = cameraTrack();
    if (t && t.applyConstraints) t.applyConstraints({ width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps, max: q.fps } }).catch(() => {});
  }

  // ---------- helpers ----------
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('visible'), 3600);
  }
  const setError = (m) => { errorBox.textContent = m || ''; };
  const cleanName = (v) => String(v || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 28);
  const pad = (n) => String(n).padStart(2, '0');

  function makeCode() {
    if (!window.crypto || !crypto.getRandomValues) throw new Error('This browser cannot create a secure room code. Use an up-to-date browser over HTTPS.');
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  }

  function setBusy(busy) {
    entering = busy;
    createButton.disabled = busy;
    joinButton.disabled = busy;
    createButton.querySelector('span').textContent = busy ? 'CONNECTING…' : 'CREATE A ROOM';
    joinButton.querySelector('span').textContent = busy ? '…' : 'JOIN';
    $('display-name').disabled = busy;
    $('room-code').disabled = busy;
  }

  function setStatus(text, kind) {
    const el = $('connection-status');
    el.querySelector('span').textContent = text;
    el.classList.toggle('is-connected', kind === 'ok');
    el.classList.toggle('is-warning', kind === 'warn');
  }

  function setButton(id, active, onLabel, offLabel) {
    const b = $(id);
    b.setAttribute('aria-pressed', String(active));
    b.classList.toggle('is-active', active);
    const l = b.querySelector('.control-label');
    if (l && onLabel) l.textContent = active ? onLabel : offLabel;
  }

  // ---------- local media ----------
  async function getLocalMedia() {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 };
    const qq = qualityFor(1);
    const video = { width: { ideal: qq.w }, height: { ideal: qq.h }, frameRate: { ideal: qq.fps, max: qq.fps }, facingMode: 'user' };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera and microphone need HTTPS and an up-to-date browser.');
    }
    try { return await navigator.mediaDevices.getUserMedia({ audio, video }); } catch (e1) {
      try { toast('Camera unavailable — joining with microphone only.'); return await navigator.mediaDevices.getUserMedia({ audio }); } catch (e2) {
        try { toast('Microphone unavailable — joining with camera only.'); return await navigator.mediaDevices.getUserMedia({ video }); } catch (e3) {
          toast('No camera or microphone access — joining as a viewer.');
          return new MediaStream();
        }
      }
    }
  }

  const audioTrack = () => (localStream && localStream.getAudioTracks()[0]) || null;
  const cameraTrack = () => (localStream && localStream.getVideoTracks()[0]) || null;
  const outgoingVideoTrack = () => (screenStream && screenStream.getVideoTracks()[0]) || cameraTrack();

  function applyInitialPrefs() {
    const a = audioTrack(); const v = cameraTrack();
    if (v) { try { v.contentHint = 'motion'; } catch (_) {} }
    state.mic = !!a && $('start-mic').checked;
    state.cam = !!v && $('start-camera').checked;
    if (a) a.enabled = state.mic;
    if (v) v.enabled = state.cam;
    state.screen = false; state.hand = false;
    syncButtons();
  }

  function syncButtons() {
    setButton('toggle-mic', !state.mic, 'UNMUTE', 'MUTE');
    setButton('toggle-camera', !state.cam, 'CAMERA ON', 'CAMERA');
    setButton('toggle-screen', state.screen, 'STOP SHARE', 'SHARE');
    setButton('toggle-hand', state.hand, 'LOWER HAND', 'RAISE HAND');
  }

  function broadcastState() {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state }));
    renderLocalTile();
    renderPeople();
  }

  // ---------- speaking indicator ----------
  function watchSpeaking(stream, tile) {
    try {
      if (!stream.getAudioTracks().length) return;
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const an = audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      const timer = setInterval(() => {
        if (!tile.isConnected) { clearInterval(timer); try { src.disconnect(); } catch (_) {} return; }
        an.getByteFrequencyData(data);
        let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
        const speaking = sum / data.length > 18;
        tile.classList.toggle('is-speaking', speaking);
        const ring = tile.querySelector('.speaking-ring');
        if (ring) ring.classList.toggle('speaking', speaking);
      }, 200);
    } catch (_) { /* optional feature */ }
  }

  // ---------- tiles ----------
  function buildTile(id, name, isLocal) {
    const tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.dataset.id = id;
    const stage = document.createElement('div');
    stage.className = 'video-stage';
    const ph = document.createElement('div');
    ph.className = 'video-placeholder';
    const av = document.createElement('div');
    av.className = 'avatar-initials';
    av.textContent = (name || '?').slice(0, 1).toUpperCase();
    const cap = document.createElement('span');
    cap.className = 'placeholder-caption';
    cap.textContent = 'CAMERA OFF';
    ph.append(av, cap);
    const layer = document.createElement('div');
    layer.className = 'media-layer';
    const video = document.createElement('video');
    video.className = 'track-video' + (isLocal ? ' self-video' : '');
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.muted = isLocal;
    layer.appendChild(video);
    const ring = document.createElement('div');
    ring.className = 'speaking-ring';
    const flags = document.createElement('div');
    flags.className = 'tile-top-flags';
    const role = document.createElement('span');
    role.className = 'tile-role';
    role.textContent = isLocal ? 'YOU' : 'LIVE';
    const hand = document.createElement('span');
    hand.className = 'hand-flag hidden';
    hand.textContent = '✋ HAND UP';
    flags.append(role, hand);
    const actions = document.createElement('div');
    actions.className = 'tile-actions';
    const pin = document.createElement('button'); pin.type = 'button'; pin.textContent = '📌'; pin.title = 'Pin / spotlight'; pin.setAttribute('aria-label', 'Pin tile');
    pin.addEventListener('click', (e) => { e.stopPropagation(); togglePin(id); });
    const fs = document.createElement('button'); fs.type = 'button'; fs.textContent = '⛶'; fs.title = 'Fullscreen'; fs.setAttribute('aria-label', 'Fullscreen tile');
    fs.addEventListener('click', (e) => { e.stopPropagation(); tileFullscreen(tile); });
    actions.append(pin, fs);
    stage.append(ph, layer, ring, flags, actions);
    tile.addEventListener('dblclick', () => tileFullscreen(tile));
    const footer = document.createElement('div');
    footer.className = 'tile-footer';
    const person = document.createElement('div');
    person.className = 'tile-person';
    const nm = document.createElement('span');
    nm.className = 'tile-name';
    nm.textContent = name;
    person.appendChild(nm);
    if (isLocal) { const you = document.createElement('span'); you.className = 'tile-you'; you.textContent = '(YOU)'; person.appendChild(you); }
    const status = document.createElement('span');
    status.className = 'tile-status';
    footer.append(person, status);
    tile.append(stage, footer);
    return tile;
  }

  function paintTile(tile, st, stream, extra) {
    const hasVideo = !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live') && (st.cam || st.screen);
    tile.classList.toggle('no-video', !hasVideo);
    tile.querySelector('.hand-flag').classList.toggle('hidden', !st.hand);
    const v = tile.querySelector('video');
    v.classList.toggle('screen-track', !!st.screen);
    if (stream && v.srcObject !== stream) v.srcObject = stream;
    const parts = [];
    if (st.screen) parts.push('SHARING');
    parts.push(st.mic ? 'MIC ON' : 'MUTED');
    if (extra) parts.unshift(extra);
    const s = tile.querySelector('.tile-status');
    s.textContent = parts.join(' · ');
    s.classList.toggle('tile-mic', true);
    s.classList.toggle('muted', !st.mic);
  }

  function togglePin(id) {
    pinnedId = pinnedId === id ? null : id;
    layoutGrid();
    toast(pinnedId ? 'Spotlight on.' : 'Spotlight off.');
  }
  function tileFullscreen(tile) {
    try {
      if (document.fullscreenElement) { document.exitFullscreen(); return; }
      const fn = tile.requestFullscreen || tile.webkitRequestFullscreen;
      if (fn) fn.call(tile); else { const v = tile.querySelector('video'); if (v && v.webkitEnterFullscreen) v.webkitEnterFullscreen(); }
    } catch (_) {}
  }

  let localTile = null;
  function renderLocalTile() {
    if (!localTile) return;
    const display = new MediaStream();
    const vt = outgoingVideoTrack();
    if (vt) display.addTrack(vt);
    const v = localTile.querySelector('video');
    if (!v.srcObject || v.dataset.vt !== (vt ? vt.id : '')) { v.srcObject = display; v.dataset.vt = vt ? vt.id : ''; }
    v.classList.toggle('self-video', !state.screen && prefs.mirror);
    const hasVideo = !!vt && vt.readyState === 'live' && (state.cam || state.screen);
    localTile.classList.toggle('no-video', !hasVideo);
    localTile.querySelector('.hand-flag').classList.toggle('hidden', !state.hand);
    v.classList.toggle('screen-track', state.screen);
    const s = localTile.querySelector('.tile-status');
    s.textContent = (state.screen ? 'SHARING · ' : '') + (state.mic ? 'MIC ON' : 'MUTED');
    s.classList.toggle('muted', !state.mic);
  }

  function renderPeerTile(p) {
    if (!p.tile) return;
    paintTile(p.tile, p.state, p.stream, p.connState && p.connState !== 'connected' ? p.connState.toUpperCase() : '');
  }

  function layoutGrid() {
    const count = peers.size + 1;
    videoGrid.dataset.count = String(Math.min(count, 5));
    videoGrid.style.setProperty('--n', count);
    $('participant-count').textContent = pad(count);
    $('people-badge').textContent = String(count);
    $('panel-count').textContent = pad(count);
    videoGrid.classList.toggle('has-pin', !!pinnedId && count > 1);
    videoGrid.querySelectorAll('.video-tile').forEach((t) => t.classList.toggle('pinned', !!pinnedId && count > 1 && t.dataset.id === pinnedId));
    const note = videoGrid.querySelector('.loading-note');
    if (note) note.remove();
  }

  function renderPeople() {
    const list = $('participants-list');
    list.innerHTML = '';
    const all = [{ name: localName, st: state, local: true }, ...Array.from(peers.values(), (p) => ({ name: p.name, st: p.state, local: false }))];
    all.forEach((person) => {
      const row = document.createElement('div');
      row.className = 'participant-row';
      const avatar = document.createElement('span');
      avatar.className = 'participant-avatar';
      avatar.textContent = (person.name || '?').slice(0, 1).toUpperCase();
      const d = document.createElement('div');
      d.className = 'participant-details';
      const label = document.createElement('strong');
      label.textContent = person.name + (person.local ? ' (YOU)' : '');
      const sm = document.createElement('small');
      sm.textContent = [person.st.mic ? 'Mic on' : 'Muted', person.st.cam ? 'Camera on' : 'Camera off', person.st.hand ? '✋' : '', person.st.screen ? 'Sharing' : ''].filter(Boolean).join(' · ');
      d.append(label, sm);
      row.append(avatar, d);
      list.appendChild(row);
    });
  }

  // ---------- peer connections (perfect negotiation) ----------
  function createPeer(id, name) {
    if (peers.has(id)) return peers.get(id);
    const pc = new RTCPeerConnection({ iceServers: config.iceServers, bundlePolicy: 'max-bundle' });
    const p = { id, name, pc, polite: myId > id, makingOffer: false, ignoreOffer: false, stream: new MediaStream(), state: { mic: true, cam: true, screen: false, hand: false }, vsender: null, asender: null, tile: null, connState: 'connecting', pending: [] };
    peers.set(id, p);

    const at = audioTrack();
    if (at) { p.asender = pc.addTrack(at, localStream); tuneAudioSender(p.asender); }
    const vt = outgoingVideoTrack();
    if (vt) { p.vsender = pc.addTrack(vt, localStream); tuneVideoSender(p.vsender); }

    pc.ontrack = ({ track }) => {
      p.stream.addTrack(track);
      track.onended = () => { try { p.stream.removeTrack(track); } catch (_) {} renderPeerTile(p); };
      if (!p.tile) {
        p.tile = buildTile(id, p.name, false);
        videoGrid.appendChild(p.tile);
        watchSpeaking(p.stream, p.tile);
        layoutGrid();
        renderPeople();
      }
      renderPeerTile(p);
      const sink = $('audio-output-select').value;
      const v = p.tile.querySelector('video');
      if (sink && v.setSinkId) v.setSinkId(sink).catch(() => {});
      const playing = v.play(); if (playing && playing.catch) playing.catch(() => {});
    };

    pc.onicecandidate = ({ candidate }) => { if (candidate) sendSignal(id, { candidate }); };

    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        sendSignal(id, { description: pc.localDescription });
      } catch (e) { console.warn('negotiation failed', e); } finally { p.makingOffer = false; }
    };

    pc.onconnectionstatechange = () => {
      p.connState = pc.connectionState;
      renderPeerTile(p);
      if (pc.connectionState === 'disconnected') { setTimeout(() => { if (peers.get(id) === p && pc.connectionState === 'disconnected') { try { pc.restartIce(); } catch (_) {} } }, 4000); }
      if (pc.connectionState === 'failed') {
        try { pc.restartIce(); } catch (_) {}
        toast(p.name + ': connection is struggling — retrying. Strict networks may need a TURN relay.');
      }
    };

    // Make sure a tile exists even before media arrives (e.g. viewer with no tracks)
    if (!p.tile) {
      p.tile = buildTile(id, name, false);
      videoGrid.appendChild(p.tile);
      renderPeerTile(p);
      layoutGrid();
    }
    renderPeople();
    retuneAll();
    return p;
  }

  function tuneVideoSender(sender) {
    try {
      const q = qualityFor(peers.size);
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = state.screen ? Math.max(q.bitrate, 3000000) : q.bitrate;
      params.encodings[0].maxFramerate = q.fps;
      params.encodings[0].networkPriority = 'high';
      params.degradationPreference = state.screen ? 'maintain-resolution' : 'balanced';
      sender.setParameters(params).catch(() => {});
    } catch (_) {}
  }
  function tuneAudioSender(sender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 64000;
      params.encodings[0].priority = 'high';
      sender.setParameters(params).catch(() => {});
    } catch (_) {}
  }

  function sendSignal(to, data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'signal', to, data }));
  }

  async function handleSignal(from, data) {
    const p = peers.get(from);
    if (!p || !data) return;
    const pc = p.pc;
    try {
      if (data.description) {
        const d = data.description;
        const collision = d.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          await pc.setLocalDescription();
          sendSignal(from, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignoreOffer) console.warn('ICE candidate error', e); }
      }
    } catch (e) { console.warn('signal handling failed', e); }
  }

  function removePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch (_) {}
    if (p.tile) p.tile.remove();
    peers.delete(id);
    if (pinnedId === id) pinnedId = null;
    layoutGrid();
    renderPeople();
    retuneAll();
    blip('leave');
    toast(p.name + ' left the room.');
  }

  function closeAllPeers() {
    peers.forEach((p) => { try { p.pc.close(); } catch (_) {} if (p.tile) p.tile.remove(); });
    peers.clear();
  }

  // ---------- signaling socket ----------
  function openSocket() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sock = new WebSocket(`${proto}//${location.host}/ws`);
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; try { sock.close(); } catch (_) {} reject(new Error('The room server did not respond. If this site was idle, it may be waking up — wait 30 seconds and try again.')); } }, 45000);
      sock.onopen = () => { sock.send(JSON.stringify({ type: 'join', room: currentCode, name: localName })); };
      sock.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (!settled && m.type === 'joined') { settled = true; clearTimeout(timer); resolve({ sock, joined: m }); return; }
        if (!settled && m.type === 'full') { settled = true; clearTimeout(timer); try { sock.close(); } catch (_) {} reject(new Error('This room is full (' + m.max + ' people max).')); return; }
        if (!settled && m.type === 'error') { settled = true; clearTimeout(timer); reject(new Error('Invalid room code.')); return; }
        if (settled) onServerMessage(m);
      };
      sock.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Could not reach the room server.')); } };
      sock.onclose = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Could not reach the room server.')); } else onSocketClosed(sock); };
    });
  }

  function onServerMessage(m) {
    switch (m.type) {
      case 'peer-joined': {
        const p = createPeer(m.id, m.name);
        p.state = { mic: true, cam: true, screen: false, hand: false };
        blip('join');
        toast(m.name + ' joined.');
        sendMyStateTo();
        break;
      }
      case 'peer-left': removePeer(m.id); break;
      case 'pong': lastPong = Date.now(); break;
      case 'signal': handleSignal(m.from, m.data); break;
      case 'state': {
        const p = peers.get(m.id);
        if (p) { p.state = m.state; renderPeerTile(p); renderPeople(); }
        break;
      }
      case 'chat': appendChat(m.name, m.text); notifyChat(); blip('ping'); break;
      case 'reaction': floatReaction(m.emoji, m.name); break;
      default: break;
    }
  }

  function sendMyStateTo() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state })); }

  function onSocketClosed(sock) {
    if (sock !== ws || leaving || !inRoom) return;
    setStatus('RECONNECTING', 'warn');
    closeAllPeers();
    layoutGrid();
    attemptReconnect();
  }

  async function attemptReconnect() {
    if (leaving || !inRoom) return;
    retryCount += 1;
    if (retryCount > 8) { toast('Connection lost. Leaving the room — please rejoin.'); leaveRoom(); return; }
    await new Promise((r) => setTimeout(r, Math.min(1000 * retryCount, 6000)));
    if (leaving || !inRoom) return;
    try {
      const { sock, joined } = await openSocket();
      ws = sock; myId = joined.id; retryCount = 0;
      setStatus('CONNECTED', 'ok');
      joined.peers.forEach((pr) => { createPeer(pr.id, pr.name).state = pr.state && Object.keys(pr.state).length ? pr.state : { mic: true, cam: true, screen: false, hand: false }; });
      sendMyStateTo();
      toast('Reconnected.');
    } catch (_) { attemptReconnect(); }
  }

  // ---------- robustness: heartbeat, wake lock, stats ----------
  function startHeartbeat() {
    stopHeartbeat(); lastPong = Date.now();
    hbTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1) return;
      if (Date.now() - lastPong > 50000) { try { ws.close(); } catch (_) {} return; }
      ws.send(JSON.stringify({ type: 'ping' }));
    }, 15000);
  }
  function stopHeartbeat() { clearInterval(hbTimer); hbTimer = null; }
  async function acquireWakeLock() { try { if (navigator.wakeLock && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (_) {} }
  function releaseWakeLock() { try { if (wakeLock) wakeLock.release(); } catch (_) {} wakeLock = null; }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && inRoom) { acquireWakeLock(); if (ws && ws.readyState !== 1) { try { ws.close(); } catch (_) {} } } });
  window.addEventListener('online', () => { if (inRoom) { toast('Back online — reconnecting…'); if (ws && ws.readyState !== 1) { try { ws.close(); } catch (_) {} } } });
  window.addEventListener('offline', () => { if (inRoom) { setStatus('OFFLINE', 'warn'); toast('You are offline.'); } });

  function startStats() {
    stopStats();
    statsTimer = setInterval(async () => {
      let worstRtt = 0, any = false, lossHigh = false;
      for (const p of peers.values()) {
        try {
          const stats = await p.pc.getStats();
          stats.forEach((r) => {
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && typeof r.currentRoundTripTime === 'number') { any = true; worstRtt = Math.max(worstRtt, r.currentRoundTripTime * 1000); }
            if (r.type === 'inbound-rtp' && r.kind === 'video' && r.packetsReceived > 100 && r.packetsLost / (r.packetsReceived + r.packetsLost) > 0.08) lossHigh = true;
          });
        } catch (_) {}
      }
      if (!inRoom || ws == null || ws.readyState !== 1) return;
      if (!peers.size) { setStatus('CONNECTED', 'ok'); return; }
      if (!any) { setStatus('LINKING', ''); return; }
      const ms = Math.round(worstRtt);
      setStatus((lossHigh ? 'WEAK ' : ms < 120 ? 'GREAT ' : 'OK ') + ms + 'ms', lossHigh || ms > 300 ? 'warn' : 'ok');
    }, 3000);
  }
  function stopStats() { clearInterval(statsTimer); statsTimer = null; }

  // ---------- enter / leave ----------
  function showCall(code) {
    landing.classList.add('hidden');
    callScreen.classList.remove('hidden');
    $('active-room-code').textContent = code;
    $('footer-room-code').textContent = code;
    videoGrid.innerHTML = '';
    videoGrid.dataset.count = '1';
    setStatus('CONNECTING', '');
  }

  async function enterRoom(code) {
    if (entering || inRoom) return;
    setError('');
    const name = cleanName($('display-name').value);
    if (!name) { setError('Add your name first.'); $('display-name').focus(); return; }
    code = String(code || '').toUpperCase();
    if (!CODE_RE.test(code)) { setError('Enter a valid 8-character room code (no I, O, 0 or 1).'); $('room-code').focus(); return; }

    localName = name; currentCode = code; leaving = false; retryCount = 0;
    setBusy(true);
    try {
      try {
        const r = await fetch('/config', { cache: 'no-store' });
        if (r.ok) config = await r.json();
      } catch (_) { /* fall back to defaults */ }

      localStream = await getLocalMedia();
      applyInitialPrefs();

      showCall(code);
      localTile = buildTile('local', localName, true);
      videoGrid.appendChild(localTile);
      watchSpeaking(localStream, localTile);
      renderLocalTile();
      layoutGrid();

      const { sock, joined } = await openSocket();
      ws = sock; myId = joined.id; inRoom = true;
      setStatus('CONNECTED', 'ok');
      startHeartbeat(); startStats(); acquireWakeLock(); document.body.classList.add('in-call');
      joined.peers.forEach((pr) => {
        const p = createPeer(pr.id, pr.name);
        if (pr.state && Object.keys(pr.state).length) p.state = pr.state;
      });
      sendMyStateTo();
      renderPeople();
      layoutGrid();

      try {
        const u = new URL(location.href); u.searchParams.set('room', code);
        history.replaceState({}, '', u.pathname + u.search + u.hash);
      } catch (_) {}
      toast('You are in. Send your room code to your friends.');
      setBusy(false);
      refreshDevices();
    } catch (error) {
      console.error('ROOM/05 startup:', error);
      cleanupMedia();
      callScreen.classList.add('hidden');
      landing.classList.remove('hidden');
      videoGrid.innerHTML = '';
      inRoom = false;
      setBusy(false);
      setError(error && error.message ? error.message : 'Could not start the room. Please try again.');
    }
  }

  function cleanupMedia() {
    [localStream, screenStream].forEach((s) => { if (s) s.getTracks().forEach((t) => t.stop()); });
    localStream = null; screenStream = null; localTile = null;
  }

  function leaveRoom() {
    leaving = true; inRoom = false;
    stopHeartbeat(); stopStats(); releaseWakeLock(); document.body.classList.remove('in-call'); pinnedId = null;
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (_) {} }
    if (ws) { const s = ws; ws = null; try { s.close(); } catch (_) {} }
    closeAllPeers();
    cleanupMedia();
    state = { mic: true, cam: true, screen: false, hand: false };
    syncButtons();
    currentCode = ''; myId = '';
    callScreen.classList.add('hidden');
    landing.classList.remove('hidden');
    $('side-panel').classList.add('hidden');
    videoGrid.innerHTML = '';
    $('chat-messages').innerHTML = '<div class="chat-empty" id="chat-empty"><span>✳</span><strong>Quiet in here.</strong><p>Start the conversation. Messages disappear when the room closes.</p></div>';
    setBusy(false);
    try { const u = new URL(location.href); u.searchParams.delete('room'); history.replaceState({}, '', u.pathname + u.search + u.hash); } catch (_) {}
  }

  // ---------- controls ----------
  $('toggle-mic').addEventListener('click', () => {
    const t = audioTrack();
    if (!t) { toast('No microphone available.'); return; }
    state.mic = !state.mic; t.enabled = state.mic; syncButtons(); broadcastState();
  });
  $('toggle-camera').addEventListener('click', () => {
    const t = cameraTrack();
    if (!t) { toast('No camera available.'); return; }
    state.cam = !state.cam; t.enabled = state.cam; syncButtons(); broadcastState();
  });
  $('toggle-hand').addEventListener('click', () => { state.hand = !state.hand; syncButtons(); broadcastState(); });

  async function setOutgoingVideo(track) {
    for (const p of peers.values()) {
      try {
        if (p.vsender) { await p.vsender.replaceTrack(track); }
        else if (track) { p.vsender = p.pc.addTrack(track, localStream); tuneVideoSender(p.vsender); }
      } catch (e) { console.warn('replaceTrack failed', e); }
    }
  }

  async function stopScreenShare() {
    if (screenStream) { screenStream.getTracks().forEach((t) => t.stop()); screenStream = null; }
    state.screen = false;
    await setOutgoingVideo(cameraTrack());
    peers.forEach((p) => { if (p.vsender) tuneVideoSender(p.vsender); });
    syncButtons(); broadcastState();
  }

  $('toggle-screen').addEventListener('click', async () => {
    if (state.screen) { await stopScreenShare(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { toast('Screen sharing is not supported on this browser/device.'); return; }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
      const track = screenStream.getVideoTracks()[0];
      try { track.contentHint = 'detail'; } catch (_) {}
      track.onended = () => { if (state.screen) stopScreenShare(); };
      state.screen = true;
      await setOutgoingVideo(track);
      peers.forEach((p) => { if (p.vsender) tuneVideoSender(p.vsender); });
      syncButtons(); broadcastState();
    } catch (e) { screenStream = null; if (e && e.name !== 'NotAllowedError') toast('Could not start screen sharing.'); }
  });

  $('leave-room').addEventListener('click', leaveRoom);

  function openPanel(type) {
    $('side-panel').classList.remove('hidden');
    const people = type === 'people';
    $('people-view').classList.toggle('hidden', !people);
    $('chat-view').classList.toggle('hidden', people);
    $('panel-kicker').textContent = people ? 'THE ROOM' : 'LIVE CONVERSATION';
    $('panel-title').childNodes[0].textContent = people ? 'People ' : 'Chat ';
    if (!people) $('chat-input').focus();
  }
  $('open-people').addEventListener('click', () => openPanel('people'));
  $('open-chat').addEventListener('click', () => openPanel('chat'));
  $('close-panel').addEventListener('click', () => $('side-panel').classList.add('hidden'));

  // ---------- chat & reactions ----------
  function appendChat(name, message) {
    const list = $('chat-messages');
    const empty = $('chat-empty'); if (empty) empty.remove();
    const item = document.createElement('div');
    item.className = 'chat-message';
    const a = document.createElement('strong'); a.textContent = name;
    const b = document.createElement('p'); b.textContent = message;
    item.append(a, b); list.appendChild(item);
    list.scrollTop = list.scrollHeight;
  }
  function notifyChat() { if ($('side-panel').classList.contains('hidden') || $('chat-view').classList.contains('hidden')) toast('New chat message'); }

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'chat', text }));
    appendChat(localName + ' (YOU)', text);
    input.value = '';
  });

  function floatReaction(emoji, name) {
    const box = $('reaction-floats');
    const el = document.createElement('div');
    el.className = 'float-emoji';
    el.textContent = emoji;
    const sm = document.createElement('small'); sm.textContent = name || ''; el.appendChild(sm);
    box.appendChild(el);
    setTimeout(() => el.remove(), 2700);
    if (emoji === '🎉') confetti();
    else if (box.children.length > 12) box.firstChild.remove();
  }
  function confetti() {
    try {
      const c = document.createElement('canvas'); c.className = 'confetti';
      c.width = innerWidth; c.height = innerHeight; document.body.appendChild(c);
      const ctx = c.getContext('2d');
      const css = getComputedStyle(document.documentElement);
      const colors = [css.getPropertyValue('--acid').trim(), css.getPropertyValue('--red').trim(), css.getPropertyValue('--blue').trim(), '#ffffff', '#ffd23f'];
      const bits = Array.from({ length: 140 }, () => ({ x: innerWidth / 2, y: innerHeight * 0.75, vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 18 - 6, s: Math.random() * 7 + 4, r: Math.random() * 6.3, vr: (Math.random() - 0.5) * 0.4, c: colors[(Math.random() * colors.length) | 0] }));
      const t0 = performance.now();
      (function frame(now) {
        const age = now - t0; ctx.clearRect(0, 0, c.width, c.height);
        bits.forEach((b) => { b.vy += 0.5; b.x += b.vx; b.y += b.vy; b.r += b.vr; ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.globalAlpha = Math.max(0, 1 - age / 2600); ctx.fillRect(-b.s / 2, -b.s / 2, b.s, b.s * 0.6); ctx.restore(); });
        if (age < 2600) requestAnimationFrame(frame); else c.remove();
      })(t0);
    } catch (_) {}
  }

  document.querySelectorAll('[data-reaction]').forEach((b) => b.addEventListener('click', () => {
    if (!ws || ws.readyState !== 1) return;
    const emoji = b.dataset.reaction;
    ws.send(JSON.stringify({ type: 'reaction', emoji }));
    floatReaction(emoji, 'You');
  }));

  // ---------- invite / copy ----------
  $('copy-code').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(currentCode); toast('Room code copied.'); } catch (_) { toast('Your room code is ' + currentCode); }
  });
  $('share-invite').addEventListener('click', async () => {
    const url = new URL(location.href); url.search = ''; url.hash = ''; url.searchParams.set('room', currentCode);
    try {
      if (navigator.share) await navigator.share({ title: 'Join my ROOM/05', text: 'Join my video room with code ' + currentCode, url: url.toString() });
      else { await navigator.clipboard.writeText(url.toString()); toast('Invite link copied.'); }
    } catch (_) { toast('Room code: ' + currentCode); }
  });

  // ---------- device settings ----------
  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const fill = (id, kind, fallback) => {
        const sel = $(id); const cur = sel.value;
        sel.innerHTML = '';
        const def = document.createElement('option'); def.value = ''; def.textContent = 'System default'; sel.appendChild(def);
        devices.filter((d) => d.kind === kind).forEach((d, i) => {
          const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || (fallback + ' ' + (i + 1)); sel.appendChild(o);
        });
        sel.value = Array.from(sel.options).some((o) => o.value === cur) ? cur : '';
      };
      fill('audio-input-select', 'audioinput', 'Microphone');
      fill('video-input-select', 'videoinput', 'Camera');
      fill('audio-output-select', 'audiooutput', 'Speaker');
    } catch (_) {}
  }

  async function switchInput(kind, deviceId) {
    if (!localStream) return;
    try {
      const constraints = kind === 'audio'
        ? { audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
        : { video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: qualityFor(peers.size).w }, height: { ideal: qualityFor(peers.size).h }, frameRate: { ideal: 30, max: 30 } } };
      const fresh = await navigator.mediaDevices.getUserMedia(constraints);
      const track = fresh.getTracks()[0];
      const old = kind === 'audio' ? audioTrack() : cameraTrack();
      if (old) { localStream.removeTrack(old); old.stop(); }
      track.enabled = kind === 'audio' ? state.mic : state.cam;
      localStream.addTrack(track);
      for (const p of peers.values()) {
        if (kind === 'audio') { if (p.asender) await p.asender.replaceTrack(track); else p.asender = p.pc.addTrack(track, localStream); }
        else if (!state.screen) { if (p.vsender) await p.vsender.replaceTrack(track); else { p.vsender = p.pc.addTrack(track, localStream); tuneVideoSender(p.vsender); } }
      }
      renderLocalTile();
      refreshDevices();
    } catch (e) { toast('Could not switch that device.'); }
  }
  $('audio-input-select').addEventListener('change', (e) => switchInput('audio', e.target.value));
  $('video-input-select').addEventListener('change', (e) => switchInput('video', e.target.value));
  $('audio-output-select').addEventListener('change', (e) => {
    const id = e.target.value;
    peers.forEach((p) => { const v = p.tile && p.tile.querySelector('video'); if (v && v.setSinkId) v.setSinkId(id).catch(() => toast('This browser cannot change the speaker.')); });
  });
  $('open-settings').addEventListener('click', () => { refreshDevices(); $('settings-overlay').classList.remove('hidden'); });
  $('close-settings').addEventListener('click', () => $('settings-overlay').classList.add('hidden'));
  $('settings-done').addEventListener('click', () => $('settings-overlay').classList.add('hidden'));

  $('quality-select').value = prefs.quality;
  $('quality-select').addEventListener('change', (e) => { prefs.quality = e.target.value; store.set('quality', prefs.quality); retuneAll(); toast('Video quality: ' + e.target.options[e.target.selectedIndex].text); });
  $('opt-mirror').checked = prefs.mirror;
  $('opt-mirror').addEventListener('change', (e) => { prefs.mirror = e.target.checked; store.set('mirror', prefs.mirror ? '1' : '0'); renderLocalTile(); });
  $('opt-sound').checked = prefs.sound;
  $('opt-sound').addEventListener('change', (e) => { prefs.sound = e.target.checked; store.set('sound', prefs.sound ? '1' : '0'); });

  // snap a group photo (collage of everyone's current frame)
  $('snap-photo').addEventListener('click', () => {
    try {
      const vids = Array.from(videoGrid.querySelectorAll('.video-tile')).map((t) => ({ v: t.querySelector('video'), name: t.querySelector('.tile-name').textContent, off: t.classList.contains('no-video') }));
      if (!vids.length) return;
      const cols = vids.length === 1 ? 1 : vids.length <= 4 ? 2 : 3;
      const rows = Math.ceil(vids.length / cols);
      const cw = 640, ch = 360, pad = 12, head = 56;
      const c = document.createElement('canvas');
      c.width = cols * cw + (cols + 1) * pad; c.height = rows * ch + (rows + 1) * pad + head;
      const ctx = c.getContext('2d');
      const css = getComputedStyle(document.documentElement);
      ctx.fillStyle = css.getPropertyValue('--paper').trim() || '#e9e6dc'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = css.getPropertyValue('--ink').trim() || '#171916'; ctx.font = '700 26px sans-serif';
      ctx.fillText('ROOM/05  ·  ' + currentCode + '  ·  ' + new Date().toLocaleString(), pad, 38);
      vids.forEach((o, i) => {
        const x = pad + (i % cols) * (cw + pad), y = head + pad + Math.floor(i / cols) * (ch + pad);
        ctx.fillStyle = '#20231f'; ctx.fillRect(x, y, cw, ch);
        if (!o.off && o.v.videoWidth) {
          const r = Math.max(cw / o.v.videoWidth, ch / o.v.videoHeight), w = o.v.videoWidth * r, h = o.v.videoHeight * r;
          ctx.save(); ctx.beginPath(); ctx.rect(x, y, cw, ch); ctx.clip(); ctx.drawImage(o.v, x + (cw - w) / 2, y + (ch - h) / 2, w, h); ctx.restore();
        }
        ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x, y + ch - 36, cw, 36);
        ctx.fillStyle = '#fff'; ctx.font = '600 20px sans-serif'; ctx.fillText(o.name, x + 12, y + ch - 11);
      });
      const flash = document.createElement('div'); flash.className = 'snap-flash'; document.body.appendChild(flash); setTimeout(() => flash.remove(), 500);
      c.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'room05-' + Date.now() + '.png';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        toast('Group photo saved 📸');
      }, 'image/png');
    } catch (e) { toast('Could not take the photo.'); }
  });

  // keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (!inRoom || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    const map = { m: 'toggle-mic', v: 'toggle-camera', s: 'toggle-screen', h: 'toggle-hand', c: 'open-chat', p: 'open-people' };
    if (map[k]) { e.preventDefault(); $(map[k]).click(); }
    else if (k === 'f') { e.preventDefault(); tileFullscreen(videoGrid.querySelector('.video-tile.pinned') || localTile); }
    else if (k === 'escape') { $('settings-overlay').classList.add('hidden'); }
  });

  buildThemePickers();

  // ---------- landing wiring ----------
  createButton.addEventListener('click', () => {
    try { enterRoom(makeCode()); } catch (e) { setError(e.message || 'Could not create a room code.'); }
  });
  joinButton.addEventListener('click', () => enterRoom($('room-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  $('room-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); });
  $('room-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinButton.click(); });
  $('display-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('room-code').value ? joinButton : createButton).click(); });

  const initial = new URLSearchParams(location.search).get('room');
  if (initial && CODE_RE.test(initial.toUpperCase())) $('room-code').value = initial.toUpperCase();

  window.addEventListener('beforeunload', () => { if (ws) { try { ws.close(); } catch (_) {} } });

  // Wake a sleeping free Render instance as soon as the page opens.
  fetch('/health', { cache: 'no-store' }).catch(() => {});
})();

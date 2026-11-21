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
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' };
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
    stage.append(ph, layer, ring, flags);
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

  let localTile = null;
  function renderLocalTile() {
    if (!localTile) return;
    const display = new MediaStream();
    const vt = outgoingVideoTrack();
    if (vt) display.addTrack(vt);
    const v = localTile.querySelector('video');
    if (!v.srcObject || v.dataset.vt !== (vt ? vt.id : '')) { v.srcObject = display; v.dataset.vt = vt ? vt.id : ''; }
    v.classList.toggle('self-video', !state.screen);
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
    if (at) p.asender = pc.addTrack(at, localStream);
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
    return p;
  }

  function tuneVideoSender(sender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 2500000;
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
    layoutGrid();
    renderPeople();
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
        toast(m.name + ' joined.');
        sendMyStateTo();
        break;
      }
      case 'peer-left': removePeer(m.id); break;
      case 'signal': handleSignal(m.from, m.data); break;
      case 'state': {
        const p = peers.get(m.id);
        if (p) { p.state = m.state; renderPeerTile(p); renderPeople(); }
        break;
      }
      case 'chat': appendChat(m.name, m.text); notifyChat(); break;
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
    syncButtons(); broadcastState();
  }

  $('toggle-screen').addEventListener('click', async () => {
    if (state.screen) { await stopScreenShare(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { toast('Screen sharing is not supported on this browser/device.'); return; }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
      const track = screenStream.getVideoTracks()[0];
      track.onended = () => { if (state.screen) stopScreenShare(); };
      state.screen = true;
      await setOutgoingVideo(track);
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
        : { video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } };
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

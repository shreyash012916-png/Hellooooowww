import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  VideoPresets,
} from 'livekit-client';

const $ = (selector) => document.querySelector(selector);
const els = {
  landing: $('#landing-screen'),
  call: $('#call-screen'),
  name: $('#display-name'),
  code: $('#room-code'),
  startCamera: $('#start-camera'),
  startMic: $('#start-mic'),
  create: $('#create-room'),
  join: $('#join-room'),
  landingError: $('#landing-error'),
  activeCode: $('#active-room-code'),
  footerCode: $('#footer-room-code'),
  copyCode: $('#copy-code'),
  shareInvite: $('#share-invite'),
  connection: $('#connection-status'),
  participantCount: $('#participant-count'),
  peopleBadge: $('#people-badge'),
  grid: $('#video-grid'),
  sidePanel: $('#side-panel'),
  panelTitle: $('#panel-title'),
  panelCount: $('#panel-count'),
  panelKicker: $('#panel-kicker'),
  peopleView: $('#people-view'),
  chatView: $('#chat-view'),
  participants: $('#participants-list'),
  chatMessages: $('#chat-messages'),
  chatEmpty: $('#chat-empty'),
  chatForm: $('#chat-form'),
  chatInput: $('#chat-input'),
  toggleMic: $('#toggle-mic'),
  toggleCamera: $('#toggle-camera'),
  toggleScreen: $('#toggle-screen'),
  toggleHand: $('#toggle-hand'),
  settingsOverlay: $('#settings-overlay'),
  toast: $('#toast'),
};

let activeRoom = null;
let activeCode = '';
let isHost = false;
let sidePanelMode = '';
let raisedHand = false;
let screenSharing = false;
let toastTimer = null;
let localMessages = 0;
const tileByIdentity = new Map();
const mediaElements = new Map();
const raisedHands = new Set();
const activeSpeakers = new Set();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Pre-fill a room code from an invitation URL without storing it permanently.
const params = new URLSearchParams(window.location.search);
const inviteCode = normalizeCode(params.get('room') || '');
if (inviteCode) els.code.value = inviteCode;

const rememberedName = sessionStorage.getItem('room05-name');
if (rememberedName) els.name.value = rememberedName;

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function cleanName(value) {
  return String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 28);
}

function showError(message) {
  els.landingError.textContent = message;
}

function toast(message, duration = 2800) {
  els.toast.textContent = message;
  els.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('visible'), duration);
}

function setBusy(button, busy, busyLabel) {
  button.disabled = busy;
  const label = button.querySelector('span');
  if (!label) return;
  if (busy) {
    button.dataset.originalLabel = label.textContent;
    label.textContent = busyLabel;
    button.classList.add('is-loading');
  } else {
    label.textContent = button.dataset.originalLabel || label.textContent;
    button.classList.remove('is-loading');
  }
}

async function requestRoom(action, payload = {}) {
  const response = await fetch('/api/room', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ action, ...payload }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || 'The room service could not complete that request.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function toWebSocketUrl(url) {
  return String(url || '').replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:').replace(/\/$/, '');
}

async function enterRoom(action) {
  showError('');
  const displayName = cleanName(els.name.value);
  if (!displayName) {
    showError('Add a name so your friends know it is you.');
    els.name.focus();
    return;
  }
  const code = normalizeCode(els.code.value);
  if (action === 'join' && code.length !== 8) {
    showError('Room codes are 8 characters long. Check the invite and try again.');
    els.code.focus();
    return;
  }

  const button = action === 'create' ? els.create : els.join;
  setBusy(button, true, action === 'create' ? 'MAKING ROOM…' : 'JOINING…');
  try {
    sessionStorage.setItem('room05-name', displayName);
    const result = await requestRoom(action, {
      displayName,
      ...(action === 'join' ? { code } : {}),
    });
    activeCode = result.code;
    isHost = result.role === 'host';
    await connectToLiveKit(result);
  } catch (error) {
    const message = error.status === 404
      ? 'That room is not active. Ask the host for a fresh invite.'
      : error.status === 409
        ? 'This room has reached its five-person limit.'
        : error.status === 400
          ? error.message
          : error.message || 'Could not connect. Check your internet and try again.';
    showError(message);
    console.error('Room entry failed:', error);
  } finally {
    setBusy(button, false);
  }
}

async function connectToLiveKit(result) {
  if (!result.token || !result.livekitUrl || !result.code) {
    throw new Error('The room service returned an incomplete connection. Check the Cloudflare environment variables.');
  }

  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
    publishDefaults: { simulcast: true },
  });
  activeRoom = room;
  bindRoomEvents(room);
  els.activeCode.textContent = activeCode;
  els.footerCode.textContent = activeCode;
  els.landing.classList.add('hidden');
  els.call.classList.remove('hidden');
  closeSidePanel();
  renderParticipants();
  setConnectionState('CONNECTING');

  try {
    await room.connect(toWebSocketUrl(result.livekitUrl), result.token, { autoSubscribe: true });
  } catch (error) {
    activeRoom = null;
    try { await room.disconnect(); } catch { /* Connection may not have completed. */ }
    els.call.classList.add('hidden');
    els.landing.classList.remove('hidden');
    throw new Error(`Could not reach the video server. ${error?.message || 'Check the LiveKit URL and network.'}`);
  }

  const startMic = els.startMic.checked;
  const startCamera = els.startCamera.checked;
  const mediaErrors = [];
  if (startMic) {
    try { await room.localParticipant.setMicrophoneEnabled(true); }
    catch (error) { mediaErrors.push(mediaErrorMessage(error, 'microphone')); }
  }
  if (startCamera) {
    try { await room.localParticipant.setCameraEnabled(true); }
    catch (error) { mediaErrors.push(mediaErrorMessage(error, 'camera')); }
  }
  renderParticipants();
  updateControlButtons();
  if (mediaErrors.length) toast(mediaErrors.join(' '), 5200);
  else toast(actionLabel(isHost));
}

function actionLabel(host) {
  return host ? 'Room created. Send the invite to your friends.' : 'You are in. Say hello.';
}

function mediaErrorMessage(error, device) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
    return `Allow ${device} access in your browser to use it.`;
  }
  if (error?.name === 'NotFoundError') return `No ${device} was found on this device.`;
  return `${device[0].toUpperCase()}${device.slice(1)} could not start.`;
}

function bindRoomEvents(room) {
  room
    .on(RoomEvent.ConnectionStateChanged, (state) => setConnectionState(state.toUpperCase()))
    .on(RoomEvent.ParticipantConnected, () => renderParticipants())
    .on(RoomEvent.ParticipantDisconnected, (participant) => {
      raisedHands.delete(participant.identity);
      activeSpeakers.delete(participant.identity);
      renderParticipants();
    })
    .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      attachTrack(track, publication, participant, false);
      renderParticipants();
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => detachTrack(track))
    .on(RoomEvent.LocalTrackPublished, (publication) => {
      attachTrack(publication.track, publication, room.localParticipant, true);
      if (publication.source === Track.Source.ScreenShare) screenSharing = true;
      renderParticipants();
    })
    .on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication.track) detachTrack(publication.track);
      if (publication.source === Track.Source.ScreenShare) screenSharing = false;
      renderParticipants();
    })
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      activeSpeakers.clear();
      speakers.forEach((participant) => activeSpeakers.add(participant.identity));
      renderParticipants();
    })
    .on(RoomEvent.DataReceived, (payload, participant) => handleData(payload, participant))
    .on(RoomEvent.Disconnected, () => {
      if (activeRoom === room) returnToLanding('The room connection ended.');
    });
}

function setConnectionState(state) {
  const normalized = String(state || 'CONNECTING').toUpperCase();
  const label = normalized === 'CONNECTED' ? 'CONNECTED'
    : normalized === 'RECONNECTING' ? 'RECONNECTING'
      : normalized === 'DISCONNECTED' ? 'OFFLINE' : 'CONNECTING';
  els.connection.querySelector('span').textContent = label;
  els.connection.classList.toggle('is-connected', normalized === 'CONNECTED');
  els.connection.classList.toggle('is-warning', normalized === 'RECONNECTING' || normalized === 'DISCONNECTED');
}

function getRoomParticipants() {
  if (!activeRoom) return [];
  return [activeRoom.localParticipant, ...activeRoom.remoteParticipants.values()];
}

function initials(name) {
  const parts = String(name || 'Guest').trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toUpperCase();
}

function participantRole(participant, local) {
  if (local && isHost) return 'HOST';
  try {
    const metadata = JSON.parse(participant.metadata || '{}');
    return metadata.role === 'host' ? 'HOST' : '';
  } catch { return ''; }
}

function createTile(participant) {
  const tile = document.createElement('article');
  tile.className = 'video-tile';
  tile.dataset.identity = participant.identity;
  tile.innerHTML = `
    <div class="video-stage">
      <div class="video-placeholder"><span class="avatar-initials"></span><span class="placeholder-caption">CAMERA OFF</span></div>
      <div class="media-layer"></div>
      <div class="tile-top-flags"><span class="tile-role hidden">HOST</span><span class="hand-flag hidden">✋ HAND RAISED</span></div>
      <div class="speaking-ring"></div>
    </div>
    <div class="tile-footer"><div class="tile-person"><strong class="tile-name"></strong><span class="tile-you hidden">YOU</span></div><div class="tile-status"><span class="tile-mic">MIC ON</span></div></div>
  `;
  els.grid.appendChild(tile);
  tileByIdentity.set(participant.identity, tile);
  return tile;
}

function renderParticipants() {
  if (!activeRoom) return;
  const participants = getRoomParticipants();
  const present = new Set(participants.map((participant) => participant.identity));
  for (const [identity, tile] of tileByIdentity) {
    if (!present.has(identity)) {
      tile.remove();
      tileByIdentity.delete(identity);
    }
  }

  participants.forEach((participant) => {
    const isLocal = participant.identity === activeRoom.localParticipant.identity;
    const tile = tileByIdentity.get(participant.identity) || createTile(participant);
    const name = participant.name || participant.identity || 'Guest';
    tile.querySelector('.tile-name').textContent = name;
    tile.querySelector('.avatar-initials').textContent = initials(name);
    tile.querySelector('.tile-you').classList.toggle('hidden', !isLocal);
    tile.querySelector('.tile-role').classList.toggle('hidden', !participantRole(participant, isLocal));
    tile.querySelector('.tile-mic').textContent = participant.isMicrophoneEnabled ? 'MIC ON' : 'MIC OFF';
    tile.querySelector('.tile-mic').classList.toggle('muted', !participant.isMicrophoneEnabled);
    tile.querySelector('.hand-flag').classList.toggle('hidden', !raisedHands.has(participant.identity));
    tile.querySelector('.speaking-ring').classList.toggle('speaking', activeSpeakers.has(participant.identity));
    tile.classList.toggle('is-speaking', activeSpeakers.has(participant.identity));
    tile.classList.toggle('is-local', isLocal);
    tile.querySelector('.video-placeholder').classList.toggle('hidden', Boolean(tile.querySelector('.media-layer video')));
  });

  const count = String(participants.length).padStart(2, '0');
  els.participantCount.textContent = count;
  els.peopleBadge.textContent = String(participants.length);
  els.panelCount.textContent = count;
  updatePeopleList(participants);
  updateControlButtons();
  els.grid.dataset.count = String(participants.length);
}

function updatePeopleList(participants = getRoomParticipants()) {
  if (!els.participants) return;
  els.participants.replaceChildren();
  participants.forEach((participant) => {
    const isLocal = activeRoom && participant.identity === activeRoom.localParticipant.identity;
    const row = document.createElement('div');
    row.className = 'participant-row';
    const avatar = document.createElement('span');
    avatar.className = 'participant-avatar';
    avatar.textContent = initials(participant.name || participant.identity);
    const details = document.createElement('span');
    details.className = 'participant-details';
    const name = document.createElement('strong');
    name.textContent = participant.name || participant.identity;
    const status = document.createElement('small');
    status.textContent = isLocal ? 'YOU' : (participant.isMicrophoneEnabled ? 'MIC ACTIVE' : 'IN THE ROOM');
    details.append(name, status);
    const role = document.createElement('span');
    role.className = 'participant-role';
    role.textContent = participantRole(participant, isLocal) || (isLocal ? 'YOU' : 'GUEST');
    row.append(avatar, details, role);
    els.participants.appendChild(row);
  });
}

function attachTrack(track, publication, participant, isLocal) {
  if (!track || !activeRoom) return;
  const identity = participant.identity;
  const key = `${identity}:${track.sid || publication?.trackSid || track.kind}`;
  if (mediaElements.has(key)) return;

  if (track.kind === Track.Kind.Audio) {
    const element = track.attach();
    element.autoplay = true;
    element.playsInline = true;
    element.dataset.trackKey = key;
    element.classList.add('remote-audio');
    $('#audio-rack')?.appendChild(element) || document.body.appendChild(element);
    mediaElements.set(key, { track, element, identity, isLocal, kind: 'audio' });
    return;
  }

  if (track.kind === Track.Kind.Video) {
    const tile = tileByIdentity.get(identity) || createTile(participant);
    const element = track.attach();
    element.autoplay = true;
    element.playsInline = true;
    element.classList.add('track-video');
    if (isLocal && track.source !== Track.Source.ScreenShare) element.classList.add('self-video');
    if (track.source === Track.Source.ScreenShare) element.classList.add('screen-track');
    element.dataset.trackKey = key;
    tile.querySelector('.media-layer').appendChild(element);
    tile.querySelector('.video-placeholder').classList.add('hidden');
    mediaElements.set(key, { track, element, identity, isLocal, kind: 'video' });
  }
}

function detachTrack(track) {
  if (!track) return;
  const matching = [...mediaElements.entries()].filter(([, item]) => item.track === track);
  matching.forEach(([key, item]) => {
    try { track.detach(item.element); } catch { /* Track may already be detached. */ }
    item.element.remove();
    mediaElements.delete(key);
    if (item.kind === 'video') {
      const tile = tileByIdentity.get(item.identity);
      if (tile && !tile.querySelector('.media-layer video')) {
        tile.querySelector('.video-placeholder').classList.remove('hidden');
      }
    }
  });
}

function updateControlButtons() {
  if (!activeRoom) return;
  const local = activeRoom.localParticipant;
  setControlState(els.toggleMic, Boolean(local.isMicrophoneEnabled), 'MUTE', 'UNMUTE');
  setControlState(els.toggleCamera, Boolean(local.isCameraEnabled), 'CAMERA', 'CAMERA OFF');
  setControlState(els.toggleScreen, screenSharing, 'STOP SHARE', 'SHARE');
  setControlState(els.toggleHand, raisedHand, 'LOWER HAND', 'RAISE HAND');
}

function setControlState(button, on, onLabel, offLabel) {
  button.setAttribute('aria-pressed', String(on));
  button.classList.toggle('control-active', on);
  const label = button.querySelector('.control-label');
  if (label) label.textContent = on ? onLabel : offLabel;
}

async function toggleMic() {
  if (!activeRoom) return;
  const next = !activeRoom.localParticipant.isMicrophoneEnabled;
  try {
    await activeRoom.localParticipant.setMicrophoneEnabled(next);
    renderParticipants();
  } catch (error) { toast(mediaErrorMessage(error, 'microphone')); }
}

async function toggleCamera() {
  if (!activeRoom) return;
  const next = !activeRoom.localParticipant.isCameraEnabled;
  try {
    await activeRoom.localParticipant.setCameraEnabled(next);
    renderParticipants();
  } catch (error) { toast(mediaErrorMessage(error, 'camera')); }
}

async function toggleScreenShare() {
  if (!activeRoom) return;
  const next = !screenSharing;
  try {
    await activeRoom.localParticipant.setScreenShareEnabled(next);
    screenSharing = next;
    updateControlButtons();
  } catch (error) {
    if (error?.name !== 'NotAllowedError') console.error(error);
    toast(error?.name === 'NotAllowedError' ? 'Screen sharing was cancelled.' : 'Screen sharing is not available in this browser.');
  }
}

async function toggleRaisedHand() {
  if (!activeRoom) return;
  raisedHand = !raisedHand;
  if (raisedHand) raisedHands.add(activeRoom.localParticipant.identity);
  else raisedHands.delete(activeRoom.localParticipant.identity);
  try {
    await sendRoomData({ type: 'hand', raised: raisedHand });
    renderParticipants();
  } catch { toast('Could not send the hand signal.'); }
}

async function sendRoomData(payload) {
  if (!activeRoom) throw new Error('Not connected');
  await activeRoom.localParticipant.publishData(encoder.encode(JSON.stringify(payload)), {
    reliable: true,
    topic: 'room05',
  });
}

function handleData(payload, participant) {
  let message;
  try { message = JSON.parse(decoder.decode(payload)); }
  catch { return; }
  if (!message || typeof message !== 'object') return;

  if (message.type === 'chat' && typeof message.text === 'string') {
    addChatMessage({
      name: String(participant?.name || message.name || 'Guest').slice(0, 28),
      text: message.text.slice(0, 400),
      time: Number(message.time) || Date.now(),
      self: false,
    });
  } else if (message.type === 'hand' && participant?.identity) {
    if (message.raised) raisedHands.add(participant.identity);
    else raisedHands.delete(participant.identity);
    renderParticipants();
  } else if (message.type === 'reaction' && typeof message.emoji === 'string') {
    showReaction(message.emoji, participant?.name || 'Someone');
  }
}

function addChatMessage({ name, text, time, self }) {
  if (els.chatEmpty) els.chatEmpty.classList.add('hidden');
  const wrapper = document.createElement('article');
  wrapper.className = `chat-message${self ? ' own-message' : ''}`;
  const header = document.createElement('div');
  header.className = 'chat-message-meta';
  const sender = document.createElement('strong');
  sender.textContent = self ? `${name} · YOU` : name;
  const clock = document.createElement('time');
  clock.textContent = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  header.append(sender, clock);
  const body = document.createElement('p');
  body.textContent = text;
  wrapper.append(header, body);
  els.chatMessages.appendChild(wrapper);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  localMessages += 1;
}

async function submitChat(event) {
  event.preventDefault();
  const text = els.chatInput.value.trim().slice(0, 400);
  if (!text || !activeRoom) return;
  const message = { type: 'chat', name: activeRoom.localParticipant.name || 'You', text, time: Date.now() };
  try {
    await sendRoomData(message);
    addChatMessage({ name: message.name, text, time: message.time, self: true });
    els.chatInput.value = '';
  } catch { toast('Message could not be sent. Check your connection.'); }
}

function showReaction(emoji, name) {
  const bubble = document.createElement('div');
  bubble.className = 'reaction-bubble';
  bubble.innerHTML = `<span class="reaction-emoji"></span><span class="reaction-name"></span>`;
  bubble.querySelector('.reaction-emoji').textContent = emoji;
  bubble.querySelector('.reaction-name').textContent = name;
  $('#reaction-floats').appendChild(bubble);
  setTimeout(() => bubble.remove(), 2400);
}

async function sendReaction(emoji) {
  if (!activeRoom) return;
  showReaction(emoji, 'You');
  try { await sendRoomData({ type: 'reaction', emoji }); }
  catch { toast('Reaction could not be sent.'); }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    toast('Copied to clipboard.');
  } catch {
    const helper = document.createElement('textarea');
    helper.value = value;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    try { document.execCommand('copy'); toast('Copied to clipboard.'); }
    catch { toast('Could not copy. Select the room code manually.'); }
    helper.remove();
  }
}

function inviteUrl() {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('room', activeCode);
  return url.toString();
}

async function shareInvite() {
  const url = inviteUrl();
  const shareData = { title: 'Join my ROOM/05', text: `Join my private ROOM/05 call. Code: ${activeCode}`, url };
  if (navigator.share) {
    try { await navigator.share(shareData); }
    catch (error) { if (error?.name !== 'AbortError') await copyText(url); }
  } else {
    await copyText(url);
  }
}

function openSidePanel(mode) {
  sidePanelMode = mode;
  els.sidePanel.classList.remove('hidden');
  els.peopleView.classList.toggle('hidden', mode !== 'people');
  els.chatView.classList.toggle('hidden', mode !== 'chat');
  els.panelKicker.textContent = mode === 'chat' ? 'ROOM CHAT' : 'THE ROOM';
  els.panelTitle.childNodes[0].textContent = mode === 'chat' ? 'Messages ' : 'People ';
  if (mode === 'chat') setTimeout(() => els.chatInput.focus(), 50);
}

function closeSidePanel() {
  sidePanelMode = '';
  els.sidePanel.classList.add('hidden');
}

function returnToLanding(message = '') {
  for (const item of mediaElements.values()) {
    try { item.track.detach(item.element); } catch { /* Track may already be detached. */ }
    item.element.remove();
  }
  if (activeRoom) {
    try { activeRoom.removeAllListeners(); activeRoom.disconnect(); } catch { /* Already disconnected. */ }
  }
  activeRoom = null;
  activeCode = '';
  isHost = false;
  raisedHand = false;
  screenSharing = false;
  raisedHands.clear();
  activeSpeakers.clear();
  tileByIdentity.clear();
  mediaElements.clear();
  els.grid.replaceChildren();
  els.chatMessages.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'chat-empty';
  empty.id = 'chat-empty';
  empty.innerHTML = '<span>✳</span><strong>Quiet in here.</strong><p>Start the conversation. Messages disappear when the room closes.</p>';
  els.chatMessages.appendChild(empty);
  els.chatEmpty = empty;
  els.call.classList.add('hidden');
  els.landing.classList.remove('hidden');
  closeSidePanel();
  els.settingsOverlay.classList.add('hidden');
  if (message) toast(message);
  const url = new URL(window.location.href);
  url.search = '';
  history.replaceState({}, '', url);
}

function openSettings() {
  if (!activeRoom) return;
  els.settingsOverlay.classList.remove('hidden');
  populateDevices();
}

async function populateDevices() {
  const selects = {
    audioinput: $('#audio-input-select'),
    videoinput: $('#video-input-select'),
    audiooutput: $('#audio-output-select'),
  };
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const [kind, select] of Object.entries(selects)) {
      const previous = select.value;
      select.replaceChildren(new Option('System default', ''));
      devices.filter((device) => device.kind === kind).forEach((device, index) => {
        const option = new Option(device.label || `${kind.replace('input', '').replace('output', '')} ${index + 1}`, device.deviceId);
        select.add(option);
      });
      if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    }
  } catch (error) {
    console.warn('Could not list media devices:', error);
    toast('Device list is unavailable. Check browser permissions.');
  }
}

async function changeDevice(kind, select) {
  if (!activeRoom || !select.value) return;
  try {
    const success = await activeRoom.switchActiveDevice(kind, select.value);
    if (success === false) throw new Error('The browser could not switch to this device.');
    toast('Device updated.');
  } catch (error) {
    toast(error.message || 'Could not change device.');
  }
}

els.create.addEventListener('click', () => enterRoom('create'));
els.join.addEventListener('click', () => enterRoom('join'));
els.code.addEventListener('input', () => { els.code.value = normalizeCode(els.code.value); });
els.name.addEventListener('keydown', (event) => { if (event.key === 'Enter') enterRoom('create'); });
els.code.addEventListener('keydown', (event) => { if (event.key === 'Enter') enterRoom('join'); });
els.copyCode.addEventListener('click', () => copyText(activeCode));
els.shareInvite.addEventListener('click', shareInvite);
els.toggleMic.addEventListener('click', toggleMic);
els.toggleCamera.addEventListener('click', toggleCamera);
els.toggleScreen.addEventListener('click', toggleScreenShare);
els.toggleHand.addEventListener('click', toggleRaisedHand);
els.chatForm.addEventListener('submit', submitChat);
$('#open-people').addEventListener('click', () => sidePanelMode === 'people' ? closeSidePanel() : openSidePanel('people'));
$('#open-chat').addEventListener('click', () => sidePanelMode === 'chat' ? closeSidePanel() : openSidePanel('chat'));
$('#close-panel').addEventListener('click', closeSidePanel);
$('#open-settings').addEventListener('click', openSettings);
$('#close-settings').addEventListener('click', () => els.settingsOverlay.classList.add('hidden'));
$('#settings-done').addEventListener('click', () => els.settingsOverlay.classList.add('hidden'));
$('#leave-room').addEventListener('click', () => returnToLanding('You left the room.'));
$('#audio-input-select').addEventListener('change', (event) => changeDevice('audioinput', event.target));
$('#video-input-select').addEventListener('change', (event) => changeDevice('videoinput', event.target));
$('#audio-output-select').addEventListener('change', (event) => changeDevice('audiooutput', event.target));

// Quick reactions are deliberately simple and ephemeral.
document.querySelectorAll('[data-reaction]').forEach((button) => {
  button.addEventListener('click', () => sendReaction(button.dataset.reaction));
});

els.settingsOverlay.addEventListener('click', (event) => {
  if (event.target === els.settingsOverlay) els.settingsOverlay.classList.add('hidden');
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeSidePanel();
    els.settingsOverlay.classList.add('hidden');
  }
  if (!activeRoom || event.target.matches('input, textarea, select, button')) return;
  if (event.key.toLowerCase() === 'm') toggleMic();
  if (event.key.toLowerCase() === 'v') toggleCamera();
});

// The app's media controls stay inert until a user starts or joins a room.

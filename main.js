'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const MAX_PEOPLE = 5;
  const JITSI_DOMAIN = 'meet.jit.si';
  const JITSI_API_URL = `https://${JITSI_DOMAIN}/external_api.js`;
  const API_LOAD_TIMEOUT_MS = 15000;

  let jitsi = null;
  let currentCode = '';
  let localName = '';
  let localJoined = false;
  let participants = new Map();
  let mutedAudio = false;
  let mutedVideo = false;
  let sharingScreen = false;
  let raisedHand = false;
  let toastTimer = null;
  let enteringRoom = false;

  const landing = $('landing-screen');
  const callScreen = $('call-screen');
  const videoGrid = $('video-grid');
  const errorBox = $('landing-error');
  const createButton = $('create-room');
  const joinButton = $('join-room');

  function toast(message) {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('visible'), 3600);
  }

  function setError(message) {
    if (errorBox) errorBox.textContent = message || '';
  }

  function makeCode() {
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') {
      throw new Error('This browser cannot create a secure room code. Open this site in an up-to-date browser over HTTPS.');
    }
    const bytes = new Uint8Array(8);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
  }

  function cleanName(value) {
    return String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 28);
  }

  function roomNameFor(code) {
    return 'room05-' + code.toLowerCase();
  }

  function directRoomUrl(code) {
    return `https://${JITSI_DOMAIN}/${encodeURIComponent(roomNameFor(code))}`;
  }

  function setEntryBusy(busy) {
    enteringRoom = busy;
    createButton.disabled = busy;
    joinButton.disabled = busy;
    createButton.querySelector('span').textContent = busy ? 'CONNECTING…' : 'CREATE A ROOM';
    joinButton.querySelector('span').textContent = busy ? '…' : 'JOIN';
    $('display-name').disabled = busy;
    $('room-code').disabled = busy;
  }

  function loadJitsiApi() {
    if (typeof window.JitsiMeetExternalAPI === 'function') return Promise.resolve();

    if (window.__room05JitsiLoading) return window.__room05JitsiLoading;

    window.__room05JitsiLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let settled = false;
      const timer = setTimeout(() => finish(new Error('The Jitsi video service did not respond in time. Check your connection and try again.')), API_LOAD_TIMEOUT_MS);

      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.onload = null;
        script.onerror = null;
        if (error) {
          script.remove();
          window.__room05JitsiLoading = null;
          reject(error);
          return;
        }
        if (typeof window.JitsiMeetExternalAPI !== 'function') {
          window.__room05JitsiLoading = null;
          reject(new Error('The Jitsi service loaded without its meeting API. Please retry or open the room directly.'));
          return;
        }
        resolve();
      }

      script.src = JITSI_API_URL;
      script.async = true;
      script.onload = () => finish();
      script.onerror = () => finish(new Error('Could not load the Jitsi video service. Check your internet connection or browser content blockers.'));
      document.head.appendChild(script);
    });

    return window.__room05JitsiLoading;
  }

  function showCall(code) {
    landing.classList.add('hidden');
    callScreen.classList.remove('hidden');
    $('active-room-code').textContent = code;
    $('footer-room-code').textContent = code;
    $('participant-count').textContent = '01';
    $('people-badge').textContent = '1';
    $('panel-count').textContent = '01';
    videoGrid.dataset.count = '1';
    videoGrid.innerHTML = '<div class="jitsi-loading"><span class="loading-mark">05</span><strong>CONNECTING THE ROOM</strong><small>Loading the video meeting…</small></div>';
    const status = $('connection-status');
    status.querySelector('span').textContent = 'CONNECTING';
    status.classList.remove('is-connected', 'is-warning');
  }

  function showStartupError(code, error) {
    callScreen.classList.add('hidden');
    landing.classList.remove('hidden');
    videoGrid.innerHTML = '';
    setEntryBusy(false);
    setError('The embedded video connection could not start. ' + (error && error.message ? error.message : 'Please try again.'));

    const link = document.createElement('a');
    link.className = 'error-room-link';
    link.href = directRoomUrl(code);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'OPEN THIS ROOM DIRECTLY ↗';
    errorBox.append(document.createTextNode(' '), link);

    const help = document.createElement('span');
    help.className = 'error-room-help';
    help.textContent = ' The same room code is ' + code + '. The first person may need to sign in to Jitsi.';
    errorBox.appendChild(help);
  }

  function updateParticipants() {
    const count = Math.max(1, participants.size + (localJoined ? 1 : 0));
    $('participant-count').textContent = String(count).padStart(2, '0');
    $('people-badge').textContent = String(count);
    $('panel-count').textContent = String(count).padStart(2, '0');
    videoGrid.dataset.count = String(Math.min(count, MAX_PEOPLE));
    const list = $('participants-list');
    list.innerHTML = '';
    const all = [{ id: 'local', name: localName, local: true }, ...Array.from(participants, ([id, name]) => ({ id, name, local: false }))];
    all.slice(0, MAX_PEOPLE).forEach((person) => {
      const row = document.createElement('div');
      row.className = 'participant-row';
      const avatar = document.createElement('span');
      avatar.className = 'participant-avatar';
      avatar.textContent = (person.name || '?').slice(0, 1).toUpperCase();
      const label = document.createElement('strong');
      label.textContent = person.name + (person.local ? ' (YOU)' : '');
      row.append(avatar, label);
      list.appendChild(row);
    });
    if (count > MAX_PEOPLE && jitsi) {
      toast('This room is over its five-seat target. Leaving to protect the room limit.');
      jitsi.executeCommand('hangup');
    }
  }

  function setButton(id, active, activeLabel, inactiveLabel) {
    const button = $(id);
    if (!button) return;
    button.setAttribute('aria-pressed', String(active));
    const label = button.querySelector('.control-label');
    if (label && activeLabel && inactiveLabel) label.textContent = active ? activeLabel : inactiveLabel;
    button.classList.toggle('is-active', active);
  }

  function bindJitsiEvents(api) {
    api.addEventListener('videoConferenceJoined', (event) => {
      localJoined = true;
      const status = $('connection-status');
      status.querySelector('span').textContent = 'CONNECTED';
      status.classList.remove('is-warning');
      status.classList.add('is-connected');
      if (event && event.displayName) localName = event.displayName;
      updateParticipants();
      toast('You are in. Send your room code to your friends.');
    });
    api.addEventListener('videoConferenceLeft', () => leaveRoom(true));
    api.addEventListener('participantJoined', (event) => {
      if (event && event.id) participants.set(event.id, event.displayName || 'Guest');
      updateParticipants();
    });
    api.addEventListener('participantLeft', (event) => {
      if (event && event.id) participants.delete(event.id);
      updateParticipants();
    });
    api.addEventListener('displayNameChange', (event) => {
      if (event && event.id && participants.has(event.id)) participants.set(event.id, event.displayname || event.displayName || 'Guest');
      updateParticipants();
    });
    api.addEventListener('audioMuteStatusChanged', (event) => {
      mutedAudio = !!(event && event.muted);
      setButton('toggle-mic', mutedAudio, 'UNMUTE', 'MUTE');
    });
    api.addEventListener('videoMuteStatusChanged', (event) => {
      mutedVideo = !!(event && event.muted);
      setButton('toggle-camera', mutedVideo, 'CAMERA ON', 'CAMERA');
    });
    api.addEventListener('screenSharingStatusChanged', (event) => {
      sharingScreen = !!(event && event.on);
      setButton('toggle-screen', sharingScreen, 'STOP SHARE', 'SHARE');
    });
    api.addEventListener('raiseHandUpdated', (event) => {
      if (event && event.id === api.getMyUserId()) {
        raisedHand = !!event.handRaised;
        setButton('toggle-hand', raisedHand, 'LOWER HAND', 'RAISE HAND');
      }
    });
    api.addEventListener('incomingMessage', (event) => {
      if (event && event.message) appendChat(event.nick || 'Guest', event.message);
    });
    api.addEventListener('errorOccurred', (event) => {
      console.error('ROOM/05 Jitsi meeting error:', event);
      const status = $('connection-status');
      status.querySelector('span').textContent = 'CHECK JITSI';
      status.classList.remove('is-connected');
      status.classList.add('is-warning');
      toast('Jitsi reported a meeting issue. Try opening the room directly if it does not continue.');
    });
    api.addEventListener('readyToClose', () => leaveRoom(true));
  }

  function appendChat(name, message) {
    const list = $('chat-messages');
    const empty = $('chat-empty');
    if (empty) empty.remove();
    const item = document.createElement('div');
    item.className = 'chat-message';
    const author = document.createElement('strong');
    author.textContent = name;
    const body = document.createElement('p');
    body.textContent = message;
    item.append(author, body);
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
  }

  async function enterRoom(requestedCode) {
    if (enteringRoom) return;
    setError('');

    const name = cleanName($('display-name').value);
    if (!name) {
      setError('Add your name first.');
      $('display-name').focus();
      return;
    }

    const code = String(requestedCode || '').toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) {
      setError('Enter a valid 8-character room code (excluding I, O, 0 and 1).');
      $('room-code').focus();
      return;
    }

    if (jitsi) {
      toast('You are already connected to a room.');
      return;
    }

    localName = name;
    currentCode = code;
    setEntryBusy(true);

    try {
      await loadJitsiApi();
      if (typeof window.JitsiMeetExternalAPI !== 'function') {
        throw new Error('The Jitsi meeting API is unavailable. Please retry.');
      }

      showCall(code);
      const parentNode = videoGrid;
      videoGrid.innerHTML = '';
      const api = new window.JitsiMeetExternalAPI(JITSI_DOMAIN, {
        roomName: roomNameFor(code),
        parentNode,
        width: '100%',
        height: '100%',
        lang: 'en',
        userInfo: { displayName: localName },
        configOverwrite: {
          prejoinPageEnabled: false,
          startWithAudioMuted: !$('start-mic').checked,
          startWithVideoMuted: !$('start-camera').checked,
          disableDeepLinking: true,
          enableWelcomePage: false,
          toolbarButtons: ['settings'],
          tileView: { disabled: false },
          hideConferenceSubject: true
        },
        interfaceConfigOverwrite: {
          SHOW_JITSI_WATERMARK: false,
          SHOW_WATERMARK_FOR_GUESTS: false,
          SHOW_BRAND_WATERMARK: false,
          SHOW_POWERED_BY: false,
          DISABLE_DOMINANT_SPEAKER_INDICATOR: false,
          TILE_VIEW_MAX_COLUMNS: 3
        }
      });

      if (!api || typeof api.addEventListener !== 'function') {
        throw new Error('The Jitsi frame could not be initialized.');
      }

      jitsi = api;
      bindJitsiEvents(jitsi);
      const iframe = jitsi.getIFrame && jitsi.getIFrame();
      if (iframe) {
        iframe.setAttribute('title', 'ROOM/05 Jitsi video meeting');
        iframe.setAttribute('allow', 'camera; microphone; display-capture; autoplay; clipboard-write; fullscreen');
        iframe.style.border = '0';
      }

      try {
        const inviteUrl = new URL(location.href);
        inviteUrl.searchParams.set('room', code);
        history.replaceState({}, '', inviteUrl.pathname + inviteUrl.search + inviteUrl.hash);
      } catch (historyError) {
        // The meeting should still work in restricted webviews that do not expose history URLs.
        console.warn('ROOM/05 could not update the invite URL:', historyError);
      }
      setEntryBusy(false);
    } catch (error) {
      console.error('ROOM/05 Jitsi startup:', error);
      if (jitsi) {
        try { jitsi.dispose(); } catch (_) {}
        jitsi = null;
      }
      showStartupError(code, error);
    }
  }

  function leaveRoom(returnToLanding = true) {
    if (jitsi) {
      const old = jitsi;
      jitsi = null;
      try { old.dispose(); } catch (_) {}
    }
    currentCode = '';
    localJoined = false;
    participants.clear();
    mutedAudio = false;
    mutedVideo = false;
    sharingScreen = false;
    raisedHand = false;
    if (returnToLanding) {
      callScreen.classList.add('hidden');
      landing.classList.remove('hidden');
      videoGrid.innerHTML = '';
      try {
        const url = new URL(location.href);
        url.searchParams.delete('room');
        history.replaceState({}, '', url.pathname + url.search + url.hash);
      } catch (historyError) {
        console.warn('ROOM/05 could not reset the invite URL:', historyError);
      }
    }
  }

  function openPanel(type) {
    $('side-panel').classList.remove('hidden');
    const people = type === 'people';
    $('people-view').classList.toggle('hidden', !people);
    $('chat-view').classList.toggle('hidden', people);
    $('panel-kicker').textContent = people ? 'THE ROOM' : 'LIVE CONVERSATION';
    $('panel-title').childNodes[0].textContent = people ? 'People ' : 'Chat ';
  }

  createButton.addEventListener('click', () => {
    try {
      enterRoom(makeCode());
    } catch (error) {
      setError(error.message || 'Could not create a room code. Please reload the page and try again.');
    }
  });

  joinButton.addEventListener('click', () => {
    const code = $('room-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    enterRoom(code);
  });

  $('room-code').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  });
  $('room-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') joinButton.click();
  });
  $('display-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') createButton.click();
  });

  $('copy-code').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(currentCode);
      toast('Room code copied.');
    } catch (_) {
      toast('Your room code is ' + currentCode);
    }
  });

  $('share-invite').addEventListener('click', async () => {
    const url = new URL(location.href);
    url.searchParams.set('room', currentCode);
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Join my ROOM/05', text: 'Join my video room with code ' + currentCode, url: url.toString() });
      } else {
        await navigator.clipboard.writeText(url.toString());
        toast('Invite link copied.');
      }
    } catch (_) {
      toast('Room code: ' + currentCode);
    }
  });

  $('toggle-mic').addEventListener('click', () => jitsi && jitsi.executeCommand('toggleAudio'));
  $('toggle-camera').addEventListener('click', () => jitsi && jitsi.executeCommand('toggleVideo'));
  $('toggle-screen').addEventListener('click', () => jitsi && jitsi.executeCommand('toggleShareScreen'));
  $('toggle-hand').addEventListener('click', () => jitsi && jitsi.executeCommand('toggleRaiseHand'));
  $('open-people').addEventListener('click', () => openPanel('people'));
  $('open-chat').addEventListener('click', () => openPanel('chat'));
  $('close-panel').addEventListener('click', () => $('side-panel').classList.add('hidden'));

  $('chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('chat-input');
    const message = input.value.trim();
    if (!message || !jitsi) return;
    jitsi.executeCommand('sendChatMessage', message);
    appendChat(localName + ' (YOU)', message);
    input.value = '';
  });

  document.querySelectorAll('[data-reaction]').forEach((button) => button.addEventListener('click', () => {
    if (!jitsi) return;
    const emoji = button.dataset.reaction;
    jitsi.executeCommand('sendChatMessage', emoji);
    toast('Reaction sent: ' + emoji);
  }));

  $('leave-room').addEventListener('click', () => {
    if (jitsi) jitsi.executeCommand('hangup');
    leaveRoom();
  });
  $('open-settings').addEventListener('click', () => {
    $('settings-overlay').classList.remove('hidden');
    toast('Use the settings control inside the video window to choose devices.');
  });
  $('close-settings').addEventListener('click', () => $('settings-overlay').classList.add('hidden'));
  $('settings-done').addEventListener('click', () => $('settings-overlay').classList.add('hidden'));

  const initialCode = new URLSearchParams(location.search).get('room');
  if (initialCode && /^[A-HJ-NP-Z2-9]{8}$/i.test(initialCode)) {
    $('room-code').value = initialCode.toUpperCase();
  }

  window.addEventListener('beforeunload', () => {
    if (jitsi) {
      try { jitsi.dispose(); } catch (_) {}
    }
  });
})();

'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const landing = $('landing');
  const meeting = $('meeting');
  const form = $('room-form');
  const nameInput = $('display-name');
  const codeInput = $('room-code');
  const createButton = $('create-button');
  const errorBox = $('form-error');
  const meetingError = $('meeting-error');
  const frame = $('meeting-frame');
  const loading = $('meeting-loading');
  const loadingMessage = $('loading-message');

  let jitsiApi = null;
  let activeRoomCode = '';
  let joinTimeout = null;
  let loadingTimer = null;

  function makeRoomCode() {
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') {
      throw new Error('Secure room-code generation is unavailable. Please open this site using its HTTPS Render link.');
    }
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const random = new Uint8Array(10);
    window.crypto.getRandomValues(random);
    const token = Array.from(random, (value) => alphabet[value % alphabet.length]).join('');
    return `R05-${token.slice(0, 5)}-${token.slice(5)}`;
  }

  function cleanRoomCode(value) {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);
  }

  function showError(message) {
    errorBox.textContent = message;
  }

  function setBusy(busy) {
    createButton.disabled = busy;
    const label = createButton.querySelector('span:first-child');
    if (label) label.textContent = busy ? 'OPENING ROOM…' : 'CREATE A ROOM';
  }

  function resetTimers() {
    if (joinTimeout) window.clearTimeout(joinTimeout);
    if (loadingTimer) window.clearTimeout(loadingTimer);
    joinTimeout = null;
    loadingTimer = null;
  }

  function loadJitsiScript() {
    if (typeof window.JitsiMeetExternalAPI === 'function') return Promise.resolve();
    if (window.__room05JitsiPromise) return window.__room05JitsiPromise;

    window.__room05JitsiPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://meet.jit.si/external_api.js';
      script.async = true;
      script.onload = () => {
        if (typeof window.JitsiMeetExternalAPI === 'function') {
          resolve();
        } else {
          window.__room05JitsiPromise = null;
          script.remove();
          reject(new Error('Jitsi loaded, but its meeting API was not available. Please try again.'));
        }
      };
      script.onerror = () => {
        window.__room05JitsiPromise = null;
        script.remove();
        reject(new Error('Could not load Jitsi Meet. Check your connection, then tap Create Room again.'));
      };
      document.head.appendChild(script);
    });

    return window.__room05JitsiPromise;
  }

  function clearJitsiFrame() {
    frame.querySelectorAll('iframe').forEach((node) => node.remove());
  }

  function disposeMeeting() {
    resetTimers();
    if (jitsiApi) {
      try { jitsiApi.dispose(); } catch (error) { console.warn('Jitsi dispose warning:', error); }
      jitsiApi = null;
    }
    clearJitsiFrame();
  }

  async function enterRoom(roomCode) {
    const displayName = nameInput.value.trim();
    if (!displayName) {
      showError('Please enter your name first.');
      nameInput.focus();
      return;
    }
    if (!roomCode) {
      showError('Please enter a room code.');
      codeInput.focus();
      return;
    }

    showError('');
    meetingError.textContent = '';
    setBusy(true);

    try {
      await loadJitsiScript();

      activeRoomCode = roomCode;
      $('active-room').textContent = roomCode;
      loadingMessage.textContent = 'Contacting Jitsi Meet…';
      loading.classList.remove('hidden');
      landing.classList.add('hidden');
      meeting.classList.remove('hidden');
      disposeMeeting();
      loading.classList.remove('hidden');

      const options = {
        roomName: roomCode,
        parentNode: frame,
        width: '100%',
        height: '100%',
        userInfo: { displayName }
      };

      // Jitsi's official IFrame API creates and manages the meeting iframe.
      // Keep the public meet.jit.si branding visible as requested by Jitsi.
      jitsiApi = new window.JitsiMeetExternalAPI('meet.jit.si', options);

      jitsiApi.addListener('videoConferenceJoined', () => {
        resetTimers();
        loading.classList.add('hidden');
        meetingError.textContent = '';
      });

      jitsiApi.addListener('readyToClose', () => {
        leaveRoom();
      });

      jitsiApi.addListener('videoConferenceLeft', () => {
        loading.classList.add('hidden');
      });

      jitsiApi.addListener('errorOccurred', (event) => {
        const detail = event && (event.message || event.name || event.type);
        meetingError.textContent = detail
          ? `Jitsi reported a meeting error: ${detail}`
          : 'Jitsi reported a meeting error. Please try leaving and joining again.';
      });

      jitsiApi.addListener('cameraError', () => {
        meetingError.textContent = 'Camera access failed. Check your browser permissions and device settings.';
      });
      jitsiApi.addListener('micError', () => {
        meetingError.textContent = 'Microphone access failed. Check your browser permissions and device settings.';
      });

      // Avoid leaving users with an endless spinner if the public service blocks or cannot join the room.
      joinTimeout = window.setTimeout(() => {
        if (!loading.classList.contains('hidden')) {
          loadingMessage.textContent = 'Jitsi has not confirmed the connection yet. Check your internet and camera/microphone permissions. The public service may also temporarily restrict access.';
        }
      }, 25000);

      setBusy(false);
    } catch (error) {
      disposeMeeting();
      activeRoomCode = '';
      meeting.classList.add('hidden');
      landing.classList.remove('hidden');
      setBusy(false);
      showError(error && error.message ? error.message : 'Could not open the room. Please try again.');
      console.error('ROOM/05 room creation failed:', error);
    }
  }

  function leaveRoom() {
    disposeMeeting();
    loading.classList.remove('hidden');
    loadingMessage.textContent = 'Contacting Jitsi Meet…';
    meeting.classList.add('hidden');
    landing.classList.remove('hidden');
    meetingError.textContent = '';
    activeRoomCode = '';
    setBusy(false);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      enterRoom(makeRoomCode());
    } catch (error) {
      showError(error && error.message ? error.message : 'Could not generate a room code.');
    }
  });

  $('join-button').addEventListener('click', () => {
    const code = cleanRoomCode(codeInput.value);
    codeInput.value = code;
    enterRoom(code);
  });

  codeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('join-button').click();
    }
  });

  $('leave-button').addEventListener('click', leaveRoom);

  $('copy-link').addEventListener('click', async () => {
    if (!activeRoomCode) return;
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', activeRoomCode);
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('Clipboard access is unavailable in this browser.');
      }
      await navigator.clipboard.writeText(url.toString());
      $('copy-link').textContent = 'COPIED ✓';
      window.setTimeout(() => { $('copy-link').textContent = 'COPY INVITE ↗'; }, 1800);
    } catch (error) {
      meetingError.textContent = `Copy this invite link manually: ${url.toString()}`;
    }
  });

  const roomFromUrl = new URLSearchParams(window.location.search).get('room');
  if (roomFromUrl) codeInput.value = cleanRoomCode(roomFromUrl);
})();

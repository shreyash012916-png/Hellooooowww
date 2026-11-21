# ROOM/05 — Free peer-to-peer video rooms (v4)

Direct browser-to-browser video, voice, chat and screen sharing (WebRTC).
No Jitsi, no LiveKit, no API keys, no accounts, no database.

The small Node server only (1) serves the website and (2) passes tiny
"signaling" messages so browsers can find each other. Audio and video never
go through the server.

## What's new in v4

- 7 theme options (Auto follows your device, Cream, Midnight, Grape, Sunset, Bubblegum, Matcha), saved per device.
- Clean touch/click feedback: no blue boxes, smooth press animations, haptics on supported phones.
- Sharper, smoother video: adaptive 1080p/720p/540p by room size, high-bitrate encoding, screen share tuned for text detail, 48 kHz noise-suppressed audio. Quality picker in Setup.
- Live connection indicator (latency + signal strength), auto-reconnect, screen wake-lock, ICE recovery.
- Gen Z touches: reactions (🔥💀😭✨❤️🎉), confetti hype for everyone, 📸 group-photo snap, pin/spotlight, fullscreen tile, join/leave sounds, keyboard shortcuts (M V S H C P F).
- Faster loading: gzip + caching, preconnected fonts.

## Deploy (GitHub + Render)

1. Create a GitHub repo and upload ALL files from this zip to the repo root (no folders).
2. Render → New → Web Service → connect the repo, branch `main`.
3. Runtime Node · Build `npm install` · Start `npm start` · Instance type Free · Root Directory blank.
   (Or choose "Blueprint" — `render.yaml` is included.)
4. Open your `onrender.com` URL (HTTPS is required for camera/mic).

## Settings (optional, Render → Environment)

- `MAX_PEOPLE` — people per room (default 5). Server-enforced.
- `TURN_URL`, `TURN_USER`, `TURN_PASS` — optional TURN relay for strict networks.

## Honest limits

- Every person sends video to every other person, so quality depends on each
  person's upload speed. 2-6 people is the sweet spot; more will strain phones/laptops.
- Free STUN works for most home/mobile networks. Some corporate/school/carrier
  networks block direct connections and need a TURN relay (set the variables above).
- Render's free plan sleeps after ~15 min idle; the first visit may take ~30-60 s to wake.
  Active calls are unaffected while people are connected.
- Room codes are random but anyone with the code can join.

## Local run

    npm install
    npm start

Open http://localhost:3000 (camera/mic work on localhost).

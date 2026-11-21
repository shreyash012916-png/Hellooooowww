# ROOM/05 — Jitsi Edition

A custom brutalist-style video-room landing page and meeting shell. Video/audio transport is embedded from the public Jitsi Meet service (`meet.jit.si`) through Jitsi's official IFrame API.

## What is included

- Create a random 8-character room code or join with a code.
- Copy/share an invitation URL (`?room=CODE`).
- Embedded Jitsi video meeting, camera, microphone, screen sharing, hand raise and meeting controls.
- Custom participant panel and chat panel wired to Jitsi events/commands.
- Responsive dark/cream/acid-yellow editorial interface.
- No LiveKit account, API key, API secret, database, or environment variables required.
- Small Node HTTP server for Render deployment.

## Important limitations of the public Jitsi service

1. **Host sign-in:** `meet.jit.si` requires the person who starts a new room to authenticate with one of the sign-in methods shown by Jitsi. Guests can join after the host has started the room. This is a Jitsi public-service policy, not a ROOM/05 account requirement. See https://jitsi.org/blog/authentication-on-meet-jit-si/.
2. **Testing service:** Jitsi says `meet.jit.si` is suitable for testing integrations, not production applications. For a production launch, use Jitsi as a Service or operate your own Jitsi deployment. See https://jitsi.org/api/.
3. **Five-person cap:** The UI monitors the participant count and asks a client to leave if it observes more than five participants. Because this version uses the public Jitsi server without a private authenticated admission backend, this is a best-effort client-side guard, **not a security-enforced five-person limit**. A person with the room link can also attempt to join directly.
4. **Room privacy:** Room codes are random and hard to guess, but anyone who receives a room code/link can attempt to enter. Do not use this for confidential meetings.
5. **Availability and limits:** Public Jitsi service capacity, access policies, meeting duration and availability are controlled by Jitsi and can change. ROOM/05 cannot guarantee them.
6. **Mobile:** The Jitsi IFrame API supports mobile browsers, but camera/microphone permissions and embedded meeting behavior vary by browser and device. Use an up-to-date Chrome/Firefox/Safari browser and allow camera/microphone access.

## Deploy to Render

1. Extract this ZIP. All project files are at the ZIP root (no nested project directory).
2. Create a GitHub repository named `room05-jitsi`.
3. Upload the extracted files directly to the repository root and commit them.
4. In Render, choose **New → Web Service**, connect the GitHub repository, and select the `main` branch.
5. Set:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free** (if available in your account/region)
   - Root Directory: leave blank
6. Deploy. No LiveKit variables or other secrets are needed.
7. Open the `onrender.com` URL. Create a room. The first person may be prompted to sign in to Jitsi; complete that prompt to start the room. Share the ROOM/05 invite link with guests.

Render deploys web services from connected Git repositories and runs the configured build/start commands. See https://render.com/docs/deploys.

## Local run

Requires Node.js 18 or newer:

```bash
npm install
npm start
```

Open http://localhost:3000.

## Health check

`GET /health` returns a small JSON status response. This checks the ROOM/05 web server only; it does not prove that the public Jitsi service is reachable or that a meeting can be created.

## Browser permissions

The site must be opened over HTTPS (Render provides HTTPS) for camera and microphone access. The browser will ask for permissions when Jitsi initializes the meeting.

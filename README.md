# ROOM/05 — Jitsi edition (flat upload package)

This ZIP deliberately contains **no folders**. Every project file is at the top level so you can upload the files directly into the root of a GitHub repository.

## Files in this ZIP

- `index.html` — website structure
- `styles.css` — interface styling
- `app.js` — create/join room and Jitsi IFrame API integration
- `server.js` — Node web server and `/health` endpoint
- `package.json` — start command and Node version
- `render.yaml` — Render service configuration
- `README.md` — these instructions

## Deploy on Render

1. Extract the ZIP on your device.
2. Open your GitHub repository and upload **all seven files** from inside the extracted ZIP directly into the repository's top level. Do not upload a containing folder. The repository root should show `package.json`, `server.js`, `render.yaml`, `index.html`, `styles.css`, `app.js`, and `README.md` together.
3. In Render, create a new **Web Service** and connect that GitHub repository.
4. Use these settings if Render asks for them:
   - Runtime: Node
   - Build command: `npm install --package-lock=false --no-audit --no-fund`
   - Start command: `npm start`
5. Deploy. Render should use the `/health` endpoint as its health check when it reads `render.yaml`.

No API key, Jitsi account, or environment variable is needed by this project. Render supplies the `PORT` value automatically.

## Use the website

- **Create:** enter your name and press `CREATE A ROOM`. ROOM/05 generates a hard-to-guess room code and opens the Jitsi meeting.
- **Join:** enter the room code and press `JOIN`.
- **Invite:** press `COPY INVITE` and send that link to the other participants. They open it, enter their own names, and join the same room.

## Important limitations

- The video service is the public `meet.jit.si` service. Jitsi's official site says it is suitable for testing integrations and is not intended as the production service for an application. Access rules, availability, and capacity are controlled by Jitsi and can change. A paid Jitsi as a Service account or a separately managed Jitsi deployment may be needed for dependable production use.
- ROOM/05 does not enforce a five-participant maximum. The public Jitsi service controls participant capacity.
- This project cannot be fully verified against the live Jitsi servers from a local syntax test. The local checks validate the app files and server; the actual conference still depends on Jitsi being reachable and allowing the room.
- Use the HTTPS Render URL and allow camera/microphone access in your browser. On mobile, use an up-to-date browser.
- A room code is an invitation, not a password. Do not post meeting links publicly.

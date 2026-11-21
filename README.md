# ROOM/05 — GitHub + Render

A private browser video-room app. LiveKit Cloud provides the WebRTC media infrastructure; this Node server creates signed room tokens and enforces a five-participant room limit through LiveKit's RoomService. Static HTML/CSS/JS files are served as their original bytes with the correct content types.

## Files

All application files are at the repository root (no nested source folders): `index.html`, `style.css`, `main.js`, `favicon.svg`, `server.js`, `package.json`, and `render.yaml`.

## Deploy with GitHub and Render (no terminal needed)

1. Download and extract the ZIP.
2. On GitHub, create a new **Public** or **Private** repository named `room05`.
3. Choose **Add file → Upload files**.
4. Open the extracted folder and select all files inside it. Drag those files into the GitHub upload area. Upload the files themselves, not the containing folder or ZIP. They should appear at the repository root.
5. Click **Commit changes**.
6. Create a LiveKit Cloud project at https://cloud.livekit.io/ and copy its WebSocket URL, API key, and API secret.
7. On Render, choose **New → Web Service → Build and deploy from a Git repository**, connect GitHub, and select `room05`.
8. Render should detect Node. Set Build Command to `npm install` and Start Command to `npm start`.
9. Select the Free instance type if it is offered for your account/region.
10. In the Render service's **Environment** tab, add:
    - `LIVEKIT_URL` = your LiveKit server URL (usually starts with `wss://`)
    - `LIVEKIT_API_KEY` = your LiveKit API key
    - `LIVEKIT_API_SECRET` = your LiveKit API secret
11. Save changes and deploy. Never put the API secret in `main.js`, `index.html`, or GitHub.
12. Open the `onrender.com` URL. Test creating a room and joining from a second device/browser.

## Notes

- Render free web services may spin down when idle and take time to wake up. This can delay the first room request after inactivity.
- LiveKit Cloud is a separate service and has its own plan, usage limits, and pricing. Cloud hosting being free does not make video relay unlimited or guaranteed free.
- Browser camera/microphone access requires HTTPS; Render provides HTTPS on its service URL.
- The five-person maximum is set when creating the LiveKit room. The join API also checks the current participant count before issuing a token. LiveKit's room-level maximum is the final enforcement.
- Chat is sent over LiveKit data messages and is not stored by this app. No recording feature is included.


## If you already deployed the previous ZIP

Upload the corrected files from this ZIP to the same GitHub repository (replace the existing files at the repository root), commit the changes, and let Render redeploy. Keep the existing Render Environment variables. No change to the Build Command (`npm install`) or Start Command (`npm start`) is needed.

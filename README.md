# RoomCast 🎥

Public screen-sharing rooms with real-time audio, built for GitHub Pages.

- **Hosts** create a room and get a 6-character code (e.g. `K7W-2QX`), then share their screen with **system audio + microphone** to everyone with the code.
- **Viewers** type the code to join instantly — no installs, no accounts. They can join with their camera & mic for **two-way talk**.
- Peer-to-peer WebRTC (low latency). The only server involved is the free PeerJS signaling cloud, which disappears right after both peers connect.

## Run it locally

```bash
# Python
python -m http.server 8080
# or Node
npx serve .
```

Open `http://localhost:8080`. Use two browser tabs/windows to try host + viewer side-by-side.
Screen sharing requires a **desktop Chromium browser** (Chrome, Edge, Brave, Opera) over **https or localhost** — Firefox/Safari can share video but only some support system audio.

## Publish to GitHub Pages

1. Create a repo on GitHub (any name, e.g. `roomcast`).
2. Push this folder to the `main` branch:

   ```bash
   git init
   git add .
   git commit -m "RoomCast screen sharing app"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

3. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**.
4. In ~1 minute your site is live at `https://<you>.github.io/<repo>/`.

That's it — no build step, no backend, no environment variables.

## How it works

| Piece | Where |
|---|---|
| Landing / room UI (reference-matched) | `index.html`, `css/style.css` |
| PeerJS signaling, WebRTC calls, chat, controls | `js/app.js` |

- `getDisplayMedia({ audio: true })` captures the screen with system/tab audio; a second dedicated microphone track is layered on top so you can speak over the content.
- Because browsers can't append tracks to a live WebRTC call without renegotiation, when you press "Start sharing" mid-meeting the host asks connected viewers to re-dial once (`recall` message over the data channel) — it happens in under a second and picks up the new tracks.
- Guests connect with camera+mic asks; if permission is denied they join read-only. Mic/camera toggles instantly mute those outgoing tracks.

## Tips for the host

- Chrome only shares **system** audio on Windows (choose "Tab" or "Entire screen" and tick *Share audio*). On macOS the OS may require enabling mic permission in Chrome's dialog.
- Press the screen-share button again isn't needed — pressing the browser's own "Stop sharing" bar is detected and the room falls back to waiting-for-host.
- Double-click the big video for fullscreen.

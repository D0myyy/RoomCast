# RoomCast

**Public screen-sharing rooms with real-time audio — built for GitHub Pages.**

One person creates a room, gets a short code, and streams their screen live — with system audio and microphone layered on top. Everyone else just types the code and watches, no accounts, no installs, no downloads. The site is fully static, so it can be served by GitHub Pages (or S3, Nginx, anything that serves files) with zero backend.

---

## Table of contents

1. [What it does](#what-it-does)
2. [Quick start](#quick-start)
3. [How it works — the 30-second version](#how-it-works--the-30-second-version)
4. [How it works — the detailed version](#how-it-works--the-detailed-version)
5. [Streaming protected content (Netflix, Prime, etc.)](#streaming-protected-content-netflix-prime-etc)
6. [Browser support](#browser-support)
7. [Privacy](#privacy)
8. [Hosting it yourself](#hosting-it-yourself)
9. [Project structure](#project-structure)

---

## What it does

| Role | Capability |
|---|---|
| **Host** | Create a room and broadcast the screen at up to 60 fps, with *system/tab audio* **plus** a dedicated microphone track layered over it (talk-over narration). |
| **Host** | Turn a webcam on or off at any time; viewers get it as a picture-in-picture tile. |
| **Guest** | Join with a 6-character code (e.g. `K7W-2QX`). A microphone is enough — the camera is entirely optional. Guests without a camera simply get no self-video tile (never a black box). |
| **Everyone** | Media controls (mic, camera, share state), remote volume with mute, room timer, live text chat, and an immersive fullscreen mode with no borders and no buttons. |
| **Everyone** | Rejoin, dead-code recovery, automatic ICE watchdog retry, and a redial flow so viewers receive tracks added mid-stream. |

## Quick start

```bash
# any static server works — no build step, no dependencies
python -m http.server 8080
# or: npx serve .
```

Open `http://localhost:8080` in **desktop Chrome / Edge / Brave**, then open the URL again in a second window to test host and guest side-by-side. (Windows users can just run `server.ps1` instead.)

<<<<<<< HEAD
## How it works — the 30-second version

```
Host page                       PeerJS cloud (free signaling)              Guest page
─────────                       ───────────────────────────               ──────────
 1. Create room  ─────────────► claim ID "RoomCast-<code>" ◄──────────── 2. Type code
 3. getDisplayMedia ┐           (tracks who is online, relays SDP/ICE)    4. getUserMedia
 5. WebRTC offer/answer ──────────── exchanged via PeerJS ────────────► 
 6. Media flows directly ────────── peer-to-peer (DTLS-SRTP) ─────────► 7. <video> plays it
 8. Chat/controls ──────────────── DataChannel ───────────────────────►
```

The signaling server *only* agrees who talks to whom — after that, **streaming media never touches a server**. Screen pixels, audio, and chat go over a direct encrypted WebRTC connection between the host and each watcher.

## How it works — the detailed version

### Signaling and rooms

- The **host claims a stable PeerJS ID** — `RoomCast-` + the room code. That ID *is* the room: a guest's join is literally "call this ID".
- Guests get **random Peer IDs** and dial the host. Because calls are initiated by guests, no one can be called who did not ask to be in the room, and the host never polls for clients.
- Signaling runs on the free **PeerJS cloud** (`0.peerjs.com`). All it does is pass SDP offer/answer and ICE candidates. It cannot see (or decrypt) any media, and the per-room association **disappears as soon as both peers disconnect**. No database, no persistence, no telemetry.
- Each room uses two channels:
  - **MediaConnection** (WebRTC): screen/audio to the host.
  - **DataConnection** (reliable): chat, names, "I joined/left" system messages, and control messages like `recall`.
=======
## How it works
>>>>>>> 82a7533d74d3264e0c1c04e22ec1952f8922d37b

### Media pipeline

1. **Host screen capture** — `navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: true })` captures the chosen surface with whatever audio that source carries.
2. **Microphone layer** — a *second*, echo-cancelled `getUserMedia({ audio })` track is added on top. The host microphone and the content audio travel as separate tracks, so muting the mic button is just `track.enabled = false` and never cuts the content audio.
3. **Track delivery to guests** — tracks are in the *initial offer*, because guests dial first and the host answers with the captured stream. That is why guests must exist before/while sharing begins... which browsers make moot anyway: **when the host presses "Start sharing" mid-meeting**, they cannot append tracks to a live call, so RoomCast asks each connected guest (over the DataChannel) to redial once. The redial completes in under a second and picks up the new tracks. A watchdog re-dials again if ICE stalls.
4. **Host webcam** — the host can enable a camera at any time. Since the main call already carries screen+audio, the webcam goes out as a **separate MediaConnection** to each viewer, answered automatically, and rendered as a picture-in-picture tile. This also keeps the webcam independent — host can mute camera without interrupting the stream.
5. **Guest media** — at join, RoomCast *asks separately* for the microphone and for the camera, in that order. A missing mic is fine (watch-only mode); a missing camera is even more fine — the guest's self-video tile is simply not created, because the code only adds the tile if a live, un-muted video track actually exists and it listens for `mute`/`ended`/`unmute` events to drop/restore it later. Guests **never see a black rectangle** for a camera they don't have.
6. **Audio on guest side** — the received stream plays directly through the `<video>` element; the volume slider and mute button adjust that element (and any incoming per-guest audio on the host's side).

### The UI

The chrome-free `index.html` + `css/` + vanilla `js/` stack is chosen so GitHub Pages hosting needs no build. The UI mimics the reference: big rounded video stage, session timer top-left, self-view tiles top-right, volume dock bottom-left, circular glass controls centered, sliding chat panel.

**Immersive fullscreen** (new): the expand button makes the video go true edge-to-edge — no border, no rounded corners, no buttons, no thumbnails, no chat, nothing. One tap anywhere reveals a single *Exit fullscreen* button; another tap (on that button) leaves fullscreen. Pressing `Esc` also leaves.

## Streaming protected content (Netflix, Prime, etc.)

Chrome/Firefox hide DRM-protected video from screen capture (the pixels live on a secure GPU "overlay" plane; the canvas text is black in the feed). There's the well-known article [“I Broke Netflix's Screen Protection in One Line of Code”](https://medium.com/@ysmtb24/i-broke-netflixs-screen-protection-in-one-line-of-code-9717f2e22062) whose one-liner is `app.disableHardwareAcceleration()` — that's an **Electron** call, though; it is not reachable from a normal web page. RoomCast bakes the equivalent *fix path* into the app itself:

- While sharing, RoomCast **samples live frames** of your captured video through an offscreen canvas. If it's consistently black or frozen, it displays a **"protected content" helper**, with the actual fixes:

  1. **Capture the Entire screen, not the tab.** When Chrome's share picker opens, pick *Entire screen* rather than the Chrome tab, and keep the video player **windowed** (not fullscreen). Display-level capture usually gets the actual composited pixels that tab-level content protection hides.
  2. **If still black — switch Chrome to software rendering.** Open `chrome://settings/system`, turn **“Use graphics acceleration when available”** OFF, and relaunch. That is literally Chrome's equivalent of `app.disableHardwareAcceleration()` — the video now renders on the standard compositor instead of a protected overlay plane, so **capture sees real pixels** (this is the exact mechanism the article describes).
  3. **Redo sharing** picking *Entire screen* and tick “Share audio”, so the movie sound streams too.

- The **host panel** has a helper button right in the waiting room: *“Streaming protected content (Netflix, etc.)?”*. It contains the same steps and is open anytime.

Nothing decrypts anything here — DRM keys remain behind the Content Decryption Module, and the playback itself stays fully licensed. RoomCast simply bridges you to the two legitimate, documented Chromium paths that stop that same video from being hidden from your own capture.

> ⚠️ Netflix/Prime/Disney+ respectively enforce *account* terms that disallow sharing their video with others. RoomCast doesn't stream to 10 strangers; it streams your screen — be responsible and mind the terms you accepted.

## Browser support

| Browser | Screen share | Screen audio | Guest camera |
|---|---|---|---|
| Chrome / Edge / Brave | ✅ full (incl. system audio on Windows) | ✅ (tick *Share audio* in picker) | ✅ |
| Firefox | ✅ (no system-audio capture of a whole screen) | tab-audio only | ✅ |
| Safari (macOS) | ⚠️ screen only | ❌ | ✅ |
| Mobile browsers | ❌ no `getDisplayMedia` | — | join-only (watch from a guest tab) |

Protected-content capture (Section above) is Chromium-specific and machine-dependent; the helper walks you through what your setup supports.

## Privacy

- No analytics, no cookies, no server storage. The only third-party request is PeerJS's free signaling cloud (relaying offer/answer packets only) + Google Fonts / the PeerJS CDN for assets.
- Media is end-to-end encrypted **transport-wise** (DTLS-SRTP); chat e2e runs on the WebRTC DataChannel (also DTLS-SRTP).
- `localStorage` is not used; room names live in memory only.
- Everything dies when the tab dies.

## Hosting it yourself

Anything static. On GitHub Pages:

```bash
git init
git add .
git commit -m "RoomCast screen sharing app"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then **Settings → Pages → Deploy from a branch → `main` / `(root)`** — live in about a minute at `https://<you>.github.io/<repo>/`.

PeerJS cloud is rate-limited by fairness, not a key. For heavy/secure use, run your own [peerjs-server](https://github.com/peers/peerjs-server) (`npx peerjs-server`, one small Node box) and set its URL as the `new Peer(…, { host, secure, path })` option — one line in `js/app.js`.

## Project structure

```
index.html        markup: lobby, connecting, room, ended screens
css/style.css     all visual styling (reference-match + fullscreen mode)
js/app.js         signaling, media, chat, camera, fullscreen, capture-fix
server.ps1        PowerShell static server for local testing (Windows)
```

No build, no bundler, no dependencies to install.

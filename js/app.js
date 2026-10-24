/* ============================================================
   RoomCast — WebRTC screen sharing with audio, PeerJS signaling
   Owner: creates a room, shares screen(+system audio & mic) to viewers,
          optional own webcam (sent as picture-in-picture to viewers).
   Viewer: joins with a code; mic for talk, camera entirely optional —
          no camera means no self-video tile at all (never a black box).
   ============================================================ */
"use strict";

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const genCode = () =>
  Array.from({ length: 6 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join("");
const formatCode = (code) => (code.length === 6 ? code.slice(0, 3) + "-" + code.slice(3) : code);

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  $("toastHost").appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function fmtTime(s) {
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return `${h}:${m}:${String(s % 60).padStart(2, "0")}`;
}

/* ---------- state ---------- */
const state = {
  role: null,               // "owner" | "viewer"
  peer: null,
  roomCode: null,
  rejoinCode: null,
  name: "",
  screenStream: null,       // owner outgoing screen (+system audio + mic)
  micTrack: null,
  ownerCamStream: null,     // owner's local webcam (self-view + PiP to viewers)
  hostCamCalls: new Map(),  // owner: viewerPeerId -> media call carrying the webcam
  answeredCalls: new Map(), // owner: peerId -> media call (viewer -> host screen call)
  ownStream: null,          // viewer outgoing mic (+ optional cam)
  call: null,               // viewer: media call to host (screen)
  hostCamCall: null,        // viewer: media call receiving host webcam
  dataConn: null,           // viewer data connection
  dataConns: new Map(),     // owner: peerId -> data connection
  timerInt: null,
  timerStart: 0,
  sharing: false,
  outMuted: false,          // local mute of received audio
};

/* ---------- screens ---------- */
const screens = { lobby: $("lobby"), connecting: $("connecting"), room: $("room"), ended: $("ended") };
function show(name) {
  Object.values(screens).forEach((el) => el.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

/* ============================================================
   PEER SETUP
   ============================================================ */
const peerConfig = {
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" },
    ],
    iceCandidatePoolSize: 4,
  },
};

function startPeer(code, role) {
  state.role = role;
  state.roomCode = code;
  state.rejoinCode = code;
  show("connecting");
  $("connectingLabel").textContent = role === "owner" ? "Creating your room…" : "Connecting to room…";

  // Owner claims the room's stable ID; viewers get a random one.
  const peer = role === "owner" ? new Peer("RoomCast-" + code, peerConfig) : new Peer(peerConfig);
  state.peer = peer;

  peer.on("open", () => enterRoomUI());
  peer.on("disconnected", () => { try { peer.reconnect(); } catch (_) {} });
  peer.on("error", (err) => {
    console.error("[peer] error:", err.type, err);
    teardown();
    if (err.type === "unavailable-id") {
      show("lobby");
      toast("That code is already in use — generating a new one…", "warn");
      if (role === "owner") { state.rejoinCode = null; setTimeout(() => startPeer(genCode(), "owner"), 400); }
    } else if (err.type === "peer-unavailable") {
      show("lobby");
      toast("Room not found — check the code.", "warn");
    } else {
      show("ended");
      $("endedTitle").textContent = "Connection error";
      $("endedSub").textContent = "Signaling problem — type [" + (err.type || "unknown") + "]";
    }
  });

  if (role === "owner") wireOwnerHandlers(peer);
  else wireViewerCallHandlers(peer);
}

/* ============================================================
   OWNER
   ============================================================ */
function wireOwnerHandlers(peer) {
  // Media calls from viewers (they dial us with their mic/cam)
  peer.on("call", (call) => {
    const answerStream = new MediaStream();
    if (state.screenStream) state.screenStream.getTracks().forEach((t) => answerStream.addTrack(t));
    call.answer(answerStream);

    const prev = state.answeredCalls.get(call.peer);
    if (prev && prev.open) { try { prev.close(); } catch (_) {} }
    state.answeredCalls.set(call.peer, call);

    call.on("stream", (remote) => addViewerFeed(call.peer, remote));
    call.on("close", () => {
      if (state.answeredCalls.get(call.peer) === call) state.answeredCalls.delete(call.peer);
      removeViewerFeed(call.peer);
    });

    // Late joiners get the webcam stream too, if it's already on
    if (state.ownerCamStream) sendHostCamTo(call.peer);
  });

  // Data connections for chat
  peer.on("connection", (conn) => {
    state.dataConns.set(conn.peer, conn);
    conn.on("data", (d) => {
      if (!d || typeof d !== "object") return;
      if (d.type === "hello" && d.name) {
        conn._viewerName = String(d.name).slice(0, 24) || "Guest";
        sysMsg(`${conn._viewerName} joined the room`);
      } else if (d.type === "chat" && d.text) {
        pushChat({ who: conn._viewerName || "Guest", text: String(d.text) });
      }
    });
    conn.on("close", () => {
      state.dataConns.delete(conn.peer);
      removeViewerFeed(conn.peer);
      const dead = state.answeredCalls.get(conn.peer);
      if (dead) { try { dead.close(); } catch (_) {} state.answeredCalls.delete(conn.peer); }
      const camDone = state.hostCamCalls.get(conn.peer);
      if (camDone) { try { camDone.close(); } catch (_) {} state.hostCamCalls.delete(conn.peer); }
      if (conn._viewerName) sysMsg(`${conn._viewerName} left`);
    });
  });
}

function broadcast(payload) {
  state.dataConns.forEach((c) => { if (c.open) { try { c.send(payload); } catch (_) {} } });
}

/* ---------- screen share ---------- */
$("shareBtn").addEventListener("click", startSharing);

async function startSharing() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    state.screenStream = stream;
    state.sharing = true;
    clearInterval(state.shareWatch);

    // main preview
    const v = $("mainVideo");
    v.srcObject = stream;
    v.muted = true;
    v.play().catch(() => {});

    // layered mic on top (talkover), separate from system audio
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      state.micTrack = mic.getAudioTracks()[0];
    } catch (_) { /* mic denied — system audio only */ }
    if (state.micTrack) stream.addTrack(state.micTrack);

    $("ownerWaiting").classList.add("hidden");
    $("shareBtn").classList.add("turned-on");
    $("shareBtn").title = "Screen sharing is on";
    startTimer();

    if (state.screenStream.getAudioTracks().length === 0) {
      toast("No system audio captured — when picking what to share, tick “Share audio”.", "warn");
    } else {
      toast("Sharing screen + audio. Mic button mutes your talkover mic.", "ok");
    }

    // Ask already-connected viewers to redial so they receive the new tracks
    broadcast({ type: "recall" });
    state.answeredCalls.forEach((call) => { try { call.close(); } catch (_) {} });
    state.answeredCalls.clear();

    // Protected-content detection: is the captured video actually black?
    watchForBlackCapture(v);

    stream.getVideoTracks()[0].addEventListener("ended", () => stopSharing());
    // safety net: some browsers don't fire 'ended' on the local track after stop()
    clearInterval(state.shareWatch);
    state.shareWatch = setInterval(() => {
      const t = state.screenStream && state.screenStream.getVideoTracks()[0];
      if (!t || t.readyState !== "live") stopSharing();
    }, 2000);
  } catch (err) {
    if (err && err.name !== "NotAllowedError") toast("Screen share failed: " + err.name, "warn");
  }
}

/* ----- DRM / overlay capture fix (the web-side equivalent of
   app.disableHardwareAcceleration(): we can't call it from a page, but we
   can detect the black-capture symptom and guide the host to the two real
   fixes — Entire-screen capture, or Chrome's software-rendering toggle. ----- */
function watchForBlackCapture(videoEl) {
  setTimeout(async () => {
    if (!state.sharing || !state.screenStream || !videoEl.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const grabAvg = () => {
      try {
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let sum = 0, n = 0;
        for (let p = 0; p < data.length; p += 40) { sum += data[p] + data[p + 1] + data[p + 2]; n += 3; }
        return { avg: sum / n, sig: Array.from(data.slice(0, 360)).join(",") };
      } catch (_) { return null; }
    };
    const a = grabAvg(); await new Promise(r => setTimeout(r, 350));
    const b = grabAvg(); await new Promise(r => setTimeout(r, 350));
    const c = grabAvg();
    if (!a || !b || !c) return;
    const allBlack = a.avg < 6 && b.avg < 6 && c.avg < 6;
    const frozen = a.sig === b.sig && b.sig === c.sig;
    if (allBlack || frozen) {
      toast("⚠️ The share looks black/frozen — protected content (Netflix, Prime…) is hidden from capture. Open “Streaming protected content?” for the fix.", "warn");
      $("protPanel").classList.remove("hidden");
    }
  }, 2500);
}

function stopSharing() {
  if (!state.sharing) return;
  state.sharing = false;
  clearInterval(state.shareWatch);
  if (state.screenStream) state.screenStream.getTracks().forEach((t) => t.stop());
  state.screenStream = null;
  state.micTrack = null;

  $("mainVideo").srcObject = null;
  $("shareBtn").classList.remove("turned-on");
  $("shareBtn").title = "Start screen sharing";
  $("ownerWaiting").classList.remove("hidden");

  broadcast({ type: "recall" });
  state.answeredCalls.forEach((call) => { try { call.close(); } catch (_) {} });
  state.answeredCalls.clear();
  toast("Screen sharing stopped");
}

/* ---------- owner webcam (host camera) ---------- */
$("camBtn").addEventListener("click", toggleOwnerCam);

async function toggleOwnerCam() {
  if (state.role !== "owner") return toggleViewerCam();
  if (!state.ownerCamStream) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 } } });
      state.ownerCamStream = stream;
      buildSelfThumb(stream.getVideoTracks()[0], "You");
      $("camBtn").classList.remove("turned-off");
      $("camBtn").classList.add("turned-on");
      $("camBtn").title = "Turn camera off";
      // deliver to every connected viewer
      const ids = new Set([...state.answeredCalls.keys(), ...state.dataConns.keys()]);
      ids.forEach(sendHostCamTo);
      broadcast({ type: "hostcam", on: true });
      toast("Camera on — everyone can now see you", "ok");
    } catch (_) {
      toast("Camera unavailable (permission denied or in use)", "warn");
    }
  } else {
    state.ownerCamStream.getTracks().forEach((t) => t.stop());
    state.ownerCamStream = null;
    state.hostCamCalls.forEach((call) => { try { call.close(); } catch (_) {} });
    state.hostCamCalls.clear();
    removeHostCamThumb("You");
    $("camBtn").classList.add("turned-off");
    $("camBtn").classList.remove("turned-on");
    $("camBtn").title = "Camera";
    broadcast({ type: "hostcam", on: false });
    toast("Camera off");
  }
}

function sendHostCamTo(viewerPeerId) {
  if (!state.ownerCamStream || !state.peer) return;
  const prev = state.hostCamCalls.get(viewerPeerId);
  if (prev && prev.open) { try { prev.close(); } catch (_) {} }
  try {
    const call = state.peer.call(viewerPeerId, state.ownerCamStream);
    state.hostCamCalls.set(viewerPeerId, call);
  } catch (_) {}
}

/* ---------- viewer feeds (owner side thumbnails) ---------- */
const viewerFeeds = new Map(); // peerId -> { thumbEl, videoEl, tracks }
function addViewerFeed(peerId, stream) {
  removeViewerFeed(peerId);
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = state.outMuted;
  video.srcObject = stream;
  thumb.appendChild(video);

  const tag = document.createElement("span");
  tag.className = "thumb-tag";
  tag.textContent = (state.dataConns.get(peerId) || {})._viewerName || "Guest";
  thumb.appendChild(tag);

  $("thumbStack").appendChild(thumb);
  $("thumbStack").classList.remove("hidden");
  viewerFeeds.set(peerId, { thumbEl: thumb, videoEl: video });
  startTimer();

  // If the guest's camera is (or becomes) off, drop the tile instead of
  // showing an empty black rectangle.
  const vTrack = stream.getVideoTracks()[0];
  if (!vTrack || vTrack.readyState === "ended") { removeViewerFeed(peerId); return; }
  const idleOrMuted = () => { if (vTrack.muted || !vTrack.enabled) removeViewerFeed(peerId); };
  const active = () => {
    if (vTrack.muted === false && vTrack.enabled) addViewerFeed(peerId, stream);
  };
  vTrack.addEventListener("mute", idleOrMuted);
  vTrack.addEventListener("unmute", () => { if (!viewerFeeds.has(peerId)) active(); });
  vTrack.addEventListener("ended", () => removeViewerFeed(peerId));
  if (vTrack.muted || !vTrack.enabled) removeViewerFeed(peerId);
}
function removeViewerFeed(peerId) {
  const f = viewerFeeds.get(peerId);
  if (!f) return;
  f.videoEl.srcObject = null;
  f.thumbEl.remove();
  viewerFeeds.delete(peerId);
  if (viewerFeeds.size === 0 && document.querySelectorAll(".thumb").length === 0) {
    $("thumbStack").classList.add("hidden");
  }
}

/* ============================================================
   OWNER-CAM FEED (viewer side) — host webcam picture-in-picture
   ============================================================ */
function addHostCamThumb(stream, label) {
  const existing = document.querySelectorAll(".thumb.hostcam").length;
  if (existing > 0) return;
  const thumb = document.createElement("div");
  thumb.className = "thumb hostcam";
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = false;
  video.srcObject = stream;
  thumb.appendChild(video);
  const tag = document.createElement("span");
  tag.className = "thumb-tag";
  tag.textContent = label;
  thumb.appendChild(tag);
  $("thumbStack").appendChild(thumb);
  $("thumbStack").classList.remove("hidden");
}
function removeHostCamThumb(label) {
  if (label) {
    document.querySelectorAll(".thumb.hostcam").forEach((el) => {
      const tag = el.querySelector(".thumb-tag");
      if (tag && tag.textContent === label) el.remove();
    });
  } else {
    document.querySelectorAll(".thumb.hostcam").forEach((el) => el.remove());
  }
  if (document.querySelectorAll(".thumb").length === 0) $("thumbStack").classList.add("hidden");
}

/* ============================================================
   VIEWER
   ============================================================ */
function wireViewerCallHandlers(peer) {
  // Host dialing us with their webcam (picture-in-picture)
  peer.on("call", (call) => {
    if (state.hostCamCall && state.hostCamCall.open) {
      try { state.hostCamCall.close(); } catch (_) {}
    }
    state.hostCamCall = call;
    call.answer(new MediaStream());
    call.on("stream", (remote) => {
      if (remote.getVideoTracks().length >= 0 && !remote.getVideoTracks().length) removeHostCamThumb();
      else addHostCamThumb(remote, "Host");
      const t = remote.getVideoTracks()[0];
      if (t) {
        const drop = () => removeHostCamThumb();
        t.addEventListener("ended", drop);
        t.addEventListener("mute", drop);
        t.addEventListener("unmute", () => addHostCamThumb(remote, "Host"));
        if (t.muted || !t.enabled) removeHostCamThumb();
      }
    });
    call.on("close", () => { if (state.hostCamCall === call) state.hostCamCall = null; removeHostCamThumb(); });
  });
}

$("joinBtn").addEventListener("click", () => joinRoom($("codeInput").value));
$("codeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !$("joinBtn").disabled) joinRoom($("codeInput").value);
});
$("createBtn").addEventListener("click", () => {
  state.name = ($("nameInput").value || "Host").trim();
  startPeer(genCode(), "owner");
});
$("cancelBtn").addEventListener("click", () => { teardown(); show("lobby"); });
$("codeInput").addEventListener("input", () => {
  const c = $("codeInput").value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  $("codeInput").value = c.length > 3 ? c.slice(0, 3) + "-" + c.slice(3) : c;
  $("joinBtn").disabled = c.length !== 6;
});

function joinRoom(rawCode) {
  const code = (rawCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) { toast("Enter the full 6-character code.", "warn"); return; }
  state.name = ($("nameInput").value || "Guest").trim();
  startPeer(code, "viewer");
}

function buildSelfThumb(track, label) {
  if (!track || track.readyState !== "live" || !track.enabled || track.muted) return null;
  const existing = document.querySelector(".thumb.self");
  if (existing) return existing;
  const thumb = document.createElement("div");
  thumb.className = "thumb self";
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true; // never echo your own mic/camera
  video.srcObject = new MediaStream([track]);
  thumb.appendChild(video);
  const tag = document.createElement("span");
  tag.className = "thumb-tag";
  tag.textContent = label || "You";
  thumb.appendChild(tag);
  $("thumbStack").appendChild(thumb);
  $("thumbStack").classList.remove("hidden");

  // no black boxes: hide/remove the tile whenever there is nothing to show
  const gone = () => removeSelfThumb();
  track.addEventListener("mute", gone);
  track.addEventListener("ended", gone);
  const back = () => { if (track.enabled && track.muted === false) buildSelfThumb(track, label); };
  track.addEventListener("unmute", back);
  return thumb;
}
function removeSelfThumb() {
  const el = document.querySelector(".thumb.self");
  if (el) el.remove();
  if (document.querySelectorAll(".thumb").length === 0) $("thumbStack").classList.add("hidden");
}

function wireViewerJoin() {
  // Microphone first, camera separately — a missing camera must never break
  // the join, and an off-camera guest simply gets no self-video tile.
  const grab = async () => {
    let micTrack = null, camTrack = null;
    try {
      micTrack = (await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })).getAudioTracks()[0];
    } catch (_) {}
    try {
      camTrack = (await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 } } })).getVideoTracks()[0];
    } catch (_) {}
    state.ownStream = new MediaStream();
    if (micTrack) state.ownStream.addTrack(micTrack);
    if (camTrack) {
      state.ownStream.addTrack(camTrack);
      buildSelfThumb(camTrack, "You");
    } else if (micTrack) {
      toast("No camera — you've joined audio-only (talk & listen works).", "warn");
    } else {
      toast("Joining without camera & mic — you'll still see/hear the host.");
    }
  };

  const dial = () => {
    if (!state.peer) { toast("Connection dropped — hit Join again", "warn"); return; }
    const call = state.peer.call("RoomCast-" + state.roomCode, state.ownStream, { metadata: { name: state.name } });
    state.call = call;
    call.on("stream", onHostStream);
    call.on("error", (e) => console.warn("[call] error", e));
    // ICE watchdog: if the media connection never completes, retry once
    const t0 = Date.now();
    let retries = 0;
    const guard = setInterval(() => {
      const pc = call.peerConnection;
      if (!pc) return;
      if (pc.connectionState === "connected") { clearInterval(guard); return; }
      if (Date.now() - t0 > 9000 && retries < 1) {
        clearInterval(guard); retries++;
        try { call.close(); } catch (_) {}
        redial();
      }
    }, 1200);
    call.on("close", () => {
      if (state.call === call) state.call = null;
      if (state.peer && !state.peer.destroyed && !$("room").classList.contains("hidden")) {
        $("receiving").classList.remove("hidden");
      }
    });
    return call;
  };

  state.dataConn = state.peer.connect("RoomCast-" + state.roomCode, { reliable: true });
  state.dataConn.on("open", () => state.dataConn.send({ type: "hello", name: state.name }));
  state.dataConn.on("data", (d) => {
    if (!d || typeof d !== "object") return;
    if (d.type === "chat") pushChat({ who: "Host", text: String(d.text) });
    else if (d.type === "sys") pushChat({ type: "sys", text: String(d.text) });
    else if (d.type === "recall") redial();
    else if (d.type === "hostcam" && !d.on) removeHostCamThumb();
  });
  state.dataConn.on("close", () => {
    if (!$("room").classList.contains("hidden")) roomEnded("The host closed the room.");
  });

  const redial = () => {
    if (state.call) { try { state.call.close(); } catch (_) {} state.call = null; }
    $("receiving").classList.remove("hidden");
    $("mainVideo").srcObject = null;
    dial();
  };

  grab().then(dial);
}

function onHostStream(remote) {
  $("receiving").classList.add("hidden");
  const v = $("mainVideo");
  v.srcObject = remote;
  v.muted = state.outMuted;
  v.volume = $("volumeSlider").value / 100;
  v.play().catch(() => {});
  startTimer();
  if (remote.getAudioTracks().length === 0) toast("Stream has no audio track.", "warn");
}

/* ============================================================
   VIEWER CAMERA TOGGLE (viewer), local only
   ============================================================ */
function toggleViewerCam() {
  const track = state.ownStream && state.ownStream.getVideoTracks()[0];
  if (!track) { toast("No camera in this session — see and hear the host without your webcam.", "warn"); return; }
  track.enabled = !track.enabled;
  $("camBtn").classList.toggle("turned-off", !track.enabled);
  if (track.enabled) buildSelfThumb(track, "You"); else removeSelfThumb();
  toast(track.enabled ? "Camera on" : "Camera off");
}

/* ============================================================
   ROOM ENTRY / HUD
   ============================================================ */
function enterRoomUI() {
  show("room");
  const isOwner = state.role === "owner";
  $("shareBtn").classList.toggle("hidden", !isOwner);
  $("roomCodeBig").textContent = formatCode(state.roomCode);
  $("receiving").classList.add("hidden");

  if (isOwner) {
    $("ownerWaiting").classList.remove("hidden");
    $("volumeDock").classList.remove("hidden"); // controls incoming guest audio
    toast("Room ready — share this code: " + formatCode(state.roomCode), "ok");
  } else {
    $("ownerWaiting").classList.add("hidden");
    $("volumeDock").classList.remove("hidden");
    $("receiving").classList.remove("hidden");
    wireViewerJoin();
  }
}

function startTimer() {
  if (state.timerInt) return;
  state.timerStart = Date.now();
  $("timer").textContent = "00:00:00";
  $("timer").classList.remove("hidden");
  state.timerInt = setInterval(() => {
    $("timer").textContent = fmtTime(Math.floor((Date.now() - state.timerStart) / 1000));
  }, 500);
}
function stopTimer() {
  clearInterval(state.timerInt);
  state.timerInt = null;
  $("timer").classList.add("hidden");
}

/* ---------- leave / teardown ---------- */
function roomEnded(title) {
  stopTimer();
  teardown();
  show("ended");
  $("endedTitle").textContent = title || "You left the room";
}

$("hangupBtn").addEventListener("click", () => {
  broadcast({ type: "sys", text: `${state.name} left the room` });
  roomEnded("You left the room");
});
$("rejoinBtn").addEventListener("click", () => {
  if (!state.rejoinCode) { show("lobby"); return; }
  const code = state.rejoinCode, role = state.role;
  setTimeout(() => startPeer(code, role), 60);
});
$("homeBtn").addEventListener("click", () => { state.rejoinCode = null; show("lobby"); });

$("copyCodeBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(formatCode(state.roomCode));
    toast("Code copied", "ok");
  } catch (_) { toast("Copy failed — grab it manually", "warn"); }
});

$("protHelpBtn").addEventListener("click", () => $("protPanel").classList.toggle("hidden"));

function teardown() {
  state.dataConns.forEach((c) => { try { c.close(); } catch (_) {} });
  state.dataConns.clear();
  if (state.dataConn) { try { state.dataConn.close(); } catch (_) {} state.dataConn = null; }
  [...state.answeredCalls.keys()].forEach(removeViewerFeed);
  state.answeredCalls.forEach((c) => { try { c.close(); } catch (_) {} });
  state.answeredCalls.clear();
  state.hostCamCalls.forEach((c) => { try { c.close(); } catch (_) {} });
  state.hostCamCalls.clear();
  if (state.hostCamCall) { try { state.hostCamCall.close(); } catch (_) {} state.hostCamCall = null; }
  if (state.call) { try { state.call.close(); } catch (_) {} state.call = null; }
  if (state.screenStream) state.screenStream.getTracks().forEach((t) => t.stop());
  state.screenStream = null;
  state.micTrack = null;
  if (state.ownerCamStream) state.ownerCamStream.getTracks().forEach((t) => t.stop());
  state.ownerCamStream = null;
  if (state.ownStream) state.ownStream.getTracks().forEach((t) => t.stop());
  state.ownStream = null;
  stopTimer();
  clearInterval(state.shareWatch);
  state.sharing = false;
  if (state.peer && !state.peer.destroyed) { try { state.peer.destroy(); } catch (_) {} }
  state.peer = null;
  document.exitFullscreen().catch(() => {});
  $("mainVideo").srcObject = null;
  $("chatLog").innerHTML = "";
  $("chatPanel").classList.add("hidden");
  $("thumbStack").innerHTML = "";
  $("thumbStack").classList.add("hidden");
  $("shareBtn").classList.remove("turned-on");
  $("micBtn").classList.remove("turned-off");
  $("camBtn").classList.remove("turned-off", "turned-on");
  $("camBtn").title = "Camera";
  $("stage").classList.remove("immersive");
  $("fsExitBtn").classList.add("hidden");
  $("fsTapHint").classList.add("hidden");
  document.documentElement.classList.remove("fs-on");
  state.outMuted = false;
  $("volumeSlider").value = 85;
  $("volIcon").innerHTML = VOL_ON;
  $("receiving").classList.add("hidden");
}

/* ============================================================
   CONTROLS
   ============================================================ */
const VOL_ON = '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8.5 8.5 0 0 1 0 12"/>';
const VOL_OFF = '<path d="M11 5 6 9H3v6h3l5 4z"/><line x1="16" y1="9" x2="22" y2="15"/><line x1="22" y1="9" x2="16" y2="15"/>';

// mic toggle (owner: talkover mic over the shared screen; viewer: outgoing mic)
$("micBtn").addEventListener("click", () => {
  const track =
    (state.role === "owner"
      ? state.screenStream && state.micTrack
      : state.ownStream && state.ownStream.getAudioTracks()[0]) || null;
  if (!track) { toast("No microphone to toggle" + (state.role === "owner" ? " — start sharing first" : ""), "warn"); return; }
  track.enabled = !track.enabled;
  $("micBtn").classList.toggle("turned-off", !track.enabled);
  toast(track.enabled ? "Microphone on" : "Microphone muted");
});

/* ---------- volume dock (both roles: incoming audio) ---------- */
function applyMuteState() {
  const muted = state.outMuted;
  $("volIcon").innerHTML = muted ? VOL_OFF : VOL_ON;
  if (state.role === "viewer") $("mainVideo").muted = muted;
  if (state.role === "owner") viewerFeeds.forEach((f) => (f.videoEl.muted = muted));
}
$("volumeSlider").addEventListener("input", (e) => {
  const vol = e.target.value / 100;
  if (state.role === "viewer") $("mainVideo").volume = vol;
  viewerFeeds.forEach((f) => (f.videoEl.volume = vol));
  state.outMuted = vol === 0;
  applyMuteState();
});
$("muteOutBtn").addEventListener("click", () => {
  state.outMuted = !state.outMuted;
  applyMuteState();
  toast(state.outMuted ? "Muted" : "Unmuted");
});

/* ============================================================
   FULLSCREEN (immersive) — completely borderless, button-free.
   One tap reveals the exit control; another tap on it leaves.
   ============================================================ */
$("fsBtn").addEventListener("click", () => {
  if (document.fullscreenElement) return;
  const el = $("stage");
  el.requestFullscreen().then(() => {
    el.classList.add("immersive");
    document.documentElement.classList.add("fs-on");
  }).catch(() => toast("Fullscreen blocked by the browser", "warn"));
});

// click anywhere in the immersive stage to reveal the exit button
$("stage").addEventListener("click", () => {
  if (!(document.fullscreenElement === $("stage"))) return;
  if (!$("stage").classList.contains("immersive")) return;
  if ($("fsExitBtn").classList.contains("hidden")) {
    $("fsExitBtn").classList.remove("hidden");
    $("fsTapHint").classList.remove("hidden");
    clearTimeout(state.fsHintTimer);
    state.fsHintTimer = setTimeout(() => {
      $("fsExitBtn").classList.add("hidden");
      $("fsTapHint").classList.add("hidden");
    }, 4000);
  }
});

$("fsExitBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  document.exitFullscreen().catch(() => {});
});

document.addEventListener("fullscreenchange", () => {
  const active = document.fullscreenElement === $("stage");
  $("stage").classList.toggle("immersive", active);
  document.documentElement.classList.toggle("fs-on", active);
  $("fsExitBtn").classList.add("hidden");
  $("fsTapHint").classList.add("hidden");
});

/* ============================================================
   CHAT
   ============================================================ */
$("chatBtn").addEventListener("click", () => {
  const p = $("chatPanel");
  p.classList.toggle("hidden");
  if (!p.classList.contains("hidden")) $("chatInput").focus();
});
$("chatCloseBtn").addEventListener("click", () => $("chatPanel").classList.add("hidden"));

function pushChat(m) {
  const log = $("chatLog");
  const el = document.createElement("div");
  if (m.type === "sys") {
    el.className = "sys";
    el.textContent = m.text;
  } else {
    el.className = "chat-msg" + (m.me ? " me" : "");
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = m.who || "";
    const txt = document.createElement("div");
    txt.className = "txt";
    txt.textContent = m.text;
    el.append(who, txt);
  }
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}
function sysMsg(text) { pushChat({ type: "sys", text }); }

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  pushChat({ who: state.name, text, me: true });
  const payload = { type: "chat", text: text.slice(0, 300) };
  if (state.role === "owner") broadcast(payload);
  else if (state.dataConn && state.dataConn.open) { try { state.dataConn.send(payload); } catch (_) {} }
  else toast("No one to chat with yet", "warn");
});

/* ============================================================
   BOOT
   ============================================================ */
if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
  toast("⚠️ This browser can't share screens — use desktop Chrome/Edge/Brave.", "warn");
}
window.addEventListener("beforeunload", () => { try { teardown(); } catch (_) {} });

// exposed for debugging in devtools / automated tests
window.__roomcastState = state;

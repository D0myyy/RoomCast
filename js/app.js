/* ============================================================
   RoomCast — WebRTC screen sharing with audio, PeerJS signaling
   Owner: creates a room, shares screen(+system audio & mic) to viewers.
   Viewer: joins with a code, can send camera+mic back (two-way talk).
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
  setTimeout(() => el.remove(), 4200);
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
  screenStream: null,       // owner outgoing screen (+screen audio + mic)
  micTrack: null,
  answeredCalls: new Map(), // owner: peerId -> media call
  ownStream: null,          // viewer outgoing cam+mic
  call: null,               // viewer: media call to host
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

  peer.on("open", () => { console.log("[peer] open", peer.id); enterRoomUI(); });
  peer.on("disconnected", () => { console.log("[peer] disconnected, reconnecting"); try { peer.reconnect(); } catch (_) {} });
  peer.on("error", (err) => {
    console.error("[peer] error:", err.type, err);
    teardown();
    if (err.type === "unavailable-id") {
      show("lobby");
      toast("That code is already in use — generating a new one…", "warn");
      if (role === "owner") state.rejoinCode = null, setTimeout(() => startPeer(genCode(), "owner"), 400);
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
}

/* ============================================================
   OWNER
   ============================================================ */
function wireOwnerHandlers(peer) {
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
  });

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

/* ---------- viewer feeds (owner side thumbnails) ---------- */
const viewerFeeds = new Map(); // peerId -> { thumbEl, videoEl }
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
}
function removeViewerFeed(peerId) {
  const f = viewerFeeds.get(peerId);
  if (!f) return;
  f.videoEl.srcObject = null;
  f.thumbEl.remove();
  viewerFeeds.delete(peerId);
  if (viewerFeeds.size === 0) $("thumbStack").classList.add("hidden");
}

/* ============================================================
   VIEWER
   ============================================================ */
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

function buildSelfThumb() {
  const track = state.ownStream && state.ownStream.getVideoTracks()[0];
  if (!track) return;
  const thumb = document.createElement("div");
  thumb.className = "thumb self";
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true; // never play own audio
  video.srcObject = state.ownStream;
  thumb.appendChild(video);
  const tag = document.createElement("span");
  tag.className = "thumb-tag";
  tag.textContent = "You";
  thumb.appendChild(tag);
  $("thumbStack").appendChild(thumb);
  $("thumbStack").classList.remove("hidden");
}

function wireViewerJoin() {
  // Grab local media BEFORE dialing so tracks are in the initial offer (muteable live)
  const grab = async () => {
    try {
      state.ownStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (_) {
      try {
        state.ownStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        toast("Camera unavailable — joining with mic only", "warn");
      } catch (_2) {
        state.ownStream = new MediaStream();
        toast("Joining without camera & mic — you'll still see/hear the host");
      }
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
      if (state.peer && !state.peer.destroyed && $("room") && !$("room").classList.contains("hidden")) {
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
  });
  state.dataConn.on("close", () => {
    console.log("[viewer] dataConn closed");
    if (!$("room").classList.contains("hidden")) roomEnded("The host closed the room.");
  });

  const redial = () => {
    if (state.call) { try { state.call.close(); } catch (_) {} state.call = null; }
    $("receiving").classList.remove("hidden");
    $("mainVideo").srcObject = null;
    dial();
  };

  grab().then(() => {
    buildSelfThumb();
    dial();
  });
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
   ROOM ENTRY / HUD
   ============================================================ */
function enterRoomUI() {
  show("room");
  const isOwner = state.role === "owner";
  $("shareBtn").classList.toggle("hidden", !isOwner);
  $("camBtn").classList.toggle("hidden", isOwner);
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

function teardown() {
  state.dataConns.forEach((c) => { try { c.close(); } catch (_) {} });
  state.dataConns.clear();
  if (state.dataConn) { try { state.dataConn.close(); } catch (_) {} state.dataConn = null; }
  [...state.answeredCalls.keys()].forEach(removeViewerFeed);
  state.answeredCalls.forEach((c) => { try { c.close(); } catch (_) {} });
  state.answeredCalls.clear();
  if (state.call) { try { state.call.close(); } catch (_) {} state.call = null; }
  if (state.screenStream) state.screenStream.getTracks().forEach((t) => t.stop());
  state.screenStream = null;
  state.micTrack = null;
  if (state.ownStream) state.ownStream.getTracks().forEach((t) => t.stop());
  state.ownStream = null;
  stopTimer();
  clearInterval(state.shareWatch);
  state.sharing = false;
  if (state.peer && !state.peer.destroyed) { try { state.peer.destroy(); } catch (_) {} }
  state.peer = null;
  $("mainVideo").srcObject = null;
  $("chatLog").innerHTML = "";
  $("chatPanel").classList.add("hidden");
  $("thumbStack").innerHTML = "";
  $("thumbStack").classList.add("hidden");
  $("shareBtn").classList.remove("turned-on");
  $("micBtn").classList.remove("turned-off");
  $("camBtn").classList.remove("turned-off");
  selfVolEl = null;
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
let selfVolEl = null; // viewer's self thumb video (kept muted)

// mic toggle
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

// camera toggle (viewer)
$("camBtn").addEventListener("click", () => {
  const track = state.ownStream && state.ownStream.getVideoTracks()[0];
  if (!track) { toast("You joined without a camera — permissions blocked it", "warn"); return; }
  track.enabled = !track.enabled;
  $("camBtn").classList.toggle("turned-off", !track.enabled);
});

// volume dock
function applyMuteState() {
  const muted = state.outMuted;
  $("volIcon").innerHTML = muted ? VOL_OFF : VOL_ON;
  if (state.role === "viewer") $("mainVideo").muted = muted;
  viewerFeeds.forEach((f) => (f.videoEl.muted = muted));
}
$("volumeSlider").addEventListener("input", (e) => {
  const vol = e.target.value / 100;
  if (state.role === "viewer") { $("mainVideo").volume = vol; }
  viewerFeeds.forEach((f) => (f.videoEl.volume = vol));
  if (vol === 0) { state.outMuted = true; } else { state.outMuted = false; if (selfVolEl) selfVolEl.muted = true; }
  applyMuteState();
});
$("muteOutBtn").addEventListener("click", () => {
  state.outMuted = !state.outMuted;
  applyMuteState();
  toast(state.outMuted ? "Muted" : "Unmuted");
});

// fullscreen on double click
$("stage").addEventListener("dblclick", () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else $("stage").requestFullscreen().catch(() => {});
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
window.addEventListener("beforeunload", teardown);
// self thumb ring styling helper (viewer keeps own audio silent)
new MutationObserver(() => {
  const t = document.querySelector(".thumb.self video");
  selfVolEl = t || null;
}).observe($("thumbStack"), { childList: true });

// ━━━━━━━━━━━━━━ STATE ━━━━━━━━━━━━━━
let token = localStorage.getItem("cn_token") || null;
let myUsername = localStorage.getItem("cn_user") || null;
let myLang = localStorage.getItem("cn_lang") || "en";
let partnerLang = "en";
let partnerName = "Stranger";
let partnerId = null;
let currentRoom = null;
let pc = null, localStream = null, myRole = null;
let typingTimeout = null;
let selectedReason = null;
let socket = null;
let autoTranslate = true;

// ━━━━━━━━━━━━━━ DOM SHORTCUTS ━━━━━━━━━━━━━━
const $ = id => document.getElementById(id);

// ━━━━━━━━━━━━━━ TOAST ━━━━━━━━━━━━━━
function showToast(msg, type = "info") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `show ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.className = "", 3000);
}

// ━━━━━━━━━━━━━━ AUTH TAB ━━━━━━━━━━━━━━
function switchTab(tab) {
  $("loginForm").style.display = tab === "login" ? "block" : "none";
  $("registerForm").style.display = tab === "register" ? "block" : "none";
  $("loginTab").classList.toggle("active", tab === "login");
  $("registerTab").classList.toggle("active", tab === "register");
  $("auth-error").textContent = "";
}

function setAuthError(msg) {
  $("auth-error").textContent = msg;
}

async function login() {
  const username = $("loginUsername").value.trim();
  const password = $("loginPassword").value;
  if (!username || !password) return setAuthError("Please fill all fields");

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) return setAuthError(data.error || "Login failed");
    storeSession(data);
    enterApp();
  } catch (e) {
    setAuthError("Network error. Try again.");
  }
}

async function register() {
  const username = $("regUsername").value.trim();
  const password = $("regPassword").value;
  const language = $("regLang").value;
  if (!username || !password) return setAuthError("Please fill all fields");

  try {
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, language })
    });
    const data = await res.json();
    if (!res.ok) return setAuthError(data.error || "Registration failed");
    storeSession(data);
    enterApp();
  } catch (e) {
    setAuthError("Network error. Try again.");
  }
}

async function guestLogin() {
  try {
    const res = await fetch("/api/guest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "en" })
    });
    const data = await res.json();
    storeSession(data);
    enterApp();
  } catch (e) {
    setAuthError("Network error. Try again.");
  }
}

function storeSession({ token: t, username, language }) {
  token = t; myUsername = username; myLang = language || "en";
  localStorage.setItem("cn_token", t);
  localStorage.setItem("cn_user", username);
  localStorage.setItem("cn_lang", myLang);
}

function logout() {
  localStorage.removeItem("cn_token");
  localStorage.removeItem("cn_user");
  localStorage.removeItem("cn_lang");
  token = null; myUsername = null;
  if (socket) { socket.disconnect(); socket = null; }
  leaveRoom(true);
  $("app-page").classList.remove("visible");
  $("auth-page").style.display = "flex";
}

function enterApp() {
  $("auth-page").style.display = "none";
  $("app-page").classList.add("visible");
  $("headerUsername").textContent = myUsername;
  $("myLangDisplay").textContent = "🌐 " + myLang;
  initSocket();
}

// ━━━━━━━━━━━━━━ AUTO-LOGIN CHECK ━━━━━━━━━━━━━━
window.addEventListener("DOMContentLoaded", () => {
  if (token && myUsername) {
    enterApp();
  }
  // Enter key on auth
  document.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      const loginVisible = $("loginForm").style.display !== "none";
      if ($("auth-page").style.display !== "none") {
        loginVisible ? login() : register();
      }
    }
  });

  $("translateToggle").addEventListener("change", (e) => {
    autoTranslate = e.target.checked;
    showToast(autoTranslate ? "Auto-translate ON 🌐" : "Auto-translate OFF", "info");
  });
});

// ━━━━━━━━━━━━━━ SOCKET ━━━━━━━━━━━━━━
function initSocket() {
  if (socket) return;
  socket = io({ autoConnect: false, auth: { token } });

  socket.on("connect_error", (err) => {
    showToast("Connection error: " + err.message, "error");
  });

  socket.on("waiting", () => {
    setStatus("Waiting for a partner…", "waiting");
  });

  socket.on("matched", async ({ room, role, partner, partnerName: pName, partnerLang: pLang }) => {
    currentRoom = room; myRole = role; partnerId = partner;
    partnerName = pName || "Stranger";
    partnerLang = pLang || "en";

    $("remoteLabel").textContent = partnerName;
    showPartnerInfo();
    createPC();

    if (myRole === "caller") {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("signal", { to: partnerId, data: { type: "offer", sdp: offer } });
    }

    $("leaveBtn").disabled = false;
    $("reportBtn").disabled = false;
    $("msgInput").disabled = false;
    setStatus(`In call with ${partnerName}`, "connected");
    showToast(`Connected with ${partnerName} 🎉`, "success");
    addSystemMsg(`You're now chatting with ${partnerName} (${partnerLang})`);
  });

  socket.on("signal", async ({ from, data }) => {
    if (!pc && localStream) createPC();
    if (data.type === "offer" && myRole === "callee") {
      partnerId = from;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("signal", { to: partnerId, data: { type: "answer", sdp: answer } });
      setStatus(`In call with ${partnerName}`, "connected");
    } else if (data.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === "ice") {
      try { await pc.addIceCandidate(data.candidate); } catch (e) {}
    }
  });

  socket.on("partner_left", () => {
    showToast(`${partnerName} disconnected`, "error");
    addSystemMsg(`${partnerName} left the chat.`);
    leaveRoom(false);
    setStatus("Partner left. Click 'Find Partner' again", "");
  });

  socket.on("receive_message", async ({ text, senderName }) => {
    if (autoTranslate && partnerLang !== myLang) {
      const translated = await translateText(text, partnerLang, myLang);
      addMessage("partner", translated, translated !== text ? text : null);
    } else {
      addMessage("partner", text);
    }
  });

  socket.on("typing", () => showTyping());
  socket.on("stop_typing", () => removeTyping());
}

// ━━━━━━━━━━━━━━ MEDIA ━━━━━━━━━━━━━━
async function getMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    $("local").srcObject = localStream;
    return true;
  } catch (e) {
    showToast("Camera/mic required: " + e.message, "error");
    return false;
  }
}

function createPC() {
  pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  pc.onicecandidate = (e) => {
    if (e.candidate && partnerId) {
      socket.emit("signal", { to: partnerId, data: { type: "ice", candidate: e.candidate } });
    }
  };
  pc.ontrack = (e) => { $("remote").srcObject = e.streams[0]; };
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
}

// ━━━━━━━━━━━━━━ CHAT CONTROLS ━━━━━━━━━━━━━━
async function startChat() {
  $("startBtn").disabled = true;
  setStatus("Getting camera…", "");
  if (!localStream && !(await getMedia())) {
    $("startBtn").disabled = false; return;
  }
  setStatus("Connecting…", "waiting");
  socket.connect();
  socket.emit("join");
}

function leaveRoom(stopMedia = false) {
  if (pc) { pc.close(); pc = null; }
  if (stopMedia && localStream) {
    localStream.getTracks().forEach(t => t.stop());
    $("local").srcObject = null;
    localStream = null;
  }
  if (currentRoom) { socket?.emit("leave", currentRoom); currentRoom = null; }
  partnerId = null; partnerName = "Stranger";
  $("remote").srcObject = null;
  $("leaveBtn").disabled = true;
  $("reportBtn").disabled = true;
  $("msgInput").disabled = true;
  $("startBtn").disabled = false;
  $("partner-info").classList.remove("visible");
  setStatus("Left the call", "");
}

function toggleMute() {
  if (!localStream) return;
  const mic = localStream.getAudioTracks()[0];
  mic.enabled = !mic.enabled;
  $("muteBtn").textContent = mic.enabled ? "🎤 Mute" : "🔇 Unmute";
  $("muteBtn").classList.toggle("active", !mic.enabled);
}

function toggleCamera() {
  if (!localStream) return;
  const cam = localStream.getVideoTracks()[0];
  cam.enabled = !cam.enabled;
  $("cameraBtn").textContent = cam.enabled ? "📷 Camera" : "📷 No Cam";
  $("cameraBtn").classList.toggle("active", !cam.enabled);
}

function sendMessage() {
  const text = $("msgInput").value.trim();
  if (!text || !currentRoom) return;
  socket.emit("send_message", { text, roomId: currentRoom });
  addMessage("me", text);
  $("msgInput").value = "";
}

$("msgInput")?.addEventListener("keypress", (e) => {
  if (e.key === "Enter") { sendMessage(); return; }
  socket?.emit("typing", { roomId: currentRoom });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket?.emit("stop_typing", { roomId: currentRoom }), 1000);
});

// ━━━━━━━━━━━━━━ STATUS ━━━━━━━━━━━━━━
function setStatus(msg, type) {
  $("status-text").textContent = msg;
  const dot = $("statusDot");
  dot.className = "status-dot" + (type ? " " + type : "");
}

function showPartnerInfo() {
  $("partner-info").classList.add("visible");
  $("partnerLangBadge").textContent = partnerLang;
}

// ━━━━━━━━━━━━━━ MESSAGES ━━━━━━━━━━━━━━
function addMessage(type, text, original = null) {
  removeTyping();
  const div = document.createElement("div");
  div.className = "message " + type;
  div.textContent = text;
  if (original) {
    const orig = document.createElement("div");
    orig.className = "original";
    orig.textContent = "Original: " + original;
    div.appendChild(orig);
  }
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
}

function addSystemMsg(text) {
  const div = document.createElement("div");
  div.className = "system-msg";
  div.textContent = text;
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
}

function showTyping() {
  if (document.getElementById("typing-indicator")) return;
  const div = document.createElement("div");
  div.id = "typing-indicator";
  div.className = "typing-indicator";
  div.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
}

function removeTyping() {
  const el = document.getElementById("typing-indicator");
  if (el) el.remove();
}

// ━━━━━━━━━━━━━━ TRANSLATION ━━━━━━━━━━━━━━
async function translateText(text, from, to) {
  if (!text || from === to) return text;
  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, from, to })
    });
    const data = await res.json();
    return data.translated || text;
  } catch (e) {
    return text;
  }
}

// ━━━━━━━━━━━━━━ REPORT ━━━━━━━━━━━━━━
function openReport() {
  if (!partnerId) return;
  selectedReason = null;
  document.querySelectorAll(".reason-btn").forEach(b => b.classList.remove("selected"));
  $("reportDetails").value = "";
  $("reportModal").classList.add("open");
}

function closeReport() {
  $("reportModal").classList.remove("open");
}

function selectReason(btn) {
  document.querySelectorAll(".reason-btn").forEach(b => b.classList.remove("selected"));
  btn.classList.add("selected");
  selectedReason = btn.dataset.reason;
}

async function submitReport() {
  if (!selectedReason) {
    showToast("Please select a reason", "error");
    return;
  }

  try {
    const res = await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reporterToken: token,
        reportedUsername: partnerName,
        reason: selectedReason,
        details: $("reportDetails").value.trim()
      })
    });
    const data = await res.json();
    if (res.ok) {
      closeReport();
      showToast("Report submitted. Thank you! ✅", "success");
      leaveRoom(false);
    } else {
      showToast(data.error || "Failed to submit", "error");
    }
  } catch (e) {
    showToast("Network error", "error");
  }
}

// Close modal on overlay click
$("reportModal")?.addEventListener("click", (e) => {
  if (e.target === $("reportModal")) closeReport();
});

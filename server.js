const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- In-Memory Stores (replace with DB in production) ----
const users = new Map();       // token → { username, language, joinedAt }
const reports = [];            // array of report objects
const bannedUsers = new Set(); // banned socket IDs / usernames

let waiting = null;

// ---- Auth Endpoints ----
app.post("/api/register", (req, res) => {
  const { username, password, language } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (username.length < 3) return res.status(400).json({ error: "Username too short (min 3 chars)" });

  // Check duplicate
  for (const [, u] of users) {
    if (u.username === username) return res.status(409).json({ error: "Username taken" });
  }

  const token = crypto.randomBytes(32).toString("hex");
  users.set(token, { username, password: crypto.createHash("sha256").update(password).digest("hex"), language: language || "en", joinedAt: Date.now() });
  res.json({ token, username, language: language || "en" });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const hash = crypto.createHash("sha256").update(password || "").digest("hex");
  for (const [token, u] of users) {
    if (u.username === username && u.password === hash) {
      return res.json({ token, username, language: u.language });
    }
  }
  res.status(401).json({ error: "Invalid credentials" });
});

app.post("/api/guest", (req, res) => {
  const { language } = req.body;
  const token = "guest_" + crypto.randomBytes(16).toString("hex");
  const username = "Guest_" + Math.floor(Math.random() * 9999);
  users.set(token, { username, password: null, language: language || "en", joinedAt: Date.now(), isGuest: true });
  res.json({ token, username, language: language || "en" });
});

// ---- Translation Proxy (MyMemory - free, no key needed) ----
app.post("/api/translate", async (req, res) => {
  const { text, from, to } = req.body;
  if (!text || !to) return res.status(400).json({ error: "text and to are required" });
  if (from === to) return res.json({ translated: text });

  try {
    const fetch = (await import("node-fetch")).default;
    const langPair = `${from || "autodetect"}|${to}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    const translated = data.responseData?.translatedText || text;
    res.json({ translated });
  } catch (e) {
    // Fallback: return original text if translation fails
    res.json({ translated: text, error: "Translation service unavailable" });
  }
});

// ---- Report Endpoint ----
app.post("/api/report", (req, res) => {
  const { reporterToken, reportedUsername, reason, details } = req.body;
  const reporter = users.get(reporterToken);
  if (!reporter) return res.status(401).json({ error: "Unauthorized" });

  const report = {
    id: reports.length + 1,
    reporter: reporter.username,
    reportedUsername,
    reason, // "nudity" | "abusive" | "spam" | "other"
    details: details || "",
    createdAt: new Date().toISOString(),
    status: "pending"
  };
  reports.push(report);

  console.log(`🚨 Report #${report.id}: ${reporter.username} reported ${reportedUsername} for "${reason}"`);

  // Auto-ban after 3 reports for nudity
  const nudityReports = reports.filter(r => r.reportedUsername === reportedUsername && r.reason === "nudity");
  if (nudityReports.length >= 3) {
    bannedUsers.add(reportedUsername);
    console.log(`🚫 Auto-banned ${reportedUsername} after ${nudityReports.length} nudity reports`);
  }

  res.json({ success: true, reportId: report.id });
});

// ---- Admin Reports (simple token check) ----
app.get("/api/admin/reports", (req, res) => {
  const { key } = req.query;
  if (key !== (process.env.ADMIN_KEY || "admin123")) return res.status(403).json({ error: "Forbidden" });
  res.json({ reports, bannedUsers: Array.from(bannedUsers) });
});

// ---- Socket.IO ----
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  const user = users.get(token);
  if (!user) return next(new Error("Unauthorized"));
  if (bannedUsers.has(user.username)) return next(new Error("Banned"));
  socket.user = user;
  socket.token = token;
  next();
});

io.on("connection", (socket) => {
  console.log(`🟢 ${socket.user.username} connected (${socket.id})`);

  socket.on("join", () => {
    if (waiting === null) {
      waiting = socket;
      socket.emit("waiting");
    } else {
      const a = waiting;
      const b = socket;
      waiting = null;

      if (!a.connected) {
        waiting = b;
        b.emit("waiting");
        return;
      }

      const room = a.id + "#" + b.id;
      a.join(room); b.join(room);

      a.emit("matched", { room, role: "caller", partner: b.id, partnerName: b.user.username, partnerLang: b.user.language });
      b.emit("matched", { room, role: "callee", partner: a.id, partnerName: a.user.username, partnerLang: a.user.language });
    }
  });

  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("send_message", ({ text, roomId }) => {
    if (!text || !roomId) return;
    socket.to(roomId).emit("receive_message", {
      from: socket.id,
      senderName: socket.user.username,
      text,
      createdAt: new Date().toISOString()
    });
  });

  socket.on("typing", ({ roomId }) => {
    if (roomId) socket.to(roomId).emit("typing");
  });

  socket.on("stop_typing", ({ roomId }) => {
    if (roomId) socket.to(roomId).emit("stop_typing");
  });

  socket.on("leave", (roomId) => {
    if (roomId) {
      socket.leave(roomId);
      socket.to(roomId).emit("partner_left");
    }
    if (waiting === socket) waiting = null;
  });

  socket.on("disconnect", () => {
    console.log(`🔴 ${socket.user.username} disconnected`);
    if (waiting === socket) waiting = null;
    socket.rooms.forEach((room) => {
      if (room !== socket.id) socket.to(room).emit("partner_left");
    });
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

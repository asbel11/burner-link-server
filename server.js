// Simple in-memory Burner Link backend with 2-device limit per session
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
// Allow larger JSON bodies to support base64 images
app.use(express.json({ limit: "5mb" }));

app.get("/", (req, res) => {
  res.send("🔥 Burner Link API is live");
});

// sessions[sessionId] = {
//   code: string,
//   active: boolean,
//   messages: Array<{
//     id: string,
//     senderId: string,
//     type: "text" | "image",
//     encrypted: { ciphertext: string, nonce: string },
//     fileName?: string | null,
//   }>,
//   participants: Set<string>,
//   expiresAt: number | null
// }
const sessions = {};

// devices[deviceId] = { isPro: boolean, dailyImageCount: number, lastResetAt: number }
const devices = {};

function getOrCreateDevice(deviceId) {
  if (!devices[deviceId]) {
    devices[deviceId] = {
      isPro: false, // MVP: everyone is free tier by default
      dailyImageCount: 0,
      lastResetAt: Date.now(),
    };
  }
  const info = devices[deviceId];
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;

  // Reset daily image count once per day
  if (now - info.lastResetAt > ONE_DAY) {
    info.dailyImageCount = 0;
    info.lastResetAt = now;
  }

  return info;
}

function isSessionExpired(session) {
  if (!session.expiresAt) return false;
  return Date.now() > session.expiresAt;
}

// Helper to create a random id
function createId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

// ---------- Session routes ----------

// Create a new session from a 6-digit code
app.post("/sessions/create", (req, res) => {
  const { code, deviceId } = req.body;

  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Missing or invalid code" });
  }
  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "Missing or invalid deviceId" });
  }

  const deviceInfo = getOrCreateDevice(deviceId);
  const sessionId = createId();

  sessions[sessionId] = {
    code,
    active: true,
    messages: [],
    // creator is first participant
    participants: new Set([deviceId]),
    // Free-tier sessions expire after 10 minutes; Pro sessions have no expiry
    expiresAt: deviceInfo.isPro ? null : Date.now() + 10 * 60 * 1000,
  };

  console.log("Created session", sessionId, "for code", code, "by", deviceId);
  res.json({ id: sessionId });
});

// Join an existing active session by code
app.post("/sessions/join", (req, res) => {
  const { code, deviceId } = req.body;

  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Missing or invalid code" });
  }
  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "Missing or invalid deviceId" });
  }

  const deviceInfo = getOrCreateDevice(deviceId);

  const entry = Object.entries(sessions).find(
    ([, sess]) => sess.code === code && sess.active
  );

  if (!entry) {
    return res.status(404).json({ error: "Session not found or inactive" });
  }

  const [sessionId, session] = entry;

  // If session has expired, burn it and deny join
  if (isSessionExpired(session)) {
    session.active = false;
    session.messages = [];
    session.participants = new Set();
    return res.status(404).json({ error: "Session not found or inactive" });
  }

  // If this device is already a participant, just let it reconnect
  if (!session.participants.has(deviceId)) {
    // Enforce max 2 unique devices
    if (session.participants.size >= 2) {
      return res
        .status(403)
        .json({ error: "Session already has two devices connected." });
    }
    session.participants.add(deviceId);
  }

  console.log("Joined session", sessionId, "with code", code, "by", deviceId);
  res.json({ id: sessionId });
});

// End a session and burn its data
app.post("/sessions/end", (req, res) => {
  const { sessionId } = req.body;

  const session = sessions[sessionId];
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  session.active = false;
  session.messages = []; // burn all messages
  session.participants = new Set(); // clear participants

  console.log("Ended session", sessionId);

  res.json({ ok: true });
});

// ---------- Message routes ----------

// Get all messages for a session
app.get("/messages/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  const session = sessions[sessionId];

  if (session && isSessionExpired(session)) {
    session.active = false;
    session.messages = [];
    session.participants = new Set();
  }

  if (!session || !session.active) {
    return res.status(404).json({ error: "Session not found or inactive" });
  }

  res.json(session.messages);
});

// Post a new message (text or image)
app.post("/messages", (req, res) => {
  const { sessionId, senderId, encrypted, type, fileName } = req.body;

  const session = sessions[sessionId];

  if (session && isSessionExpired(session)) {
    session.active = false;
    session.messages = [];
    session.participants = new Set();
  }

  if (!session || !session.active) {
    return res.status(404).json({ error: "Session not found or inactive" });
  }

  if (!encrypted || !encrypted.ciphertext) {
    return res.status(400).json({ error: "Missing encrypted payload" });
  }

  const deviceInfo = senderId ? getOrCreateDevice(senderId) : null;

  // Enforce free-tier daily image limit (5 images per device per day)
  if (type === "image" && deviceInfo && !deviceInfo.isPro) {
    if (deviceInfo.dailyImageCount >= 5) {
      return res.status(403).json({ error: "image_limit_reached" });
    }
    deviceInfo.dailyImageCount += 1;
  }

  const id = createId();

  const msg = {
    id,
    senderId: senderId || "unknown",
    type: type === "image" ? "image" : "text",
    encrypted,
    fileName: fileName || null,
  };

  session.messages.push(msg);

  console.log("New message in session", sessionId, ":", msg.type, "id", id);

  res.json(msg);
});

// ---------- Start server ----------

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`🔥 Burner Link server running at http://localhost:${PORT}`);
});
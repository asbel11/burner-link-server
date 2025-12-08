// Simple in-memory Burner Link backend with 2-device limit per session
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
// Allow larger JSON bodies to support base64 images
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

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
// }
const sessions = {};

// If one device hasn't checked in for this long, we treat the session as ended (ms)
const OFFLINE_TIMEOUT_MS = 20000; // 20 seconds

// Simple in-memory metrics (reset when server restarts)
const metrics = {
  cameraClicks: 0,
  sessionsCreated: 0,
  devices: new Set(), // unique deviceIds we've seen
};

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
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "Code must be a 6-digit number" });
  }
  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "Missing or invalid deviceId" });
  }

  metrics.sessionsCreated += 1;
  metrics.devices.add(deviceId);

  const sessionId = createId();

  sessions[sessionId] = {
    code,
    active: true,
    messages: [],
    // creator is first participant
    participants: new Set([deviceId]),
    lastSeen: { [deviceId]: Date.now() },
  };

  console.log("Created session", sessionId, "for code", code, "by", deviceId);
  return res.status(201).json({ id: sessionId });
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

  metrics.devices.add(deviceId);

  const entry = Object.entries(sessions).find(
    ([, sess]) => sess.code === code && sess.active
  );

  if (!entry) {
    return res.status(404).json({ error: "Session not found or inactive" });
  }

  const [sessionId, session] = entry;

  // If this device is already a participant, just let it reconnect
  if (!session.participants.has(deviceId)) {
    // Enforce max 2 unique devices
    if (session.participants.size >= 2) {
      return res
        .status(403)
        .json({ error: "Session already has two devices connected." });
    }
    session.participants.add(deviceId);
    if (!session.lastSeen) {
      session.lastSeen = {};
    }
    session.lastSeen[deviceId] = Date.now();
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

// Check basic status of a session (used so the first device can auto-join chat
// when the second device connects).
app.get("/sessions/status/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions[sessionId];

    if (!session) {
      return res.status(404).json({ active: false, participants: 0 });
    }

    const participants =
      session.participants && typeof session.participants.size === "number"
        ? session.participants.size
        : 0;

    return res.json({
      active: !!session.active,
      participants,
    });
  } catch (err) {
    console.error("Error in /sessions/status:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Heartbeat route so each device can signal it is still connected. If the other
// device has not checked in for OFFLINE_TIMEOUT_MS, we mark the session as ended.
app.post("/sessions/heartbeat", (req, res) => {
  try {
    const { sessionId, deviceId } = req.body || {};
    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({ error: "Missing or invalid sessionId" });
    }
    if (!deviceId || typeof deviceId !== "string") {
      return res.status(400).json({ error: "Missing or invalid deviceId" });
    }

    const session = sessions[sessionId];
    if (!session || !session.active) {
      return res.status(404).json({ error: "Session not found or inactive" });
    }

    if (!session.participants) {
      session.participants = new Set();
    }
    session.participants.add(deviceId);

    if (!session.lastSeen) {
      session.lastSeen = {};
    }
    const now = Date.now();
    session.lastSeen[deviceId] = now;

    // If there are at least two participants, check whether the other one
    // has gone offline for too long. If so, end the session.
    const entries = Object.entries(session.lastSeen);
    if (entries.length >= 2) {
      const stale = entries.find(
        ([id, ts]) => id !== deviceId && now - ts > OFFLINE_TIMEOUT_MS
      );
      if (stale) {
        session.active = false;
        session.messages = [];
        session.participants = new Set();
        return res.json({ ok: true, ended: true });
      }
    }

    return res.json({ ok: true, ended: false });
  } catch (err) {
    console.error("Error in /sessions/heartbeat:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Message routes ----------

// Get all messages for a session
app.get("/messages/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  const session = sessions[sessionId];

  if (!session || !session.active) {
    return res.status(404).json({ error: "Session not found or inactive" });
  }

  res.json(session.messages);
});

// Post a new message (text or image)
app.post("/messages", (req, res) => {
  const { sessionId, senderId, encrypted, type, fileName } = req.body;

  const session = sessions[sessionId];

  if (!session || !session.active) {
    return res.status(404).json({ error: "Session not found or inactive" });
  }

  if (
    !encrypted ||
    typeof encrypted !== "object" ||
    !encrypted.ciphertext ||
    !encrypted.nonce
  ) {
    return res.status(400).json({ error: "Missing encrypted payload" });
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

  return res.status(201).json({
    id: msg.id,
    senderId: msg.senderId,
    type: msg.type,
    encrypted: msg.encrypted,
    fileName: msg.fileName,
  });
});

// ---------- Metrics routes ----------

// Record that a user tapped the camera icon in the app
app.post("/metrics/camera-click", (req, res) => {
  try {
    const { deviceId } = req.body || {};
    metrics.cameraClicks += 1;
    if (deviceId && typeof deviceId === "string") {
      metrics.devices.add(deviceId);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error in /metrics/camera-click:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Get basic stats about usage
app.get("/metrics/stats", (req, res) => {
  try {
    const activeSessions = Object.values(sessions).filter(
      (s) => s && s.active
    ).length;

    return res.json({
      cameraClicks: metrics.cameraClicks,
      sessionsCreated: metrics.sessionsCreated,
      activeSessions,
      approximateUsers: metrics.devices.size,
    });
  } catch (err) {
    console.error("Error in /metrics/stats:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Start server ----------

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`🔥 Burner Link server running at http://localhost:${PORT}`);
});

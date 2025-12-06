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

  const sessionId = createId();

  sessions[sessionId] = {
    code,
    active: true,
    messages: [],
    // creator is first participant
    participants: new Set([deviceId]),
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

// ---------- Start server ----------

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`🔥 Burner Link server running at http://localhost:${PORT}`);
});

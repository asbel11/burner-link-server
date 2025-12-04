// index.js
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Test route: to check server is alive
app.get("/", (req, res) => {
  res.send("🔥 Burner Link API is live");
});

// Example: generate a burner code
app.post("/generate-code", (req, res) => {
  // 6-digit random code
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  // Later we’ll save this in DB, attach expiry, etc.
  res.json({ code });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🔥 Burner Link server running on port ${PORT}`);
});
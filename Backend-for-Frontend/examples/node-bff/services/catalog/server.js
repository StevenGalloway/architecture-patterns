const express = require("express");
const app = express();

app.get("/profile", (req, res) => {
  res.json({
    id: "u-123",
    name: "Demo User",
    email: "demo@example.com",
    tier: "gold",
    request_id: req.header("x-request-id") || null
  });
});

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.listen(3001, () => console.log("Profile service on 3001"));

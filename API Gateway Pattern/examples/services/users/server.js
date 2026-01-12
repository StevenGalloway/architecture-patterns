const express = require("express");
const app = express();

app.get("/me", (req, res) => {
  res.json({
    id: "u-123",
    name: "Demo User",
    tenant: req.header("x-tenant-id") || "unknown",
    request_id: req.header("x-request-id") || null
  });
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.listen(3001, () => console.log("Users service on 3001"));

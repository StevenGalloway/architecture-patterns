
const express = require("express");
const app = express();
app.use(express.json());

// Simple in-memory subscribers (SSE)
const subscribers = new Set();

app.post("/publish", (req, res) => {
  const evt = req.body;
  if (!evt || !evt.event_id || !evt.type) {
    return res.status(400).json({ error: "event_id and type required" });
  }

  for (const sub of subscribers) {
    sub.write(`data: ${JSON.stringify(evt)}\n\n`);
  }
  return res.json({ ok: true, delivered_to: subscribers.size });
});

app.get("/subscribe", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  subscribers.add(res);

  req.on("close", () => {
    subscribers.delete(res);
  });
});

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.listen(4000, () => console.log("Event bus mock on 4000"));

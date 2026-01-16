const express = require("express");
const app = express();

let slow = false;

app.get("/toggle", (req, res) => {
  slow = (req.query.slow === "true");
  res.json({ slow });
});

app.get("/recs", async (req, res) => {
  const limit = Number(req.query.limit || "5");
  if (slow) await new Promise(r => setTimeout(r, 1200)); // simulate slowness

  const items = Array.from({ length: limit }).map((_, i) => ({
    id: `r${i + 1}`,
    title: `Recommended Item ${i + 1}`,
    score: Math.round(Math.random() * 100)
  }));

  res.json({
    items,
    request_id: req.header("x-request-id") || null
  });
});

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.listen(3003, () => console.log("Recs service on 3003"));

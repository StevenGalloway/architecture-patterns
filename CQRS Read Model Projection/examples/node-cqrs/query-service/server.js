
const express = require("express");

const READ_STORE_URL = process.env.READ_STORE_URL || "http://localhost:3002";
const app = express();

app.get("/orders/:id", async (req, res) => {
  const resp = await fetch(`${READ_STORE_URL}/read/orders/${req.params.id}`);
  if (resp.status === 404) return res.status(404).json({ error: "Not found (projection may be behind)" });
  if (!resp.ok) return res.status(502).json({ error: "Read store error" });
  return res.json(await resp.json());
});

app.get("/users/:id/orders", async (req, res) => {
  const resp = await fetch(`${READ_STORE_URL}/read/users/${req.params.id}/orders`);
  if (!resp.ok) return res.status(502).json({ error: "Read store error" });
  return res.json(await resp.json());
});

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.listen(3003, () => console.log("Query service on 3003"));

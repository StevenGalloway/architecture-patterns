
const express = require("express");
const { v4: uuidv4 } = require("uuid");

const BUS_URL = process.env.BUS_URL || "http://localhost:4000";

const app = express();
app.use(express.json());

// In-memory write store (normalized)
const orders = new Map();

function validateOrder(o) {
  if (!o || !o.order_id || !o.user_id) throw new Error("order_id and user_id required");
  if (typeof o.total !== "number") throw new Error("total must be a number");
  if (o.total < 0) throw new Error("total must be >= 0");
}

app.post("/orders", async (req, res) => {
  const body = req.body;
  try {
    validateOrder(body);

    // Write-side invariant: order_id must be unique
    if (orders.has(body.order_id)) {
      return res.status(409).json({ error: "Order already exists" });
    }

    // Persist to write store
    orders.set(body.order_id, { ...body, created_at: new Date().toISOString() });

    // Emit event
    const evt = {
      event_id: uuidv4(),
      type: "OrderCreated",
      version: 1,
      occurred_at: new Date().toISOString(),
      payload: orders.get(body.order_id)
    };

    const resp = await fetch(`${BUS_URL}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt)
    });

    if (!resp.ok) return res.status(502).json({ error: "Failed to publish event" });

    // 202 Accepted signals eventual consistency for read models
    return res.status(202).json({ ok: true, event_id: evt.event_id });
  } catch (e) {
    return res.status(400).json({ error: String(e) });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.listen(3001, () => console.log("Command service on 3001"));

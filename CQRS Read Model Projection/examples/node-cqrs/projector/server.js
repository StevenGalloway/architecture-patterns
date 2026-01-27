
const express = require("express");

const BUS_URL = process.env.BUS_URL || "http://localhost:4000";
const app = express();

// In-memory read models (denormalized)
// orders_by_id: direct lookup
const ordersById = new Map();
// orders_by_user: optimized for "list my orders"
const ordersByUser = new Map();

// Dedupe store for idempotency
const processedEventIds = new Set();

function applyOrderCreated(evt) {
  const o = evt.payload;

  // Read model v1: flattened order view
  const readRow = {
    order_id: o.order_id,
    user_id: o.user_id,
    total: o.total,
    created_at: o.created_at,
    status: "CREATED"
  };

  ordersById.set(o.order_id, readRow);

  if (!ordersByUser.has(o.user_id)) ordersByUser.set(o.user_id, []);
  const arr = ordersByUser.get(o.user_id);

  // Ensure idempotent append: if exists, replace
  const idx = arr.findIndex(x => x.order_id === o.order_id);
  if (idx >= 0) arr[idx] = readRow;
  else arr.push(readRow);
}

// Subscribe to bus via SSE
async function startSubscription() {
  const resp = await fetch(`${BUS_URL}/subscribe`);
  if (!resp.ok) throw new Error("Failed to subscribe to bus");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE events separated by blank line
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      // Expect lines like: data: {...}
      const dataLine = chunk.split("\n").find(l => l.startsWith("data: "));
      if (!dataLine) continue;

      const jsonStr = dataLine.slice("data: ".length);
      try {
        const evt = JSON.parse(jsonStr);

        // Idempotency check
        if (processedEventIds.has(evt.event_id)) continue;
        processedEventIds.add(evt.event_id);

        if (evt.type === "OrderCreated") applyOrderCreated(evt);
      } catch {
        // ignore malformed event
      }
    }
  }
}

// Start subscription in background
startSubscription().catch(err => console.error("Projector subscription error:", err));

// Expose read store endpoints (for demo)
app.get("/read/orders/:id", (req, res) => {
  const row = ordersById.get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  return res.json(row);
});

app.get("/read/users/:id/orders", (req, res) => {
  return res.json({ items: ordersByUser.get(req.params.id) || [] });
});

app.get("/read/metrics", (req, res) => {
  return res.json({
    processed_events: processedEventIds.size,
    orders_indexed: ordersById.size
  });
});

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.listen(3002, () => console.log("Projector on 3002"));

const express = require("express");
const app = express();

app.get("/list", (req, res) => {
  res.json({
    orders: [
      { id: "o-1", item: "Coffee", status: "SHIPPED" },
      { id: "o-2", item: "Headphones", status: "PROCESSING" }
    ],
    tenant: req.header("x-tenant-id") || "unknown",
    request_id: req.header("x-request-id") || null
  });
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.listen(3002, () => console.log("Orders service on 3002"));

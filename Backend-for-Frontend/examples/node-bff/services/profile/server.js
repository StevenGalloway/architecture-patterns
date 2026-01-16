const express = require("express");
const app = express();

app.get("/featured", (req, res) => {
  res.json({
    items: [
      { id: "p1", title: "Noise-canceling Headphones", price: 199.99, tags: ["audio", "travel"] },
      { id: "p2", title: "Espresso Machine", price: 349.0, tags: ["kitchen"] },
      { id: "p3", title: "Smartwatch", price: 149.5, tags: ["fitness"] }
    ],
    request_id: req.header("x-request-id") || null
  });
});

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.listen(3002, () => console.log("Catalog service on 3002"));

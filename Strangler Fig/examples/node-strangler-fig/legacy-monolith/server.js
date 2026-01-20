
const express = require("express");
const app = express();
app.use(express.json());

app.get("/legacy/ping", (req, res) => res.json({ ok: true, system: "legacy" }));

// Legacy billing endpoint (to be strangled)
app.post("/billing/pay", (req, res) => {
  const amount = req.body?.amount;
  res.json({
    system: "legacy",
    action: "pay",
    amount,
    message: "Legacy billing processed payment"
  });
});

app.listen(3001, () => console.log("Legacy monolith on 3001"));

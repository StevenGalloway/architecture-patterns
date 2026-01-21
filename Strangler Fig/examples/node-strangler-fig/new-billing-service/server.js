
const express = require("express");
const app = express();
app.use(express.json());

app.post("/billing/pay", (req, res) => {
  const amount = req.body?.amount;
  res.json({
    system: "new-billing",
    action: "pay",
    amount,
    message: "New Billing Service processed payment",
    improvements: ["structured logging", "idempotency-ready", "modern CI/CD"]
  });
});

app.listen(3002, () => console.log("New billing service on 3002"));

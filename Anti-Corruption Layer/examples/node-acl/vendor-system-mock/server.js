
const express = require("express");
const app = express();

// Simulate a vendor "weird" DTO
// - field names differ
// - enums encoded as letters
// - timestamps as epoch millis
// - nested contact object (optional)
app.get("/vendor/customer", (req, res) => {
  const id = req.query.id || "0";

  // Create some “quirky” variations
  const code = (Number(id) % 3 === 0) ? "S" : (Number(id) % 2 === 0) ? "I" : "A";
  const includeEmail = Number(id) % 2 === 1;

  res.json({
    customer_id: String(id),
    full_name: `Customer ${id}`,
    state_code: code,                // A/I/S
    createdOn: Date.now() - 86400000, // epoch millis
    vendorRef: `VEND-${id}`,
    contact: includeEmail ? { email: `customer${id}@vendor.example` } : null
  });
});

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.listen(3002, () => console.log("Vendor mock on 3002"));


const express = require("express");

const ACL_URL = process.env.ACL_URL || "http://localhost:3001";
const app = express();

app.get("/customers/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const resp = await fetch(`${ACL_URL}/customers/${id}`);
    if (!resp.ok) return res.status(502).json({ error: "Bad upstream (ACL)" });
    const customer = await resp.json(); // CanonicalCustomer
    return res.json({
      source: "core-domain",
      customer,
      note: "Core domain only speaks CanonicalCustomer (no vendor DTO leakage)."
    });
  } catch (e) {
    return res.status(500).json({ error: "Core error", details: String(e) });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.listen(3000, () => console.log("Core domain service on 3000"));

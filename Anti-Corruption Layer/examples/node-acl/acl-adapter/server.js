
const express = require("express");

const VENDOR_URL = process.env.VENDOR_URL || "http://localhost:3002";
const ACL_TIMEOUT_MS = Number(process.env.ACL_TIMEOUT_MS || "500");

const app = express();

function withTimeout(ms, fn) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fn(ctrl.signal).finally(() => clearTimeout(t));
}

/**
 * Vendor DTO -> CanonicalCustomer mapping
 * CanonicalCustomer:
 *  - id: string
 *  - name: string
 *  - status: "ACTIVE" | "INACTIVE" | "SUSPENDED"
 *  - email?: string
 *  - created_at: ISO string
 *  - vendor_ref: string (original vendor id for traceability)
 */
function mapVendorToCanonical(v) {
  // Vendor quirks:
  // - customer_id is numeric string
  // - full_name may be LAST, FIRST
  // - state_code uses "A" | "I" | "S"
  // - createdOn is epoch millis
  const statusMap = { A: "ACTIVE", I: "INACTIVE", S: "SUSPENDED" };

  const id = String(v.customer_id);
  const name = String(v.full_name || "").trim();
  const status = statusMap[v.state_code] || "INACTIVE";

  const created_at = new Date(Number(v.createdOn)).toISOString();

  // Email might be nested or missing
  const email = v.contact && typeof v.contact.email === "string" ? v.contact.email : undefined;

  const canonical = {
    id,
    name,
    status,
    created_at,
    vendor_ref: String(v.vendorRef || v.customer_id)
  };

  if (email) canonical.email = email;

  // Minimal boundary validation
  if (!canonical.id || !canonical.name || !canonical.created_at) {
    throw new Error("Mapping validation failed: missing required canonical fields");
  }

  return canonical;
}

app.get("/customers/:id", async (req, res) => {
  const id = req.params.id;

  try {
    const vendorResp = await withTimeout(ACL_TIMEOUT_MS, (signal) =>
      fetch(`${VENDOR_URL}/vendor/customer?id=${encodeURIComponent(id)}`, { signal })
    );

    if (!vendorResp.ok) {
      return res.status(502).json({ error: "Bad upstream (vendor)" });
    }

    const vendorDto = await vendorResp.json();

    // Translate to canonical model
    const canonical = mapVendorToCanonical(vendorDto);

    return res.json(canonical);
  } catch (e) {
    const msg = String(e);
    const timeout = msg.includes("AbortError");
    return res.status(timeout ? 504 : 500).json({
      error: timeout ? "ACL timeout calling vendor" : "ACL error",
      details: msg
    });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.listen(3001, () => console.log("ACL adapter on 3001"));

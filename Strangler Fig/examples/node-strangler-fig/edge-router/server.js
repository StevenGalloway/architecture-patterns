
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const LEGACY_URL = process.env.LEGACY_URL || "http://localhost:3001";
const BILLING_URL = process.env.BILLING_URL || "http://localhost:3002";
const CANARY_PERCENT = Number(process.env.CANARY_PERCENT || "0"); // demo canary for billing

const app = express();
app.use(express.json());

function shouldRouteToNew() {
  // Demo: random percentage. Production: tenant/header-based routing + SLO gates.
  return Math.random() * 100 < CANARY_PERCENT;
}

app.use("/billing", (req, res, next) => {
  const target = shouldRouteToNew() ? BILLING_URL : LEGACY_URL;

  return createProxyMiddleware({
    target,
    changeOrigin: true,
    onProxyReq: (proxyReq) => {
      proxyReq.setHeader("x-router-target", target);
    }
  })(req, res, next);
});

// Everything else defaults to legacy
app.use("/", createProxyMiddleware({
  target: LEGACY_URL,
  changeOrigin: true
}));

app.listen(8080, () => {
  console.log(`Edge router on 8080. Legacy=${LEGACY_URL}, Billing=${BILLING_URL}, Canary%=${CANARY_PERCENT}`);
});

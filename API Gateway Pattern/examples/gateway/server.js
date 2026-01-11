const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { v4: uuidv4 } = require("uuid");

// Use native fetch in modern Node if available; fall back if needed.
// const fetch = globalThis.fetch || require("node-fetch");

const USERS_URL = process.env.USERS_URL || "http://localhost:3001";
const ORDERS_URL = process.env.ORDERS_URL || "http://localhost:3002";
const RATE_LIMIT_RPS = Number(process.env.RATE_LIMIT_RPS || "5");

const app = express();
app.use(express.json());

/**
 * Middleware: Request ID + basic trace header propagation
 */
app.use((req, res, next) => {
  const requestId = req.header("x-request-id") || uuidv4();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  // Very lightweight "trace" placeholder; in real systems use W3C traceparent.
  const traceParent = req.header("traceparent") || `00-${requestId.replace(/-/g, "")}0000000000000000-0000000000000000-01`;
  req.traceParent = traceParent;
  res.setHeader("traceparent", traceParent);

  next();
});

/**
 * Middleware: Demo JWT validation
 * - Accepts "Authorization: Bearer demo"
 * - In real systems validate signature, iss/aud/exp, etc.
 */
app.use((req, res, next) => {
  const auth = req.header("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;

  if (!token || token !== "demo") {
    console.log(JSON.stringify({
      level: "warn",
      msg: "Unauthorized",
      request_id: req.requestId,
      path: req.path
    }));
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Demo identity claims
  req.tenantId = req.header("x-tenant-id") || "tenant-demo";
  req.clientId = req.header("x-client-id") || "client-demo";
  next();
});

/**
 * Middleware: Token bucket rate limiting (in-memory demo)
 * Keyed by tenant + client.
 * For distributed systems, replace with Redis.
 */
const buckets = new Map();

function nowMs() {
  return Date.now();
}

function getBucketKey(req) {
  return `${req.tenantId}:${req.clientId}`;
}

app.use((req, res, next) => {
  const key = getBucketKey(req);
  const capacity = RATE_LIMIT_RPS;        // allow short bursts up to RPS
  const refillPerSec = RATE_LIMIT_RPS;

  const t = nowMs();
  const b = buckets.get(key) || { tokens: capacity, lastRefill: t };

  const elapsedSec = (t - b.lastRefill) / 1000;
  const refill = elapsedSec * refillPerSec;

  b.tokens = Math.min(capacity, b.tokens + refill);
  b.lastRefill = t;

  if (b.tokens < 1) {
    console.log(JSON.stringify({
      level: "info",
      msg: "Throttled",
      request_id: req.requestId,
      key,
      path: req.path
    }));
    res.setHeader("Retry-After", "1");
    return res.status(429).json({ error: "Too Many Requests" });
  }

  b.tokens -= 1;
  buckets.set(key, b);
  next();
});

/**
 * Lightweight aggregation endpoint (use sparingly)
 * Calls both upstreams and returns combined response.
 */
app.get("/api/summary", async (req, res) => {
  const start = Date.now();
  try {
    const headers = {
      "x-request-id": req.requestId,
      "traceparent": req.traceParent,
      "x-tenant-id": req.tenantId,
      "x-client-id": req.clientId
    };

    const [userResp, ordersResp] = await Promise.all([
      fetch(`${USERS_URL}/me`, { headers }),
      fetch(`${ORDERS_URL}/list`, { headers })
    ]);

    if (!userResp.ok) return res.status(502).json({ error: "Bad upstream (users)" });
    if (!ordersResp.ok) return res.status(502).json({ error: "Bad upstream (orders)" });

    const user = await userResp.json();
    const orders = await ordersResp.json();

    console.log(JSON.stringify({
      level: "info",
      msg: "Aggregated summary",
      request_id: req.requestId,
      latency_ms: Date.now() - start
    }));

    return res.json({ user, orders });
  } catch (e) {
    console.log(JSON.stringify({
      level: "error",
      msg: "Aggregation failed",
      request_id: req.requestId,
      err: String(e)
    }));
    return res.status(500).json({ error: "Gateway error" });
  }
});

/**
 * Proxy routes to upstream services
 */
app.use(
  "/api/users",
  createProxyMiddleware({
    target: USERS_URL,
    changeOrigin: true,
    pathRewrite: { "^/api/users": "" },
    onProxyReq: (proxyReq, req) => {
      proxyReq.setHeader("x-request-id", req.requestId);
      proxyReq.setHeader("traceparent", req.traceParent);
      proxyReq.setHeader("x-tenant-id", req.tenantId);
      proxyReq.setHeader("x-client-id", req.clientId);
    }
  })
);

app.use(
  "/api/orders",
  createProxyMiddleware({
    target: ORDERS_URL,
    changeOrigin: true,
    pathRewrite: { "^/api/orders": "" },
    onProxyReq: (proxyReq, req) => {
      proxyReq.setHeader("x-request-id", req.requestId);
      proxyReq.setHeader("traceparent", req.traceParent);
      proxyReq.setHeader("x-tenant-id", req.tenantId);
      proxyReq.setHeader("x-client-id", req.clientId);
    }
  })
);

/**
 * Health endpoint
 */
app.get("/healthz", (req, res) => res.json({ ok: true }));

const port = 8080;
app.listen(port, () => console.log(`Gateway listening on ${port}`));

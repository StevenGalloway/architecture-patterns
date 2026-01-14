const express = require("express");
const { v4: uuidv4 } = require("uuid");

const PROFILE_URL = process.env.PROFILE_URL || "http://localhost:3001";
const CATALOG_URL = process.env.CATALOG_URL || "http://localhost:3002";
const RECS_URL = process.env.RECS_URL || "http://localhost:3003";

const app = express();

function withTimeout(ms, promise) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return promise(ctrl.signal).finally(() => clearTimeout(t));
}

app.use((req, res, next) => {
  const requestId = req.header("x-request-id") || uuidv4();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
});

app.get("/mobile/home", async (req, res) => {
  const headers = { "x-request-id": req.requestId };

  try {
    const profileP = fetch(`${PROFILE_URL}/profile`, { headers });
    const featuredP = fetch(`${CATALOG_URL}/featured`, { headers });

    // Mobile is sensitive to latency: stricter timeout for recs
    const recsP = withTimeout(250, (signal) =>
      fetch(`${RECS_URL}/recs?limit=5`, { headers, signal })
    );

    const [profileResp, featuredResp] = await Promise.all([profileP, featuredP]);

    if (!profileResp.ok) return res.status(502).json({ error: "Bad upstream: profile" });
    if (!featuredResp.ok) return res.status(502).json({ error: "Bad upstream: catalog" });

    const profile = await profileResp.json();
    const featured = await featuredResp.json();

    let recs = { items: [] };
    let partial = false;

    try {
      const recsResp = await recsP;
      if (recsResp.ok) recs = await recsResp.json();
      else partial = true;
    } catch {
      partial = true; // timeout / abort
    }

    // Mobile-shaped payload: minimal fields
    return res.json({
      request_id: req.requestId,
      partial,
      user: { id: profile.id, name: profile.name },
      featured: featured.items.map(i => ({ id: i.id, title: i.title })),
      recs: recs.items.map(i => ({ id: i.id, title: i.title }))
    });
  } catch (e) {
    return res.status(500).json({ error: "Mobile BFF error", request_id: req.requestId });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.listen(8081, () => console.log("Mobile BFF on 8081"));

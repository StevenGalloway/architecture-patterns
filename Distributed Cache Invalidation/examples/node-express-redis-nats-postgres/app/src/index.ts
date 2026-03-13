import express from "express";
import { connect, StringCodec } from "nats";
import { createClient } from "redis";
import pg from "pg";

const { Pool } = pg;

const INSTANCE = process.env.INSTANCE_NAME ?? "api";
const PORT = Number(process.env.PORT ?? "9600");

const APP_ENV = process.env.APP_ENV ?? "dev";
const TENANT = process.env.TENANT ?? "public";
const KEY_VERSION = process.env.KEY_VERSION ?? "v1";

const REDIS_URL = process.env.REDIS_URL ?? "redis://redis:6379/0";
const NATS_URL = process.env.NATS_URL ?? "nats://nats:4222";
const DB_DSN = process.env.DB_DSN ?? "postgresql://postgres:postgres@db:5432/appdb";

// L1 cache TTL (short): keeps hot reads fast per-instance
const L1_TTL_MS = Number(process.env.L1_TTL_MS ?? "2000");
// L2 cache TTL (longer): shared across instances
const L2_TTL_SECONDS = Number(process.env.L2_TTL_SECONDS ?? "30");

type CacheEntry = { value: string; expiresAt: number };

function key(entity: string, id: string) {
  return `${APP_ENV}:${TENANT}:${KEY_VERSION}:${entity}:${id}`;
}

const l1 = new Map<string, CacheEntry>();

function l1Get(k: string): string | null {
  const e = l1.get(k);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    l1.delete(k);
    return null;
  }
  return e.value;
}

function l1Set(k: string, v: string) {
  l1.set(k, { value: v, expiresAt: Date.now() + L1_TTL_MS });
}

function l1Evict(k: string) {
  l1.delete(k);
}

// Redis client
const redis = createClient({ url: REDIS_URL });
redis.on("error", (err) => console.error(`[${INSTANCE}] redis error`, err));

// DB pool
const pool = new Pool({ connectionString: DB_DSN });

// NATS
const sc = StringCodec();
const INVALIDATE_SUBJECT = "cache.invalidate";

async function main() {
  await redis.connect();

  const nc = await connect({ servers: NATS_URL });
  console.log(`[${INSTANCE}] connected to NATS ${NATS_URL}`);

  // Subscribe for invalidation events
  const sub = nc.subscribe(INVALIDATE_SUBJECT);
  (async () => {
    for await (const msg of sub) {
      try {
        const payload = JSON.parse(sc.decode(msg.data)) as { keys: string[]; reason?: string; ts?: string };
        for (const k of payload.keys) {
          // idempotent: delete even if absent
          l1Evict(k);
          await redis.del(k);
        }
        console.log(`[${INSTANCE}] invalidated ${payload.keys.length} keys (reason=${payload.reason ?? "n/a"})`);
      } catch (e) {
        console.error(`[${INSTANCE}] invalidation handler error`, e);
      }
    }
  })();

  // Ensure table exists (demo convenience; in production migrations handle this)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id INT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const app = express();

  app.get("/health", (_req, res) => res.json({ ok: true, instance: INSTANCE }));

  // GET with L1/L2 cache-aside
  app.get("/items/:id", async (req, res) => {
    const id = req.params.id;
    const k = key("item", id);

    const v1 = l1Get(k);
    if (v1) {
      res.setHeader("X-Cache", "L1-HIT");
      res.setHeader("X-Instance", INSTANCE);
      return res.json({ id: Number(id), value: v1, source: "l1", instance: INSTANCE });
    }

    try {
      const v2 = await redis.get(k);
      if (v2) {
        l1Set(k, v2);
        res.setHeader("X-Cache", "L2-HIT");
        res.setHeader("X-Instance", INSTANCE);
        return res.json({ id: Number(id), value: v2, source: "l2", instance: INSTANCE });
      }
    } catch (e) {
      console.warn(`[${INSTANCE}] redis get failed (continuing to DB)`, e);
    }

    // Origin read
    const row = await pool.query("SELECT id, value, updated_at FROM items WHERE id=$1", [Number(id)]);
    if (row.rowCount === 0) {
      res.setHeader("X-Cache", "MISS");
      res.setHeader("X-Instance", INSTANCE);
      return res.status(404).json({ ok: false, error: "not_found", id: Number(id), instance: INSTANCE });
    }

    const value = row.rows[0].value as string;

    // Populate caches
    l1Set(k, value);
    try {
      await redis.setEx(k, L2_TTL_SECONDS, value);
    } catch (e) {
      console.warn(`[${INSTANCE}] redis set failed`, e);
    }

    res.setHeader("X-Cache", "MISS");
    res.setHeader("X-Instance", INSTANCE);
    return res.json({ id: Number(id), value, source: "db", instance: INSTANCE });
  });

  // PUT updates origin then publishes invalidation for all nodes
  app.put("/items/:id", async (req, res) => {
    const id = req.params.id;
    const value = String(req.query.value ?? "");

    if (!value) {
      return res.status(400).json({ ok: false, error: "missing_value_query_param", hint: "PUT /items/:id?value=..." });
    }

    await pool.query(
      `INSERT INTO items (id, value) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET value=excluded.value, updated_at=now()`,
      [Number(id), value]
    );

    const k = key("item", id);

    // Publish invalidation (fan-out)
    const evt = { keys: [k], reason: "write", ts: new Date().toISOString(), by: INSTANCE };
    nc.publish(INVALIDATE_SUBJECT, sc.encode(JSON.stringify(evt)));

    // Local eviction also (best effort)
    l1Evict(k);
    try {
      await redis.del(k);
    } catch (e) {
      console.warn(`[${INSTANCE}] redis del failed`, e);
    }

    res.setHeader("X-Instance", INSTANCE);
    return res.json({ ok: true, id: Number(id), value, invalidated: [k], published: true, instance: INSTANCE });
  });

  // Status (for demos)
  app.get("/status", async (_req, res) => {
    const l1Keys = [...l1.keys()];
    res.json({
      instance: INSTANCE,
      l1_keys: l1Keys,
      l1_size: l1Keys.length,
      l1_ttl_ms: L1_TTL_MS,
      l2_ttl_seconds: L2_TTL_SECONDS,
      nats_subject: INVALIDATE_SUBJECT,
    });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[${INSTANCE}] listening on :${PORT}`);
  });
}

main().catch((e) => {
  console.error(`[${INSTANCE}] fatal`, e);
  process.exit(1);
});

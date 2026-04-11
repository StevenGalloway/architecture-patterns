import express, { Request, Response } from 'express';
import { createClient } from 'redis';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Flag } from './targeting-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
await redis.connect();

// SSE clients — all connected SDK instances
const sseClients = new Set<Response>();

// ── Flag storage helpers ───────────────────────────────────────────────────

const FLAGS_KEY = 'flags';
const AUDIT_STREAM = 'audit_log';

async function getFlag(key: string): Promise<Flag | null> {
  const raw = await redis.hGet(FLAGS_KEY, key);
  return raw ? JSON.parse(raw) : null;
}

async function getAllFlags(): Promise<Flag[]> {
  const all = await redis.hGetAll(FLAGS_KEY);
  return Object.values(all).map(v => JSON.parse(v));
}

async function setFlag(key: string, flag: Flag, actor: string, before: Flag | null): Promise<void> {
  await redis.hSet(FLAGS_KEY, key, JSON.stringify(flag));
  // Append to immutable audit stream
  await redis.xAdd(AUDIT_STREAM, '*', {
    timestamp: new Date().toISOString(),
    actor,
    operation: before ? 'UPDATE' : 'CREATE',
    flagKey: key,
    before: before ? JSON.stringify(before) : '',
    after: JSON.stringify(flag),
  });
  // Push SSE update to all connected SDK instances
  const payload = `event: flag:updated\ndata: ${JSON.stringify(flag)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
  console.log(`[MGMT] Flag updated: ${key} — notified ${sseClients.size} SSE clients`);
}

// ── Routes ─────────────────────────────────────────────────────────────────

// GET /flags — return all flags (SDK seed)
app.get('/flags', async (_req: Request, res: Response) => {
  const flags = await getAllFlags();
  res.json(flags);
});

// GET /flags/stream — SSE endpoint for SDK connections
// Note: this route must be registered before /flags/:key
app.get('/flags/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  console.log(`[MGMT] SSE client connected (total: ${sseClients.size})`);

  // Send a heartbeat comment every 15s to keep the connection alive
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log(`[MGMT] SSE client disconnected (total: ${sseClients.size})`);
  });
});

// GET /flags/:key — return a single flag
app.get('/flags/:key', async (req: Request, res: Response) => {
  const flag = await getFlag(req.params.key);
  if (!flag) {
    res.status(404).json({ error: 'Flag not found' });
    return;
  }
  res.json(flag);
});

// PUT /flags/:key — update a flag (triggers SSE push to all SDK instances)
app.put('/flags/:key', async (req: Request, res: Response) => {
  const existing = await getFlag(req.params.key);
  if (!existing) {
    res.status(404).json({ error: 'Flag not found. Use POST /flags/seed to create initial flags.' });
    return;
  }
  const updated: Flag = { ...existing, ...req.body, key: req.params.key };
  const actor = (req.headers['x-actor'] as string) ?? 'unknown';
  await setFlag(req.params.key, updated, actor, existing);
  res.json(updated);
});

// GET /audit — query the audit log
app.get('/audit', async (req: Request, res: Response) => {
  const { flagKey, since } = req.query;
  const entries = await redis.xRange(AUDIT_STREAM, since ? `(${since}` : '-', '+', { COUNT: 100 });
  const filtered = flagKey
    ? entries.filter(e => e.message['flagKey'] === flagKey)
    : entries;
  res.json(filtered.map(e => ({ id: e.id, ...e.message })));
});

// POST /flags/seed — load initial flags from initial-flags.json
app.post('/flags/seed', async (_req: Request, res: Response) => {
  const flagsPath = join(__dirname, '..', 'flags', 'initial-flags.json');
  const flags: Flag[] = JSON.parse(readFileSync(flagsPath, 'utf-8'));
  for (const flag of flags) {
    await setFlag(flag.key, flag, 'seed', null);
  }
  console.log(`[MGMT] Seeded ${flags.length} flags`);
  res.json({ seeded: flags.length });
});

const port = parseInt(process.env.PORT ?? '3001');
app.listen(port, async () => {
  // Auto-seed on startup if Redis has no flags
  const count = await redis.hLen(FLAGS_KEY);
  if (count === 0) {
    const flagsPath = join(__dirname, '..', 'flags', 'initial-flags.json');
    const flags: Flag[] = JSON.parse(readFileSync(flagsPath, 'utf-8'));
    for (const flag of flags) {
      await setFlag(flag.key, flag, 'auto-seed', null);
    }
    console.log(`[MGMT] Auto-seeded ${flags.length} flags on startup`);
  }
  console.log(`[MGMT] Management API listening on port ${port}`);
});

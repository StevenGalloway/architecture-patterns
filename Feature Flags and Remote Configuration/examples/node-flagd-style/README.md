# Feature Flags Example — node-flagd-style

A minimal working implementation of the local-evaluation feature flag model described in this pattern. Two Node.js services communicate through a flag management API backed by Redis. Flag changes propagate to all connected SDK instances via SSE within 5 seconds.

## What this demonstrates

- **In-process SDK with local cache** — `FlagClient` seeds its cache at startup and evaluates flags without network calls
- **SSE-based sync** — the management API pushes flag updates to all connected SDK instances in real time
- **Targeting engine** — percentage rollout (hash-based, sticky), tenant override, explicit user override
- **Kill switch** — disable a flag via a single API call; all connected instances update within the SSE SLO
- **Structured evaluation logging** — each flag evaluation emits a log line with flag key, variant, and matched rule
- **Audit log** — every flag change is recorded with actor, timestamp, and before/after diff

## Seed flags

Three flags are loaded on startup:

| Key | Type | Default | Rule |
|-----|------|---------|------|
| `checkout-v2` | release | `false` | 10% of users get `true` (hash-based) |
| `max-upload-size-mb` | ops | `10` | No rules — value tunable at runtime |
| `new-search-algorithm` | ops | `true` | No rules — kill switch (set to `false` to disable) |

## Prerequisites

- Docker and Docker Compose
- Node 20+ (only needed if running outside Docker)

## How to run

```bash
cd examples/node-flagd-style
docker compose up --build
```

Services start on:
- Management API: http://localhost:3001
- Demo App: http://localhost:3000

On first start, the management API seeds Redis with the flags from `flags/initial-flags.json`.

## Endpoints to try

### Demo App (port 3000)

```bash
# Evaluate checkout-v2 for a user (try different userIds to see ~10% get true)
curl "http://localhost:3000/checkout?userId=user-123"
curl "http://localhost:3000/checkout?userId=user-456"
curl "http://localhost:3000/checkout?userId=user-789"

# Evaluate the search kill switch
curl "http://localhost:3000/search?userId=user-123"

# Get remote config value
curl "http://localhost:3000/config/max-upload-size"
```

### Management API (port 3001)

```bash
# View all flags
curl http://localhost:3001/flags

# View the audit log for checkout-v2
curl "http://localhost:3001/audit?flagKey=checkout-v2"

# Ramp checkout-v2 from 10% to 50%
curl -X PUT http://localhost:3001/flags/checkout-v2 \
  -H "Content-Type: application/json" \
  -d '{"rules": [{"type": "percentage", "percentage": 50, "value": true}]}'

# Fire the kill switch — disable new-search-algorithm
curl -X PUT http://localhost:3001/flags/new-search-algorithm \
  -H "Content-Type: application/json" \
  -d '{"defaultValue": false}'

# Update remote config — change max upload size
curl -X PUT http://localhost:3001/flags/max-upload-size-mb \
  -H "Content-Type: application/json" \
  -d '{"defaultValue": 25}'
```

## What to observe

**Kill switch firing:** After calling the kill switch `PUT` above, watch the demo-app container logs. Within 5 seconds you should see:
```
[FlagSDK] SSE event received: flag:new-search-algorithm updated
[FlagSDK] Cache updated for key: new-search-algorithm
```
Subsequent calls to `/search` will return `{ "variant": false }` even though the app has not restarted.

**SSE sync:** The management API logs each SSE push. The demo-app logs each cache update. The time between these two log lines is the sync lag — should be well under 1 second locally.

**Evaluation logs:** Every `/checkout` call produces a log line like:
```
[EVAL] { flagKey: "checkout-v2", variant: false, ruleMatched: "global-default", userId: "user-123" }
```

**Percentage stickiness:** The same `userId` always gets the same variant. Try:
```bash
for i in {1..5}; do curl -s "http://localhost:3000/checkout?userId=user-sticky-test"; done
```
All 5 responses will have the same `variant` value.

## Project structure

```
node-flagd-style/
  README.md
  docker-compose.yml
  flags/
    initial-flags.json       — seed flag definitions
  src/
    targeting-engine.ts      — pure rule evaluation function
    flag-client.ts           — FlagClient: cache, SSE, evaluate()
    management-api.ts        — Express: flag CRUD, SSE push, audit log
    demo-app.ts              — Example service using FlagClient
  tsconfig.json
  package.json
```

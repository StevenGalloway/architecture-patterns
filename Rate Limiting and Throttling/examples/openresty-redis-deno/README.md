# Rate Limiting + Throttling Example (OpenResty + Redis + Deno)

## What it demonstrates
Edge proxy enforces:
1) **Per-IP token bucket** (burst-friendly; in-memory per edge instance)
2) **Per-API-key daily quota** (global across edges via Redis)

Requests are proxied to a backend service when allowed.

## Run
```bash
cd infra
docker compose up --build
```

## Try it
Call without API key (should be 401):
```bash
curl -i http://localhost:9300/api/data
```

Call with API key:
```bash
curl -i -H "X-API-Key: demo-key" http://localhost:9300/api/data
```

Hammer requests to trigger token bucket (per-IP):
```bash
for i in {1..50}; do curl -s -o /dev/null -w "%{http_code}\n" -H "X-API-Key: demo-key" http://localhost:9300/api/data; done
```

To trigger quota, lower QUOTA_PER_DAY in `edge/nginx.conf` or loop enough times.

## Notes
- Token bucket here is **per edge instance** (local). Use Redis for global token bucket if needed.
- Quota is **global** (Redis) and enforces fairness across instances.
- Production gateways commonly add:
  - tier lookup (API key → plan)
  - route-specific policies
  - burst vs sustained shaping
  - WAF integration and bot detection

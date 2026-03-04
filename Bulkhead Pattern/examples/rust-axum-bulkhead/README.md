# Bulkhead Example (Rust + Axum + Tokio)

## What it demonstrates
- Separate bulkheads for two downstream dependencies:
  - **fast**: higher concurrency limit
  - **slow**: low concurrency limit to contain blast radius
- Fail-fast when a bulkhead is saturated, preserving capacity for other endpoints
- Timeouts prevent long-held permits

## Run with docker compose
```bash
cd infra
docker compose up --build
```

## Try it
Fast calls (should stay responsive):
```bash
curl http://localhost:9200/call/fast
```

Slow calls (will saturate quickly, then reject):
```bash
for i in {1..20}; do curl -s http://localhost:9200/call/slow & done; wait
```

Check bulkhead status:
```bash
curl http://localhost:9200/status
```

Downstreams:
```bash
curl http://localhost:9201/fast
curl http://localhost:9202/slow
```

## Notes
This is an in-process bulkhead. In enterprise deployments you may combine this with:
- separate connection pools per dependency
- per-tenant bulkheads for noisy-neighbor protection
- circuit breakers for prolonged downstream outages

# Distributed Cache Invalidation Example (Node.js + Express + Redis + NATS + Postgres)

## Architecture
- Two API instances: `api-a` and `api-b`
- Each has an L1 in-memory cache (short TTL)
- Shared L2 Redis cache (longer TTL)
- Writes publish invalidation events on NATS subject: `cache.invalidate`

## Run
```bash
cd infra
docker compose up --build
```

## Try it
Get item 1 (cache warm):
```bash
curl -s http://localhost:9600/items/1 | jq .
curl -s http://localhost:9601/items/1 | jq .
```

Update item 1 via api-a (publishes invalidation):
```bash
curl -s -X PUT "http://localhost:9600/items/1?value=updated" | jq .
```

Immediately read via api-b (should be fresh; caches were invalidated):
```bash
curl -s http://localhost:9601/items/1 | jq .
```

Inspect cache headers:
- `X-Cache: L1-HIT | L2-HIT | MISS`
- `X-Instance: api-a | api-b`

## Notes
- This uses basic Pub/Sub (not durable). For stronger guarantees, consider Outbox + CDC and a durable broker (Kafka/NATS JetStream).
- TTLs act as a safety net if an invalidation is missed.

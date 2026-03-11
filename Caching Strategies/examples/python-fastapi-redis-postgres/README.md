# Caching Strategies Example (FastAPI + Redis + Postgres)

## Demonstrates
- Cache-aside reads for `GET /products/{id}`
- Negative caching for not-found results (short TTL)
- SWR + distributed lock to avoid stampedes on hot keys

## Run
```bash
cd infra
docker compose up --build
```

## Test
Warm the cache:
```bash
curl -s http://localhost:9500/products/1
```

Hammer to observe stable latency:
```bash
for i in {1..30}; do curl -s -o /dev/null -w "%{http_code} %{time_total}\n" http://localhost:9500/products/1; done
```

Negative cache (not found):
```bash
curl -i http://localhost:9500/products/9999
```

Update origin + invalidate cache:
```bash
curl -s -X POST "http://localhost:9500/admin/products/1/price?price=42.00"
```

# API Gateway Example (Node/Express)

## What this demonstrates
- Routes:
  - /api/users/* -> users-service
  - /api/orders/* -> orders-service
  - /api/summary -> simple aggregation (calls both services)
- JWT validation (demo only)
- Token-bucket rate limiting (in-memory demo)
- Request-ID propagation
- Basic upstream proxying

## Run
From this directory:
1) docker compose up --build
2) Call endpoints:

Users:
- curl -H "Authorization: Bearer demo" http://localhost:8080/api/users/me

Orders:
- curl -H "Authorization: Bearer demo" http://localhost:8080/api/orders/list

Aggregated:
- curl -H "Authorization: Bearer demo" http://localhost:8080/api/summary

## Notes
- This is intentionally lightweight for portfolio clarity.
- For distributed rate limiting, swap in Redis.

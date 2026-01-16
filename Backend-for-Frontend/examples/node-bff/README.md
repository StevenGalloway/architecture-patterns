# BFF Example (Node/Express)

## What this demonstrates
- Two BFFs:
  - Mobile BFF: /mobile/home (small payload, fewer fields)
  - Web BFF: /web/home (richer payload)
- Shared domain services:
  - Profile Service
  - Catalog Service
  - Recommendations Service
- Simple resilience:
  - Recs call has a timeout; BFF returns partial response if it fails
- Request ID propagation

## Run
From this directory:
1) docker compose up --build
2) Call endpoints:

Mobile:
- curl http://localhost:8081/mobile/home

Web:
- curl http://localhost:8082/web/home

Optional: simulate recs slowness:
- curl "http://localhost:3003/toggle?slow=true"

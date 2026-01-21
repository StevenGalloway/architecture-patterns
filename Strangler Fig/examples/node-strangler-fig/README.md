# Strangler Fig Example (Node/Express)

## What this demonstrates
- **Edge Router** routes most traffic to the legacy monolith
- Routes **/billing/** to the new Billing Service using a canary percentage split (demo)
- Shows how you can progressively shift traffic without rewriting everything

## Run
```bash
docker compose up --build
```

## Try it
Legacy endpoint:
- `curl http://localhost:8080/legacy/ping`

Billing endpoint (routed):
- `curl -X POST http://localhost:8080/billing/pay -H "Content-Type: application/json" -d '{"amount": 25.00}'`

Change canary percent (restart with env var):
- `CANARY_PERCENT=25 docker compose up --build`

## Notes
This is a teaching demo:
- Canary routing uses random sampling
- Production canaries are usually tenant/header-based with SLO gates and instant rollback

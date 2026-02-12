# Saga Example (Go + RabbitMQ + BoltDB)

## What this demonstrates
- Orchestrated saga coordinating Payment, Inventory, Shipping
- Durable saga state and dedupe via BoltDB
- Compensation flow when a step fails
- Correlation IDs and message IDs for traceability

## Run
```bash
docker compose up --build
```

## Start a saga
```bash
curl -X POST http://localhost:8080/orders -H "Content-Type: application/json" -d '{"order_id":"o-100","user_id":"u-1","amount":25.00}'
```

## Simulate a failure
Set `FAIL_INVENTORY=true` for the inventory service (already supported via env var in compose), then start a saga.
The orchestrator will trigger compensations.

## Notes
This is a teaching example:
- Services use in-memory “local state”
- Production typically uses persistent local DBs, DLQs, and richer retry/backoff policies

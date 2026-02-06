# Event Sourcing Example (Python + FastAPI + SQLite)

## Components
- **command-api** (8001): command endpoints for Account aggregate (open, deposit, withdraw)
- **projector** (worker): tails the event store and builds a read model + timeline + cursor
- **query-api** (8002): reads from the read model (account balance + timeline)
- Shared SQLite via docker volume:
  - `event_store.db` (append-only)
  - `read_model.db` (projection)

## Run
```bash
docker compose up --build
```

## Try it
Open an account (expected_version=0):
```bash
curl -X POST http://localhost:8001/accounts/a-1/open -H "Content-Type: application/json" -d '{"owner":"steven","expected_version":0}'
```

Deposit (expected_version=1 after open):
```bash
curl -X POST http://localhost:8001/accounts/a-1/deposit -H "Content-Type: application/json" -d '{"amount":25.0,"expected_version":1}'
```

Withdraw (expected_version=2 after deposit):
```bash
curl -X POST http://localhost:8001/accounts/a-1/withdraw -H "Content-Type: application/json" -d '{"amount":10.0,"expected_version":2}'
```

Query (eventually consistent until projector applies):
```bash
curl http://localhost:8002/accounts/a-1
curl http://localhost:8002/accounts/a-1/timeline
```

Metrics:
```bash
curl http://localhost:8002/metrics
```

# CQRS + Read Model Projection Example (Node)

## Components
- **command-service** (3001): accepts `POST /orders`, writes to an in-memory write store, publishes `OrderCreated`
- **event-bus-mock** (4000): minimal event bus with:
  - `POST /publish`
  - `GET /subscribe` (SSE stream)
- **projector** (3002): subscribes to bus, builds read model, exposes read store endpoints
- **query-service** (3003): serves queries from the read model

## Run
```bash
docker compose up --build
```

## Try it
Create an order (write path):
```bash
curl -X POST http://localhost:3001/orders -H "Content-Type: application/json" -d '{"order_id":"o-1","user_id":"u-1","total":25.00}'
```

Query it (read path):
```bash
curl http://localhost:3003/orders/o-1
```

List orders for a user:
```bash
curl "http://localhost:3003/users/u-1/orders"
```

## Observe eventual consistency
If you hammer query immediately after command, you may see a short delay until the projector applies the event.

# Idempotent Consumer Example (.NET 8 + RabbitMQ + Redis)

## What it demonstrates
- Producer publishes messages with stable `message_id`
- Consumer dedupes using Redis `SET NX` before applying a side effect
- Duplicate deliveries are safely skipped

## Run infra
```bash
cd infra
docker compose up -d
```

## Run producer (publish 10 messages; with duplicates)
```bash
cd ../producer
dotnet run
```

## Run consumer
```bash
cd ../consumer
dotnet run
```

## Observe
- RabbitMQ management UI: http://localhost:15672 (guest/guest)
- Consumer logs show `DUPLICATE` when the same `message_id` is re-delivered

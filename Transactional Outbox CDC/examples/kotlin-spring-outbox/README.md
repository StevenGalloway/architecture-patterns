# Transactional Outbox + CDC Example (Kotlin/Spring + Postgres + Debezium + Kafka)

## Included
- `infra/` docker-compose for Postgres, Kafka, Kafka Connect (Debezium), Kafka UI
- `outbox-producer/` Kotlin/Spring Boot service that writes Orders + outbox in the same TX
- `consumer/` Kotlin consumer that processes outbox topic idempotently

## Run infra
```bash
cd infra
docker compose up -d
```

## Register connector
Requires `jq`.
```bash
./register-connector.sh
```

## Run producer
```bash
cd ../outbox-producer
./gradlew bootRun
```

Create an order:
```bash
curl -X POST http://localhost:9001/orders -H "Content-Type: application/json" -d '{"orderId":"o-1","userId":"u-1","amount":25.0}'
```

## Run consumer
```bash
cd ../consumer
./gradlew run
```

## Observe
- Kafka UI: http://localhost:8080
- Topic: `app.public.outbox_events`

Note: This example uses Debezium's ExtractNewRecordState SMT to flatten change events to row JSON. In production, many teams use the Debezium Outbox Event Router SMT for routing by event_type and custom keys.

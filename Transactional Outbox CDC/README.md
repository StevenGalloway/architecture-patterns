# Transactional Outbox + CDC (Change Data Capture) Pattern

## Summary
The **Transactional Outbox** pattern guarantees reliable event publication **without dual-writes** by recording outbound events in an **outbox table** in the *same database transaction* as the business state change.

**CDC (Change Data Capture)** (e.g., Debezium) streams outbox inserts/updates from the database transaction log into a message broker (Kafka). Downstream services consume from Kafka and react.

This pattern is a pragmatic, production-grade alternative to:
- “update DB then publish event” (can lose events)
- “publish event then update DB” (can publish incorrect events)
- distributed transactions / 2PC (complex and slow)

## Problem
In microservices you often need to:
1) update local state (e.g., create Order) and
2) publish an integration event (e.g., `OrderCreated`).

If these are separate steps, failures create inconsistencies.

## Solution
- Write business state + outbox row **in one DB transaction**
- Use Debezium CDC to publish outbox changes to Kafka
- Consumers process events idempotently (dedupe by `event_id`)

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-tx-outbox-sequence.mmd`
- `diagrams/03-cdc-pipeline-and-ops.mmd`

## ADRs
- `adrs/ADR-001-adopt-transactional-outbox-cdc.md`
- `adrs/ADR-002-outbox-schema-and-event-contract.md`
- `adrs/ADR-003-cdc-connector-and-topic-layout.md`
- `adrs/ADR-004-consumer-idempotency-and-ordering.md`
- `adrs/ADR-005-retention-replay-and-observability.md`

## Example Tech
**PostgreSQL + Kafka + Debezium + Kotlin/Spring Boot**:
- `outbox-producer`: creates Orders and writes to `outbox_events` in same TX
- `consumer`: consumes outbox topic and performs idempotent processing
- `infra`: docker-compose for Postgres, Kafka, Kafka Connect (Debezium), Kafka UI

See `examples/kotlin-spring-outbox/`.

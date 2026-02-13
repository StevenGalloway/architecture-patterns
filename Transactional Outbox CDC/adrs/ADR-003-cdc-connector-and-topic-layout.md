# ADR-003: Use Debezium Postgres connector and partition by aggregate_id

## Status
Accepted

## Date
2026-01-11

## Context
We need scalable delivery and ordering per aggregate where applicable.

## Decision
- Debezium Postgres connector reads logical replication stream
- Publish outbox rows to Kafka
- Use `aggregate_id` as the record key to preserve ordering per aggregate (partitioning)

## Consequences
- Ordering within an aggregate is maintained per partition
- Requires careful selection of partition keys and topic naming conventions

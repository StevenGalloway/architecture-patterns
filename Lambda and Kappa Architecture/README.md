# Lambda vs Kappa Architecture Pattern (Streaming Data Processing)

## Summary
**Lambda Architecture** and **Kappa Architecture** are patterns for building analytics systems that handle both:
- **real-time/near-real-time** processing (low latency)
- **historical reprocessing** (correctness, backfills, bug fixes)

### Lambda Architecture (classic)
- **Batch layer** builds immutable master dataset and batch views
- **Speed layer** provides low-latency updates
- **Serving layer** merges batch + speed results

### Kappa Architecture (modern default for many orgs)
- Single **stream processing** pipeline
- **Reprocessing** happens by replaying the stream or re-running with corrected logic
- Simplifies architecture by removing separate batch layer

---

## Problem
Business needs both low-latency insights and accurate historical views:
- streaming dashboards, anomaly detection, near-real-time aggregates
- late-arriving data corrections
- schema evolution and logic changes
- backfills for missed data windows

---

## Forces & Constraints
- “Two pipelines” (Lambda) can drift and increase maintenance
- Kappa requires robust event retention/replay, or durable log storage
- Exactly-once and correctness guarantees are hard; idempotence helps
- Schema evolution and compatibility rules are mandatory
- Serving stores must support fast reads (OLAP/Trino/ClickHouse/Druid, etc.)

---

## Solution
### Choose Lambda when:
- Batch processing is unavoidable (very large historical datasets where streaming replay is too expensive)
- Tooling constraints require separate batch/speed paths
- You need distinct compute isolation and schedules

### Choose Kappa when:
- Your events are retained long enough to support replay/backfill
- You want one compute model and one codebase for transformations
- Streaming frameworks can handle your workload and semantics

---

## Common Design Elements
- **Immutable event log** (Kafka/Pulsar/Kinesis)
- **Stream processing** (Flink/Spark Structured Streaming/Beam)
- **Lakehouse storage** (Iceberg/Delta/Hudi) for append + updates
- **Serving/query layer** (Trino/Presto/ClickHouse/Druid)
- **Contracts**: schemas (Avro/Protobuf/JSON Schema) + compatibility
- **Observability**: lag, throughput, checkpoint health, late data rates

---

## Diagrams
- `diagrams/01-lambda-vs-kappa.mmd`
- `diagrams/02-kappa-replay-and-backfill.mmd`
- `diagrams/03-lakehouse-serving.mmd`

---

## ADRs
- `adrs/ADR-001-default-to-kappa.md`
- `adrs/ADR-002-use-iceberg-for-lakehouse.md`
- `adrs/ADR-003-replay-and-backfill-strategy.md`
- `adrs/ADR-004-schema-evolution-and-compatibility.md`
- `adrs/ADR-005-operational-slos-and-runbooks.md`

---

## Runnable Example (New Tech)
This example uses a modern Kappa-style stack:
- **Kafka** as the immutable event log
- **Apache Flink** (SQL) for streaming transforms & aggregates
- **Apache Iceberg** as the lakehouse table format
- **Trino** for serving/querying aggregates

Folder: `examples/local-kappa-kafka-flink-iceberg-trino/`

> Note: This is a heavy-ish local stack, but it’s “impressive recruiter + enterprise architect” material and maps cleanly to real production architectures.

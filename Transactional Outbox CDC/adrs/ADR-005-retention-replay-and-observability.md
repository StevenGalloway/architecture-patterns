# ADR-005: Define retention, replay, and observability requirements

## Status
Accepted

## Date
2026-01-11

## Context
Operational excellence requires visibility into pipeline health and the ability to recover or rebuild downstream views.

## Decision
- Outbox retention (e.g., 7–30 days) with partitioning/archiving
- Kafka retention sized for replay needs
- Metrics: CDC lag, consumer lag, DLQ rates
- Runbooks: connector restart, replay from offsets, outbox cleanup

## Consequences
- Reliable operations and recovery
- Requires monitoring and capacity planning

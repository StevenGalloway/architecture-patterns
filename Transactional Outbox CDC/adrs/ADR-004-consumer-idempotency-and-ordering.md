# ADR-004: Consumers implement idempotency under at-least-once delivery

## Status
Accepted

## Date
2026-01-11

## Context
CDC + Kafka is generally at-least-once; duplicates can occur. Consumers must avoid double-applying side effects.

## Decision
- Maintain a `processed_events` table keyed by `event_id`
- Apply side effects only if not processed
- Use retries with backoff and a DLQ for poison events

## Consequences
- Safe processing under duplicates/retries
- Adds state and operational concerns to consumers

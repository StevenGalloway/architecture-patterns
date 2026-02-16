# ADR-002: Standardize the outbox schema and event contract

## Status
Accepted

## Date
2026-01-11

## Context
Outbox rows are the source of truth for integration events. A consistent schema enables tooling and consumer compatibility.

## Decision
Outbox table fields:
- `event_id` (UUID, unique)
- `event_type`
- `aggregate_type`, `aggregate_id`
- `occurred_at`
- `payload` (JSONB)
- optional `headers`, `trace_id`, `correlation_id`

Payloads are versioned and backward-compatible where feasible.

## Consequences
- Predictable event shape for consumers
- Requires governance and contract tests for changes

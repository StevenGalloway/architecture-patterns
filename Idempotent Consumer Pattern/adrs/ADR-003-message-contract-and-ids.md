# ADR-003: Standardize message contracts with stable message identifiers

## Status
Accepted

## Date
2026-01-11

## Context
Idempotency fails if the message identifier changes on retries or resends.

## Decision
Message schema includes:
- `message_id` (UUID, stable across retries)
- `type`, `occurred_at`, `correlation_id`
- `payload` (versioned)

Validate `message_id` presence/format at consumer boundaries.

## Consequences
- predictable idempotency behavior
- requires schema governance and contract testing

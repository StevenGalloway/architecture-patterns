# ADR-003: Projector must be idempotent and tolerate out-of-order delivery

## Status
Accepted

## Date
2026-01-11

## Context
Most messaging/eventing systems provide at-least-once delivery. Duplicates and reordering can occur.

## Decision
- Use `event_id` as the idempotency key
- Maintain a processed-events store (or watermark per aggregate) for dedupe
- Upserts must be safe to reapply
- Track ordering per aggregate when required (sequence numbers)

## Consequences
- Eliminates duplicate side effects in read models
- Adds state and operational considerations for dedupe storage

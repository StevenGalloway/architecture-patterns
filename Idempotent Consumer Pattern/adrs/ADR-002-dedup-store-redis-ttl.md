# ADR-002: Use Redis SETNX with TTL as the deduplication store

## Status
Accepted

## Date
2026-01-11

## Context
We need an atomic, low-latency way to record processed message IDs across multiple consumer instances.

## Decision
Use Redis:
- `SET processed:<message_id> 1 NX EX <ttl>`
- TTL sized to the maximum replay/redelivery window (e.g., hours to days)
- For high-stakes operations, consider durable DB inbox tables

## Consequences
- fast dedupe and simple scaling
- Redis availability impacts processing; monitor and alert

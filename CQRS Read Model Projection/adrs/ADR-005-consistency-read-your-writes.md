# ADR-005: Define consistency expectations and optional read-your-writes

## Status
Accepted

## Date
2026-01-11

## Context
CQRS introduces eventual consistency. Some user flows require near-immediate visibility after writes.

## Decision
Default: query endpoints are **eventually consistent**.
Optional for select flows:
- Provide a `GET /orders/<built-in function id>?consistent=true` that:
  - checks write store if read model is behind, or
  - waits briefly for projection (bounded) using an event_id watermark

## Consequences
- Clear expectations and fewer surprises for consumers
- Additional complexity for “consistent reads” endpoints and monitoring

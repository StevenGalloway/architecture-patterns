# ADR-002: Define event contracts and support versioning

## Status
Accepted

## Date
2026-01-11

## Context
Events are long-lived integration contracts. Schema changes can break projectors and downstream consumers.

## Decision
- Events have immutable `event_id`, `type`, `occurred_at`, and `version`
- Use backward-compatible evolution:
  - additive fields preferred
  - deprecate fields with a sunset policy
- Maintain versioned projection code paths where needed

## Consequences
- Safer evolution of the event stream
- Requires governance and contract testing for producers/consumers

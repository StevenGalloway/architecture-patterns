# ADR-001: Default to Kappa architecture for streaming analytics

## Status
Accepted

## Date
2026-01-11

## Context
Maintaining separate batch and speed pipelines increases cost and drift risk.

## Decision
Prefer **Kappa** (single streaming pipeline) when event retention and replay are feasible. Use Lambda only when batch isolation is required or replay costs are prohibitive.

## Consequences
- simpler architecture and one code path
- requires durable event retention and replay/runbooks

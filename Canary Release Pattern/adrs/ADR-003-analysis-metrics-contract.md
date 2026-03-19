# ADR-003: Define a minimal analysis contract and SLO thresholds

## Status
Accepted

## Date
2026-01-11

## Context
Rollout decisions are only as good as the metrics used. False positives cause unnecessary rollbacks; false negatives cause incidents.

## Decision
For each service define:
- error-rate threshold (e.g., < 2%)
- latency threshold (e.g., p95 < 300ms)
- saturation guardrails (CPU/mem/pool usage)
and document them as an analysis contract.

## Consequences
- repeatable and auditable rollout criteria
- requires ongoing tuning as usage changes

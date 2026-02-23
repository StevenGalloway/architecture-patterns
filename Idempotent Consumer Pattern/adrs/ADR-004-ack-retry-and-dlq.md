# ADR-004: Define ack, retry, and DLQ behavior for failures

## Status
Accepted

## Date
2026-01-11

## Context
Failures can be transient (network) or permanent (poison message). Without a strategy, messages can loop forever.

## Decision
- On transient errors: retry with backoff (limited attempts)
- On permanent errors: route to DLQ for manual triage
- Dedupe key should be cleared on processing failure if side effects were not applied

## Consequences
- prevents infinite retry loops
- requires runbooks and DLQ monitoring

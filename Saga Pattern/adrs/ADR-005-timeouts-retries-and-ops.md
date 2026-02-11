# ADR-005: Define timeouts, retries, and operational runbooks for stuck sagas

## Status
Accepted

## Date
2026-01-11

## Context
Distributed workflows can hang due to timeouts, partial outages, and poison messages.

## Decision
- Each saga step has a timeout; orchestrator retries idempotent commands
- After retry budget is exhausted:
  - move saga to FAILED state
  - emit alerts and require manual resolution
- Maintain operational metrics: lag, retries, failure counts

## Consequences
- predictable handling of stuck sagas
- requires runbooks and observability to support operations

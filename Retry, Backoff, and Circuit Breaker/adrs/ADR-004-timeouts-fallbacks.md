# ADR-004: Timeouts and fallbacks are mandatory for remote calls

## Status
Accepted

## Date
2026-01-11

## Context
Unbounded remote calls cause thread exhaustion and tail-latency blowups.

## Decision
- Enforce timeouts on all remote calls
- Provide fallbacks where business-acceptable (degraded/cached)
- If no safe fallback exists, return a clear error (503) and rely on client-level retries

## Consequences
- bounded latency and improved stability
- requires business agreement on degraded behavior

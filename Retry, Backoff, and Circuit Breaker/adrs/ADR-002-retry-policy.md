# ADR-002: Retry policy and backoff strategy

## Status
Accepted

## Date
2026-01-11

## Context
Retries can help with transient failures but can amplify load during outages.

## Decision
- Retry only transient conditions (timeouts, 429, selected 5xx)
- Cap attempts (3)
- Exponential backoff + jitter
- Prefer idempotent operations or idempotency keys

## Consequences
- better success rates without runaway retry storms
- requires careful exception mapping per client library

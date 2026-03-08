# ADR-004: Standardize client contract for throttling responses

## Status
Accepted

## Date
2026-01-11

## Context
Clients need clear signals to back off; otherwise retries can amplify incidents.

## Decision
- Return **429 Too Many Requests** on enforcement
- Include `Retry-After` and rate headers:
  - `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

## Consequences
- improved client behavior and fewer retry storms
- requires consistent implementation and documentation

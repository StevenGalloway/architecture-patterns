# ADR-001: Use Resilience4j for retries and circuit breakers

## Status
Accepted

## Date
2026-01-11

## Context
We need standardized resilience behavior with consistent configuration and Spring Boot integration.

## Decision
Adopt **Resilience4j** for:
- retry with exponential backoff + jitter
- circuit breaker
- time limiter (timeouts)

## Consequences
- consistent resilience primitives and metrics
- requires tuning and governance of defaults

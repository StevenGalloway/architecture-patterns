# ADR-003: Circuit breaker thresholds and windows

## Status
Accepted

## Date
2026-01-11

## Context
Circuit breaker settings must balance sensitivity and stability.

## Decision
- Sliding window (count-based)
- Open when failure rate >= 50% after minimum calls
- Treat slow calls >= timeout threshold as failures for breaker purposes
- HALF_OPEN allows limited trial calls

## Consequences
- fail-fast behavior protects caller resources
- requires monitoring and periodic re-tuning

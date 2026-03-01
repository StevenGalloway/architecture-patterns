# ADR-002: Implement bulkheads as per-dependency semaphores

## Status
Accepted

## Date
2026-01-11

## Context
We need a lightweight, in-process isolation mechanism that works across multiple instances and scales horizontally.

## Decision
Use **concurrency limits** implemented via semaphores:
- separate semaphore per dependency (fast vs slow)
- fail fast when permits are exhausted
- combine with strict timeouts to avoid long-held permits

## Consequences
- strong isolation with minimal overhead
- must be tuned based on downstream SLOs and capacity

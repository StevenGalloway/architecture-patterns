# ADR-001: Use Cache-Aside as default caching strategy

## Status
Accepted

## Date
2026-01-11

## Context
We need a simple, widely understood approach where the origin remains the source of truth.

## Decision
Use **Cache-Aside**:
- read cache first
- on miss, load origin and populate cache
- treat cache as optional

## Consequences
- easy to implement and reason about
- requires TTL and/or event-driven invalidation for correctness

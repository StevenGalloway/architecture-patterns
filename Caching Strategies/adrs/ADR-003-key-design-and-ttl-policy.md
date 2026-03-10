# ADR-003: Standardize key design and TTL policy (with jitter)

## Status
Accepted

## Date
2026-01-11

## Context
Inconsistent keys cause collisions, privacy risks, and invalidation gaps.

## Decision
Keys include `env:tenant:version:entity:id[:suffix]`.
TTLs:
- apply jitter to reduce synchronized expiry
- keep stale TTL > fresh TTL for SWR

## Consequences
- safer multi-tenant behavior and deploy evolution
- requires governance and shared library conventions

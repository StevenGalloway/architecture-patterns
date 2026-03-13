# ADR-002: Standardize cache key scheme with tenant safety

## Status
Accepted

## Date
2026-01-11

## Context
Multi-tenant systems risk key collisions and data leakage if tenant and version are not encoded into keys.

## Decision
Use canonical keys:
- `env:tenant:version:entity:id[:suffix]`

## Consequences
- reduces collisions and supports safe invalidation by namespace
- requires shared library/conventions across services

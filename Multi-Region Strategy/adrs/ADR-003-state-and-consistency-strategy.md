# ADR-003: Prefer stateless services; use DynamoDB Global Tables for multi-active state

## Status
Accepted

## Date
2026-01-11

## Context
Multi-region is hardest when state is tightly coupled to a single region.

## Decision
- keep services stateless where possible
- store cross-region mutable state in **DynamoDB Global Tables** when acceptable
- for strong consistency requirements, keep a single-writer primary DB (Aurora Global) and plan promotion runbooks

## Consequences
- simplified failover for most services
- requires careful data model and conflict considerations for multi-writer scenarios

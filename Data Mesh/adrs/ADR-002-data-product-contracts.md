# ADR-002: Standardize data product contracts (schema + SLOs)

## Status
Accepted

## Date
2026-01-11

## Context
Interoperability and trust require consistent documentation, ownership, and freshness guarantees.

## Decision
Each data product must publish a contract:
- schema and field semantics
- freshness/latency SLOs
- classifications (PII), retention, access policy tags
- owner + escalation path
- versioning and change policy

## Consequences
- better discoverability and safer change management
- requires a contract spec and validation in CI

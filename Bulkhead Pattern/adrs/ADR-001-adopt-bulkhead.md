# ADR-001: Adopt Bulkhead pattern for dependency isolation

## Status
Accepted

## Date
2026-01-11

## Context
A single degraded downstream can starve shared resources (threads, connections), creating cascading failures across unrelated endpoints.

## Decision
Adopt the **Bulkhead** pattern: isolate capacity per dependency/endpoint group so overload in one compartment does not collapse the entire service.

## Consequences
- preserves capacity for critical paths
- introduces tuning/operational requirements (limits, alerts)

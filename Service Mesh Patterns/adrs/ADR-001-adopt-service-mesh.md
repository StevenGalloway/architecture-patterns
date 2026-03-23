# ADR-001: Adopt a Service Mesh for east-west traffic

## Status
Accepted

## Date
2026-01-11

## Context
We run multiple microservices with growing cross-service traffic and inconsistent security/observability practices.

## Decision
Adopt a **service mesh** to standardize:
- mTLS by default
- route-level retries/timeouts
- golden-signal telemetry and dependency graphs

## Consequences
- improved security posture and operational visibility
- requires platform ownership and mesh lifecycle management

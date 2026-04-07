# ADR-002: Use Route 53 latency routing + health checks (or Global Accelerator where needed)

## Status
Accepted

## Date
2026-01-11

## Context
We need global traffic steering that can fail over reliably on regional degradation.

## Decision
Default to **Route 53 latency-based routing** with **health checks** and conservative TTLs. For very low-latency or DDoS-resilience requirements, evaluate **AWS Global Accelerator**.

## Consequences
- simple, well-understood failover mechanics
- DNS TTL introduces some failover delay; requires testing and tuning

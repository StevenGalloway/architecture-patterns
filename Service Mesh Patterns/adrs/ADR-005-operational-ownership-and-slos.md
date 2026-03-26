# ADR-005: Establish platform ownership and SLOs for the mesh

## Status
Accepted

## Date
2026-01-11

## Context
A mesh is shared infrastructure; outages or misconfigurations affect many services.

## Decision
Platform/SRE owns:
- mesh upgrades and certificate rotation
- observability dashboards and alerts
- SLOs for mesh dataplane (latency overhead, success rate)
Service teams own:
- service profiles/route definitions
- app-level SLOs and error budgets

## Consequences
- clear accountability reduces incident time-to-diagnose
- requires documentation and on-call readiness

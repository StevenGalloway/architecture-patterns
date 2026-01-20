# ADR-002: Establish a routing seam using an Edge Router

## Status
Accepted

## Date
2026-01-11

## Context
We need a clean separation point where traffic can be directed to legacy or new services without repeatedly changing clients.

## Decision
Use an **Edge Router** (gateway/reverse proxy) to:
- Route by **path** initially: `/billing/*` → New Billing Service
- Support **tenant/header-based routing** for safer canaries
- Maintain a stable external contract while internal routing evolves

## Consequences
- Enables progressive migration with minimal client changes
- Adds a critical component requiring HA, monitoring, and config governance

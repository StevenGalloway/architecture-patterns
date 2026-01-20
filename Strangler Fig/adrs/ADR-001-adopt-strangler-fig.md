# ADR-001: Adopt the Strangler Fig modernization approach

## Status
Accepted

## Date
2026-01-11

## Context
The legacy system is business critical and cannot be replaced via a big-bang rewrite without unacceptable risk. We need incremental modernization while maintaining uptime and delivering value continuously.

## Decision
Adopt the **Strangler Fig** pattern: introduce an edge routing seam and incrementally migrate functional slices to new services until the legacy system can be retired.

## Consequences
### Positive
- Incremental delivery and measurable modernization progress
- Lower migration risk with staged rollouts and rollback
- Enables modern practices alongside legacy

### Negative
- Temporary hybrid complexity (two systems)
- Requires disciplined governance to avoid “forever hybrid” architecture

# ADR-003: Data transition strategy for migrated slices

## Status
Accepted

## Date
2026-01-11

## Context
During migration, legacy and new components may operate on related data. Data consistency failures are a primary modernization risk.

## Decision
For each migrated slice, designate a **source of truth** and choose one strategy:
1. **Shared database (temporary only)** with strict interface boundaries, OR
2. **Replicated data** (CDC/outbox) into the new domain store, OR
3. **Parallel writes** only when unavoidable, paired with verification and reconciliation jobs.

## Consequences
- Forces clarity on ownership per slice
- Adds migration workload but reduces correctness risk
